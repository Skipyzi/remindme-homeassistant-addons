package worlds

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

// ActivateRequest describes a world switch.
type ActivateRequest struct {
	WorldID string `json:"world_id"`
	// Backup takes a safety backup of the current world before switching.
	Backup bool `json:"backup"`
	// Restart starts Minecraft afterwards. Defaults to "whatever it was doing".
	Restart *bool `json:"restart"`
}

// ActivateResult reports the outcome, including a rollback if one happened.
type ActivateResult struct {
	WorldID      string `json:"world_id"`
	Previous     string `json:"previous_world_id"`
	Started      bool   `json:"started"`
	RolledBack   bool   `json:"rolled_back"`
	BackupTaken  bool   `json:"backup_taken"`
	Message      string `json:"message"`
	DurationMsec int64  `json:"duration_ms"`
}

// Activate switches the active world.
//
// Sequence: validate, take the lease, optionally back up, stop gracefully, change
// the configuration, start, verify the server actually came up, and roll back to
// the previous world if it did not.
func (m *Manager) Activate(ctx context.Context, req ActivateRequest, actor string) (ActivateResult, error) {
	start := time.Now()
	result := ActivateResult{WorldID: req.WorldID}

	if err := m.Validate(req.WorldID); err != nil {
		return result, err
	}
	settings := m.deps.Settings.Get()
	previous := settings.ActiveWorld
	result.Previous = previous
	if previous == req.WorldID {
		result.Message = "this world is already active"
		return result, nil
	}

	lease, err := m.deps.Supervisor.Acquire(supervisor.ActivityWorldSwitch)
	if err != nil {
		return result, err
	}
	defer m.deps.Supervisor.Release(lease)

	wasRunning := m.deps.Supervisor.State() == supervisor.StateRunning ||
		m.deps.Supervisor.State() == supervisor.StateStarting
	shouldStart := wasRunning
	if req.Restart != nil {
		shouldStart = *req.Restart
	}

	journalID, err := m.deps.Store.JournalBegin(store.OpWorldSwitch, "begin", map[string]any{
		"from": previous, "to": req.WorldID, "was_running": wasRunning, "actor": actor,
	})
	if err != nil {
		m.log.Warn("could not journal world switch", "error", err)
	}

	if req.Backup && previous != "" && m.deps.Backup != nil {
		m.deps.Supervisor.SetActivity(lease, supervisor.ActivityBackup)
		m.deps.Supervisor.Note("backing up %s before switching worlds", previous)
		if err := m.deps.Backup(ctx, previous, "pre_world_switch",
			fmt.Sprintf("before switching to %s", req.WorldID), lease); err != nil {
			m.deps.Supervisor.SetActivity(lease, supervisor.ActivityWorldSwitch)
			_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, "safety backup failed: "+err.Error())
			return result, fmt.Errorf("safety backup failed, world switch aborted: %w", err)
		}
		result.BackupTaken = true
		m.deps.Supervisor.SetActivity(lease, supervisor.ActivityWorldSwitch)
	}

	if wasRunning {
		_ = m.deps.Store.JournalPhase(journalID, "stopping", nil)
		if err := m.deps.Supervisor.Stop(ctx, supervisor.StopOptions{
			Reason: "world switch to " + req.WorldID,
		}); err != nil {
			_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, "stop failed: "+err.Error())
			return result, fmt.Errorf("could not stop Minecraft: %w", err)
		}
	}

	_ = m.deps.Store.JournalPhase(journalID, "switching", nil)
	if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = req.WorldID }); err != nil {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return result, err
	}
	if err := m.PrepareRuntime(); err != nil {
		m.rollback(ctx, journalID, previous, wasRunning)
		result.RolledBack = true
		return result, fmt.Errorf("could not prepare the world: %w", err)
	}

	if !shouldStart {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalDone, "switched while stopped")
		m.finishActivate(actor, previous, req.WorldID, result)
		result.DurationMsec = time.Since(start).Milliseconds()
		return result, nil
	}

	_ = m.deps.Store.JournalPhase(journalID, "starting", nil)
	if err := m.deps.Supervisor.Start(); err != nil {
		m.rollback(ctx, journalID, previous, wasRunning)
		result.RolledBack = true
		return result, fmt.Errorf("Minecraft did not start with the new world: %w", err)
	}
	readyCtx, cancel := context.WithTimeout(ctx, m.deps.StartTimeout)
	defer cancel()
	if err := m.deps.Supervisor.WaitReady(readyCtx); err != nil {
		m.deps.Bus.Fail("worlds", "the new world failed to start, rolling back")
		m.rollback(ctx, journalID, previous, wasRunning)
		result.RolledBack = true
		return result, fmt.Errorf("the new world failed to start (%w); rolled back to %s", err, previous)
	}

	result.Started = true
	_ = m.deps.Store.JournalEnd(journalID, store.JournalDone, "")
	m.finishActivate(actor, previous, req.WorldID, result)
	result.DurationMsec = time.Since(start).Milliseconds()
	return result, nil
}

func (m *Manager) finishActivate(actor, previous, next string, result ActivateResult) {
	_, _ = m.UpdateMeta(next, func(meta *Meta) { meta.LastPlayedAt = time.Now().UTC() })
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "world.activate", Target: next,
		Detail: fmt.Sprintf("previous=%s started=%t backup=%t", previous, result.Started, result.BackupTaken)})
	m.deps.Bus.Publish(events.TypeWorldsChanged, map[string]any{"active": next, "previous": previous})
	m.invalidate(next)
}

// rollback restores the previous world and, if Minecraft was running before,
// brings it back up. A failed rollback is loud: it is the one situation where the
// user has to intervene.
func (m *Manager) rollback(ctx context.Context, journalID int64, previous string, wasRunning bool) {
	_ = m.deps.Store.JournalPhase(journalID, "rollback", map[string]any{"to": previous})
	m.deps.Supervisor.Note("rolling back to world %s", previous)

	if m.deps.Supervisor.State() == supervisor.StateRunning || m.deps.Supervisor.State() == supervisor.StateStarting {
		_ = m.deps.Supervisor.Stop(ctx, supervisor.StopOptions{Reason: "world switch rollback"})
	}
	if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = previous }); err != nil {
		m.deps.Bus.Fail("worlds", "rollback could not restore the previous world setting: "+err.Error())
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, "rollback failed: "+err.Error())
		return
	}
	if err := m.PrepareRuntime(); err != nil {
		m.deps.Bus.Fail("worlds", "rollback could not prepare the previous world: "+err.Error())
	}
	if wasRunning {
		if err := m.deps.Supervisor.Start(); err != nil {
			m.deps.Bus.Fail("worlds", "rollback could not restart Minecraft: "+err.Error())
			_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, "rollback restart failed: "+err.Error())
			return
		}
	}
	_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, "rolled back to "+previous)
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "world.switch_rollback",
		Target: previous, Detail: "the new world failed to start", Result: "error"})
}

// --------------------------------------------------------------- deletion ----

// Delete moves a world to the trash. Nothing is erased: the second, explicitly
// confirmed step is what actually deletes data.
func (m *Manager) Delete(id, actor string) (string, error) {
	if m.isActive(id) {
		if m.deps.Supervisor.IsRunning() || m.deps.Supervisor.State() == supervisor.StateStarting {
			return "", ErrActiveRunning
		}
		return "", fmt.Errorf("this world is active; switch to another world before deleting it")
	}
	dir, err := m.dir(id)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(dir); err != nil {
		return "", fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	trashName := fmt.Sprintf("%s-%s", id, time.Now().UTC().Format("20060102T150405"))
	trashPath, err := appcfg.Confine(m.deps.Paths.Trash(), trashName)
	if err != nil {
		return "", err
	}
	journalID, _ := m.deps.Store.JournalBegin(store.OpWorldDelete, "trash", map[string]any{
		"world": id, "trash": trashPath, "actor": actor,
	})
	if err := atomicfs.MoveDir(dir, trashPath); err != nil {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return "", err
	}
	_ = m.deps.Store.JournalEnd(journalID, store.JournalDone, "")
	_ = m.deps.Store.DeleteSize(dir)
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "world.trash", Target: id,
		Detail: "moved to trash/" + trashName})
	m.deps.Bus.Publish(events.TypeWorldsChanged, map[string]any{"trashed": id})
	return trashName, nil
}

// TrashEntry is a world waiting in the trash.
type TrashEntry struct {
	Name      string `json:"name"`
	WorldID   string `json:"world_id"`
	DeletedAt string `json:"deleted_at"`
	SizeBytes int64  `json:"size_bytes"`
}

func (m *Manager) Trash() ([]TrashEntry, error) {
	entries, err := os.ReadDir(m.deps.Paths.Trash())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]TrashEntry, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		full := filepath.Join(m.deps.Paths.Trash(), e.Name())
		entry := TrashEntry{Name: e.Name(), WorldID: trimTimestamp(e.Name())}
		if info, err := e.Info(); err == nil {
			entry.DeletedAt = info.ModTime().UTC().Format(time.RFC3339)
		}
		if rec, ok, err := m.deps.Store.GetSize(full); err == nil && ok {
			entry.SizeBytes = rec.Bytes
		}
		out = append(out, entry)
	}
	return out, nil
}

// PurgeTrash permanently deletes one trashed world. The caller must have
// confirmed this explicitly; the API requires a matching confirmation token.
func (m *Manager) PurgeTrash(name, actor string) error {
	if err := atomicfs.SafeName(name); err != nil {
		return err
	}
	path, err := appcfg.Confine(m.deps.Paths.Trash(), name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	bytes, _, _ := atomicfs.DirSize(path)
	if err := os.RemoveAll(path); err != nil {
		return err
	}
	_ = m.deps.Store.DeleteSize(path)
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "world.purge", Target: name,
		Detail: fmt.Sprintf("permanently deleted %d bytes", bytes)})
	m.deps.Bus.Publish(events.TypeWorldsChanged, map[string]any{"purged": name})
	return nil
}

// RestoreTrash moves a trashed world back into the worlds directory.
func (m *Manager) RestoreTrash(name, actor string) (Info, error) {
	if err := atomicfs.SafeName(name); err != nil {
		return Info{}, err
	}
	src, err := appcfg.Confine(m.deps.Paths.Trash(), name)
	if err != nil {
		return Info{}, err
	}
	if _, err := os.Stat(src); err != nil {
		return Info{}, fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	id := trimTimestamp(name)
	dst, err := m.dir(id)
	if err != nil {
		return Info{}, err
	}
	if _, err := os.Stat(dst); err == nil {
		id = fmt.Sprintf("%s-restored-%d", id, time.Now().Unix())
		if dst, err = m.dir(id); err != nil {
			return Info{}, err
		}
	}
	if err := atomicfs.MoveDir(src, dst); err != nil {
		return Info{}, err
	}
	if _, err := m.UpdateMeta(id, func(meta *Meta) {
		meta.ID = id
		if meta.Name == "" {
			meta.Name = id
		}
	}); err != nil {
		return Info{}, err
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "world.untrash", Target: id,
		Detail: "restored from trash/" + name})
	m.deps.Bus.Publish(events.TypeWorldsChanged, map[string]any{"restored": id})
	m.invalidate(id)
	return m.Get(id)
}

// trimTimestamp strips the -20060102T150405 suffix added when trashing.
func trimTimestamp(name string) string {
	if len(name) > 16 && name[len(name)-16] == '-' {
		candidate := name[len(name)-15:]
		if _, err := time.Parse("20060102T150405", candidate); err == nil {
			return name[:len(name)-16]
		}
	}
	return name
}
