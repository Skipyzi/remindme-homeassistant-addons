package backups

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

// dimensionDirs are the directory names that make up a world set.
var dimensionDirs = []string{"world", "world_nether", "world_the_end"}

type RestoreRequest struct {
	BackupID string `json:"backup_id"`
	// TargetWorldID defaults to the world the backup came from.
	TargetWorldID string `json:"target_world_id"`
	// SkipSafetyBackup skips backing up the current world first. Off by default,
	// because a restore without it is unrecoverable.
	SkipSafetyBackup bool `json:"skip_safety_backup"`
	// Restart controls whether Minecraft is started afterwards; the default is to
	// restore whatever state the server was in.
	Restart *bool `json:"restart"`
}

type RestoreResult struct {
	BackupID     string `json:"backup_id"`
	WorldID      string `json:"world_id"`
	SafetyBackup string `json:"safety_backup_id"`
	Started      bool   `json:"started"`
	RolledBack   bool   `json:"rolled_back"`
	DurationMs   int64  `json:"duration_ms"`
	Message      string `json:"message"`
}

// Restore puts a backup back on disk.
//
// The world is only replaced once the restored copy has been verified in a staging
// directory, and the previous copy is kept aside until the server has started
// successfully. A restore can therefore fail at any step without destroying the
// world that was there before.
func (m *Manager) Restore(ctx context.Context, req RestoreRequest, actor string) (RestoreResult, error) {
	started := time.Now()
	result := RestoreResult{BackupID: req.BackupID}

	record, ok, err := m.deps.Store.GetBackup(req.BackupID)
	if err != nil {
		return result, err
	}
	if !ok {
		return result, fmt.Errorf("%w: %s", ErrNotFound, req.BackupID)
	}
	if record.SnapshotID == "" {
		return result, errors.New("this backup has no snapshot in the repository")
	}
	worldID := req.TargetWorldID
	if worldID == "" {
		worldID = record.WorldID
	}
	if worldID == "" {
		return result, errors.New("no target world")
	}
	result.WorldID = worldID
	worldDir, err := m.deps.WorldDir(worldID)
	if err != nil {
		return result, err
	}

	lease, err := m.deps.Supervisor.Acquire(supervisor.ActivityRestore)
	if err != nil {
		return result, err
	}
	defer m.deps.Supervisor.Release(lease)

	opCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := m.beginOperation(&operation{
		ID: record.ID, Kind: "restore", StartedAt: time.Now(), cancel: cancel, cancelSafe: true,
		description: "restoring " + worldID,
	}); err != nil {
		return result, err
	}
	defer m.endOperation()

	journalID, _ := m.deps.Store.JournalBegin(store.OpRestore, "verify", map[string]any{
		"backup": record.ID, "snapshot": record.SnapshotID, "world": worldID, "actor": actor,
	})
	failed := func(err error) (RestoreResult, error) {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "backup.restore",
			Target: worldID, Detail: err.Error(), Result: "error"})
		m.deps.Bus.Fail("backups", "restore failed: "+err.Error())
		result.DurationMs = time.Since(started).Milliseconds()
		return result, err
	}

	// 1. Verify the snapshot is readable before touching anything.
	m.publishProgress("restore", record.ID, 2, "verifying backup")
	if _, err := m.deps.Restic.ListFiles(opCtx, record.SnapshotID, 1); err != nil {
		return failed(fmt.Errorf("backup cannot be read: %w", err))
	}

	wasRunning := m.deps.Supervisor.IsRunning() || m.deps.Supervisor.State() == supervisor.StateStarting
	shouldStart := wasRunning
	if req.Restart != nil {
		shouldStart = *req.Restart
	}

	// 2. Stop Minecraft: a restore never runs against a live world.
	if wasRunning {
		m.publishProgress("restore", record.ID, 5, "stopping Minecraft")
		if err := m.deps.Supervisor.Stop(opCtx, supervisor.StopOptions{Reason: "restore " + record.ID}); err != nil {
			return failed(fmt.Errorf("could not stop Minecraft: %w", err))
		}
	}

	// 3. Safety backup of what is on disk right now.
	if !req.SkipSafetyBackup {
		if _, err := os.Stat(worldDir); err == nil {
			m.publishProgress("restore", record.ID, 8, "backing up the current world")
			safety, err := m.Create(opCtx, CreateRequest{
				WorldID: worldID, Kind: "pre_restore",
				Label: "before restoring " + shortID(record.SnapshotID),
			}, actor, lease)
			if err != nil {
				return failed(fmt.Errorf("safety backup failed, restore aborted: %w", err))
			}
			result.SafetyBackup = safety.ID
			_ = m.deps.Store.JournalPhase(journalID, "safety_backup", map[string]any{"record": safety.ID})
		}
	} else {
		m.deps.Bus.Warn("backups", "restoring without a safety backup at the operator's request")
	}

	// 4. Restore into staging.
	staging := filepath.Join(m.deps.Paths.Staging(), "restore-"+newID("r"))
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return failed(err)
	}
	defer os.RemoveAll(staging)
	_ = m.deps.Store.JournalPhase(journalID, "restore_staging", map[string]any{"staging": staging})

	m.publishProgress("restore", record.ID, 15, "extracting backup")
	if err := m.deps.Restic.Restore(opCtx, record.SnapshotID, staging, func(p Progress) {
		m.publishProgress("restore", record.ID, 15+p.PercentDone*0.6, humanBytes(p.BytesDone))
	}); err != nil {
		return failed(err)
	}

	// 5. Validate the restored copy.
	m.publishProgress("restore", record.ID, 78, "validating restored world")
	restoredRoot, err := locateWorldSet(staging)
	if err != nil {
		return failed(err)
	}
	if err := validateWorldSet(restoredRoot); err != nil {
		return failed(err)
	}

	// 6. Swap it in. From here a cancel would leave the world half-replaced, so
	// cancellation is refused until the swap and the health check are done.
	m.setCancelSafe(false)
	_ = m.deps.Store.JournalPhase(journalID, "swap", map[string]any{"restored_root": restoredRoot})
	m.publishProgress("restore", record.ID, 82, "replacing world data")
	aside, err := atomicfs.ReplaceDir(restoredRoot, worldDir)
	if err != nil {
		return failed(err)
	}
	_ = m.deps.Store.JournalPhase(journalID, "verify_start", map[string]any{"aside": aside})

	// 7. Start and verify, rolling back on failure.
	if shouldStart {
		m.publishProgress("restore", record.ID, 88, "starting Minecraft")
		startErr := m.deps.Supervisor.Start()
		if startErr == nil {
			readyCtx, cancelReady := context.WithTimeout(ctx, m.deps.StartTimeout)
			startErr = m.deps.Supervisor.WaitReady(readyCtx)
			cancelReady()
		}
		if startErr != nil {
			m.deps.Bus.Fail("backups", "the restored world did not start; rolling back")
			m.rollbackRestore(ctx, journalID, aside, worldDir, wasRunning)
			result.RolledBack = true
			return failed(fmt.Errorf("the restored world failed to start (%w); the previous world was put back", startErr))
		}
		result.Started = true
	}

	if aside != "" {
		if err := os.RemoveAll(aside); err != nil {
			m.log.Warn("could not remove the previous world copy", "path", aside, "error", err)
		}
	}
	_ = m.deps.Store.JournalEnd(journalID, store.JournalDone, "")
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "backup.restore", Target: worldID,
		Detail: fmt.Sprintf("snapshot=%s safety_backup=%s started=%t",
			shortID(record.SnapshotID), result.SafetyBackup, result.Started)})

	if m.deps.Invalidate != nil {
		m.deps.Invalidate("world:"+worldID, worldDir)
	}
	m.publishProgress("restore", record.ID, 100, "complete")
	m.deps.Bus.Publish(events.TypeWorldsChanged, map[string]any{"restored": worldID})
	result.DurationMs = time.Since(started).Milliseconds()
	result.Message = "restore complete"
	return result, nil
}

// rollbackRestore puts the pre-restore world back and restarts if the server had
// been running.
func (m *Manager) rollbackRestore(ctx context.Context, journalID int64, aside, worldDir string, wasRunning bool) {
	_ = m.deps.Store.JournalPhase(journalID, "rollback", nil)
	if m.deps.Supervisor.IsRunning() || m.deps.Supervisor.State() == supervisor.StateStarting {
		_ = m.deps.Supervisor.Stop(ctx, supervisor.StopOptions{Reason: "restore rollback"})
	}
	if aside == "" {
		m.deps.Bus.Fail("backups",
			"rollback is not possible: there was no previous world to restore. The restored data is still in place.")
		return
	}
	if err := atomicfs.RestoreAside(aside, worldDir); err != nil {
		m.deps.Bus.Fail("backups", "rollback failed: "+err.Error()+
			" - the previous world is still on disk next to the world directory")
		_ = m.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "backup.rollback",
			Target: worldDir, Detail: err.Error(), Result: "error"})
		return
	}
	if wasRunning {
		if err := m.deps.Supervisor.Start(); err != nil {
			m.deps.Bus.Fail("backups", "rollback restored the world but Minecraft did not start: "+err.Error())
		}
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "backup.rollback",
		Target: worldDir, Detail: "restored the pre-restore world"})
}

// locateWorldSet finds the world root inside a restic restore target. restic
// recreates the absolute path of the snapshot, so the world set is nested some
// levels down.
func locateWorldSet(root string) (string, error) {
	var candidate string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !d.IsDir() {
			return nil
		}
		if hasAnyDimension(p) {
			candidate = p
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if candidate == "" {
		return "", errors.New("the backup does not contain a recognisable world set")
	}
	return candidate, nil
}

func hasAnyDimension(dir string) bool {
	for _, dim := range dimensionDirs {
		if st, err := os.Stat(filepath.Join(dir, dim)); err == nil && st.IsDir() {
			return true
		}
	}
	return false
}

// validateWorldSet rejects a restored copy that Minecraft would refuse to load.
func validateWorldSet(dir string) error {
	overworld := filepath.Join(dir, "world")
	st, err := os.Stat(overworld)
	if err != nil || !st.IsDir() {
		return errors.New("restored data has no Overworld directory")
	}
	if _, err := os.Stat(filepath.Join(overworld, "level.dat")); err != nil {
		if _, oldErr := os.Stat(filepath.Join(overworld, "level.dat_old")); oldErr != nil {
			return errors.New("restored Overworld has no level.dat")
		}
	}
	if err := atomicfs.NoSymlinks(dir); err != nil {
		return fmt.Errorf("restored data contains unexpected file types: %w", err)
	}
	return nil
}

// ReconcileInterrupted cleans up after a controller that died mid-operation. It is
// called once during startup, before anything else may touch the world.
func (m *Manager) ReconcileInterrupted(ctx context.Context) {
	entries, err := m.deps.Store.OpenJournals()
	if err != nil {
		m.log.Warn("could not read the recovery journal", "error", err)
		return
	}
	for _, entry := range entries {
		switch entry.Op {
		case store.OpBackup:
			m.recoverBackup(entry)
		case store.OpRestore:
			m.recoverRestore(entry)
		}
	}
	// Whatever happened, saving must be on.
	m.deps.Supervisor.EnsureSaveOn()
}

func (m *Manager) recoverBackup(entry store.JournalEntry) {
	staging := entry.PayloadString("staging")
	recordID := entry.PayloadString("record")
	m.log.Warn("recovering interrupted backup", "phase", entry.Phase, "record", recordID)

	if staging != "" {
		if err := os.RemoveAll(staging); err != nil {
			m.log.Warn("could not clean staging copy", "path", staging, "error", err)
		}
	}
	if recordID != "" {
		if record, ok, err := m.deps.Store.GetBackup(recordID); err == nil && ok && record.Status == store.BackupRunning {
			record.Status = store.BackupFailed
			record.FinishedAt = time.Now().UTC()
			record.Notes = "interrupted by an add-on restart"
			_ = m.deps.Store.PutBackup(record)
		}
	}
	_ = m.deps.Store.JournalEnd(entry.ID, store.JournalFailed, "recovered after controller restart")
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "backup.recovered",
		Target: recordID, Detail: "interrupted during phase " + entry.Phase, Result: "warning"})
	m.deps.Bus.Warn("backups", "an interrupted backup was cleaned up during startup")
}

// recoverRestore is the delicate one: if the controller died between moving the
// old world aside and confirming the new one, the previous world is still on disk
// and is put back.
func (m *Manager) recoverRestore(entry store.JournalEntry) {
	aside := entry.PayloadString("aside")
	worldID := entry.PayloadString("world")
	staging := entry.PayloadString("staging")
	m.log.Warn("recovering interrupted restore", "phase", entry.Phase, "world", worldID)

	if staging != "" {
		_ = os.RemoveAll(staging)
	}
	switch entry.Phase {
	case "verify", "safety_backup", "restore_staging":
		// Nothing was swapped yet; the world on disk is untouched.
		_ = m.deps.Store.JournalEnd(entry.ID, store.JournalFailed, "interrupted before any world data was replaced")
		m.deps.Bus.Warn("backups", "an interrupted restore was rolled back; the world was not modified")
	case "swap", "verify_start":
		if aside == "" || worldID == "" {
			_ = m.deps.Store.JournalEnd(entry.ID, store.JournalFailed, "interrupted during the swap, no previous copy recorded")
			m.deps.Bus.Fail("backups",
				"a restore was interrupted while replacing world data and no rollback copy was recorded; check the world and restore again")
			return
		}
		worldDir, err := m.deps.WorldDir(worldID)
		if err != nil {
			_ = m.deps.Store.JournalEnd(entry.ID, store.JournalFailed, err.Error())
			return
		}
		if _, statErr := os.Stat(aside); statErr != nil {
			// The aside copy is gone, which means the swap completed and the
			// cleanup ran: the restore effectively succeeded.
			_ = m.deps.Store.JournalEnd(entry.ID, store.JournalDone, "restore had already completed")
			return
		}
		if err := atomicfs.RestoreAside(aside, worldDir); err != nil {
			_ = m.deps.Store.JournalEnd(entry.ID, store.JournalFailed, "rollback failed: "+err.Error())
			m.deps.Bus.Fail("backups", "could not roll back an interrupted restore: "+err.Error())
			return
		}
		_ = m.deps.Store.JournalEnd(entry.ID, store.JournalFailed, "rolled back after controller restart")
		_ = m.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "backup.restore_recovered",
			Target: worldID, Detail: "rolled back an interrupted restore", Result: "warning"})
		m.deps.Bus.Warn("backups", "an interrupted restore was rolled back to the previous world")
	default:
		_ = m.deps.Store.JournalEnd(entry.ID, store.JournalFailed, "interrupted during phase "+entry.Phase)
	}
}
