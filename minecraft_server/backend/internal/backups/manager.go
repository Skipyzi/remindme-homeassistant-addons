package backups

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

var (
	ErrNotFound     = errors.New("backup not found")
	ErrBusy         = errors.New("another backup or restore is already running")
	ErrNotCancelled = errors.New("this operation cannot be cancelled safely at this point")
)

// Consistency levels, reported per backup so the user knows what they have.
const (
	ConsistencyClean   = "clean"   // server was stopped
	ConsistencyFlushed = "flushed" // saving disabled and flushed before the snapshot
	ConsistencyLive    = "live"    // copied while the server was writing - last resort
)

type Deps struct {
	Paths      appcfg.Paths
	Settings   *appcfg.Store
	Store      *store.Store
	Bus        *events.Bus
	Supervisor *supervisor.Supervisor
	Backend    adapter.Backend
	Restic     *Restic
	Log        *slog.Logger
	// WorldDir resolves a world id to its directory.
	WorldDir func(id string) (string, error)
	// ActiveWorld returns the currently selected world id.
	ActiveWorld  func() string
	Invalidate   func(name, path string)
	StartTimeout time.Duration
}

type operation struct {
	ID          string
	Kind        string
	StartedAt   time.Time
	cancel      context.CancelFunc
	cancelSafe  bool
	description string
}

type Manager struct {
	deps Deps
	log  *slog.Logger

	mu      sync.Mutex
	current *operation
}

func NewManager(d Deps) *Manager {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.StartTimeout <= 0 {
		d.StartTimeout = 5 * time.Minute
	}
	return &Manager{deps: d, log: d.Log.With("component", "backups")}
}

// Init prepares the repository. Failure is not fatal for the add-on: the UI stays
// up and reports that backups are unavailable.
func (m *Manager) Init(ctx context.Context) error {
	version, err := m.deps.Restic.Available(ctx)
	if err != nil {
		return err
	}
	m.log.Info("restic available", "version", version)
	return m.deps.Restic.EnsureRepo(ctx)
}

// ---------------------------------------------------------------- creating ----

type CreateRequest struct {
	WorldID string `json:"world_id"`
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Notes   string `json:"notes"`
	// Offline stops Minecraft for a fully clean backup and starts it again
	// afterwards.
	Offline bool `json:"offline"`
	// AllowLive permits a backup even when saving could not be flushed. Without
	// it, a failed flush aborts instead of producing a snapshot that looks clean
	// but is not.
	AllowLive bool  `json:"allow_live"`
	Verify    *bool `json:"verify"`
}

// Create produces one backup of one world set.
func (m *Manager) Create(ctx context.Context, req CreateRequest, actor string, parent *supervisor.Lease) (store.BackupRecord, error) {
	if req.WorldID == "" {
		req.WorldID = m.deps.ActiveWorld()
	}
	if req.WorldID == "" {
		return store.BackupRecord{}, errors.New("no world selected")
	}
	if req.Kind == "" {
		req.Kind = "manual"
	}
	worldDir, err := m.deps.WorldDir(req.WorldID)
	if err != nil {
		return store.BackupRecord{}, err
	}
	if _, err := os.Stat(worldDir); err != nil {
		return store.BackupRecord{}, fmt.Errorf("world %s: %w", req.WorldID, err)
	}
	if err := m.deps.Restic.EnsureRepo(ctx); err != nil {
		return store.BackupRecord{}, err
	}

	lease, mine, err := m.deps.Supervisor.AcquireOrReuse(parent, supervisor.ActivityBackup)
	if err != nil {
		return store.BackupRecord{}, err
	}
	if mine {
		defer m.deps.Supervisor.Release(lease)
	}

	opCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	recordID := newID("bk")
	// A backup that is a step of a bigger operation (a restore's safety backup, a
	// pre-generation backup) runs inside that operation instead of claiming a new
	// one.
	if mine {
		if err := m.beginOperation(&operation{
			ID: recordID, Kind: "backup", StartedAt: time.Now(), cancel: cancel, cancelSafe: true,
			description: "backing up " + req.WorldID,
		}); err != nil {
			return store.BackupRecord{}, err
		}
		defer m.endOperation()
	}

	record := store.BackupRecord{
		ID: recordID, WorldID: req.WorldID, Kind: req.Kind, Label: req.Label, Notes: req.Notes,
		Status: store.BackupRunning, Consistency: "unknown", CreatedAt: time.Now().UTC(),
		Flavour: m.deps.Paths.Flavour(),
	}
	if err := m.deps.Store.PutBackup(record); err != nil {
		return record, err
	}
	m.publishProgress("backup", recordID, 0, "preparing")

	journalID, _ := m.deps.Store.JournalBegin(store.OpBackup, "prepare", map[string]any{
		"record": recordID, "world": req.WorldID, "kind": req.Kind, "actor": actor,
	})

	started := time.Now()
	fail := func(err error) (store.BackupRecord, error) {
		record.Status = store.BackupFailed
		record.FinishedAt = time.Now().UTC()
		record.DurationMs = time.Since(started).Milliseconds()
		record.Notes = strings.TrimSpace(record.Notes + "\nfailed: " + err.Error())
		_ = m.deps.Store.PutBackup(record)
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "backup.failed",
			Target: req.WorldID, Detail: err.Error(), Result: "error"})
		m.deps.Bus.Fail("backups", "backup failed: "+err.Error())
		return record, err
	}

	// Decide how the world will be captured.
	wasRunning := m.deps.Supervisor.IsRunning()
	restartAfter := false
	if wasRunning && req.Offline {
		m.deps.Supervisor.Note("stopping Minecraft for an offline backup")
		if err := m.deps.Supervisor.Stop(opCtx, supervisor.StopOptions{Reason: "offline backup"}); err != nil {
			return fail(fmt.Errorf("could not stop Minecraft: %w", err))
		}
		restartAfter = true
		wasRunning = false
	}

	stagingRoot := filepath.Join(m.deps.Paths.Staging(), "live")
	// The staging path is stable per world on purpose: restic then recognises the
	// previous snapshot as the parent and only re-reads region files that actually
	// changed. PaperMC keeps the original path so repositories that predate
	// multi-flavour support keep their parent chain; anything else is nested under
	// its flavour, because two flavours can have a world of the same name.
	staging := filepath.Join(stagingRoot, req.WorldID)
	if flavour := m.deps.Paths.Flavour(); flavour != appcfg.DefaultFlavour {
		staging = filepath.Join(stagingRoot, flavour, req.WorldID)
	}
	if err := os.RemoveAll(staging); err != nil {
		return fail(err)
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return fail(err)
	}

	consistency := ConsistencyClean
	if wasRunning {
		_ = m.deps.Store.JournalPhase(journalID, "save_off", map[string]any{"staging": staging})
		flushed, ferr := m.freezeSaving(opCtx)
		// Saving is re-enabled immediately after the hardlink pass, and again in
		// this deferred call if anything below goes wrong.
		defer m.thawSaving(context.WithoutCancel(opCtx))
		if ferr != nil || !flushed {
			if !req.AllowLive {
				return fail(fmt.Errorf("could not flush the world before the snapshot; retry with an explicit live backup or stop the server"))
			}
			consistency = ConsistencyLive
			m.deps.Bus.Warn("backups",
				"world data could not be flushed; this backup is crash-consistent only")
		} else {
			consistency = ConsistencyFlushed
		}
	}

	m.publishProgress("backup", recordID, 5, "snapshotting world files")
	linked, copied, err := atomicfs.HardlinkTree(worldDir, staging)
	if wasRunning {
		// Keep the save-off window as short as possible: saving is re-enabled the
		// moment the (cheap) hardlink pass is done, long before restic runs.
		m.thawSaving(context.WithoutCancel(opCtx))
	}
	if err != nil {
		return fail(fmt.Errorf("stage world files: %w", err))
	}
	m.log.Info("staged world", "world", req.WorldID, "hardlinked", linked, "copied", copied)

	_ = m.deps.Store.JournalPhase(journalID, "restic", nil)
	m.publishProgress("backup", recordID, 10, "deduplicating and compressing")

	tags := []string{"world:" + req.WorldID, "kind:" + req.Kind, "record:" + recordID,
		"flavour:" + m.deps.Paths.Flavour()}
	summary, err := m.deps.Restic.Backup(opCtx, staging, tags, func(p Progress) {
		// restic's own progress covers 10-90% of the operation for the user.
		m.publishProgress("backup", recordID, 10+p.PercentDone*0.8, fmt.Sprintf("%s", humanBytes(p.BytesDone)))
	})
	if err != nil {
		_ = os.RemoveAll(staging)
		return fail(err)
	}

	record.SnapshotID = summary.SnapshotID
	record.SizeBytes = summary.TotalBytes
	record.AddedBytes = summary.DataAdded
	record.Consistency = consistency

	verify := m.deps.Settings.Get().BackupVerifyAfterWrite
	if req.Verify != nil {
		verify = *req.Verify
	}
	if verify {
		m.publishProgress("backup", recordID, 92, "verifying repository")
		if _, err := m.deps.Restic.Check(opCtx, ""); err != nil {
			m.deps.Bus.Warn("backups", "repository verification reported a problem: "+err.Error())
			record.Notes = strings.TrimSpace(record.Notes + "\nverification warning: " + err.Error())
		} else {
			record.Verified = true
			_ = m.deps.Store.SetKV("backups.last_check", time.Now().UTC().Format(time.RFC3339))
		}
	}

	_ = m.deps.Store.JournalPhase(journalID, "cleanup", nil)
	if err := os.RemoveAll(staging); err != nil {
		m.log.Warn("could not remove staging copy", "path", staging, "error", err)
	}

	record.Status = store.BackupComplete
	record.FinishedAt = time.Now().UTC()
	record.DurationMs = time.Since(started).Milliseconds()
	if err := m.deps.Store.PutBackup(record); err != nil {
		return record, err
	}
	_ = m.deps.Store.JournalEnd(journalID, store.JournalDone, "")

	if restartAfter {
		if err := m.deps.Supervisor.Start(); err != nil {
			m.deps.Bus.Fail("backups", "backup finished but Minecraft could not be restarted: "+err.Error())
		}
	}

	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "backup.create", Target: req.WorldID,
		Detail: fmt.Sprintf("snapshot=%s kind=%s consistency=%s added=%s total=%s duration=%s",
			shortID(summary.SnapshotID), req.Kind, consistency,
			humanBytes(summary.DataAdded), humanBytes(summary.TotalBytes),
			time.Duration(record.DurationMs)*time.Millisecond)})

	m.publishProgress("backup", recordID, 100, "complete")
	m.deps.Bus.Publish(events.TypeBackupsChanged, map[string]any{"created": recordID, "world": req.WorldID})
	m.refreshRepoSize()

	// Retention runs after a successful backup so the repository does not grow
	// without bound; failures are reported but do not fail the backup.
	go m.applyRetentionAsync(actor)
	return record, nil
}

// freezeSaving disables autosaving and flushes pending writes. It returns whether
// the flush was confirmed by the server.
func (m *Manager) freezeSaving(ctx context.Context) (bool, error) {
	saveOffSeen := make(chan struct{}, 1)
	savedSeen := make(chan struct{}, 1)

	watchCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	go func() {
		_ = m.deps.Supervisor.Watch(watchCtx, func(ev adapter.LogEvent) bool {
			switch ev.Kind {
			case adapter.KindSaveDisabled:
				select {
				case saveOffSeen <- struct{}{}:
				default:
				}
			case adapter.KindSaved:
				select {
				case savedSeen <- struct{}{}:
				default:
				}
				return true
			}
			return false
		})
	}()

	if err := m.deps.Supervisor.Send(m.deps.Backend.SaveOffCommand()); err != nil {
		return false, err
	}
	select {
	case <-saveOffSeen:
	case <-time.After(10 * time.Second):
		m.log.Warn("no save-off confirmation from the server")
	}
	if err := m.deps.Supervisor.Send(m.deps.Backend.SaveAllCommand()); err != nil {
		return false, err
	}
	select {
	case <-savedSeen:
		return true, nil
	case <-watchCtx.Done():
		return false, nil
	}
}

// thawSaving re-enables saving. It is safe to call more than once, and it is
// called from a deferred function on every failure path: leaving a server with
// saving disabled is the worst outcome this package could produce.
func (m *Manager) thawSaving(ctx context.Context) {
	if !m.deps.Supervisor.SaveDisabled() {
		return
	}
	if !m.deps.Supervisor.IsRunning() {
		m.deps.Supervisor.EnsureSaveOn()
		return
	}
	watchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	confirmed := make(chan struct{}, 1)
	go func() {
		_ = m.deps.Supervisor.Watch(watchCtx, func(ev adapter.LogEvent) bool {
			if ev.Kind == adapter.KindSaveEnabled {
				close(confirmed)
				return true
			}
			return false
		})
	}()
	if err := m.deps.Supervisor.Send(m.deps.Backend.SaveOnCommand()); err != nil {
		m.deps.Bus.Fail("backups", "could not re-enable world saving: "+err.Error())
		return
	}
	select {
	case <-confirmed:
	case <-watchCtx.Done():
		m.deps.Bus.Warn("backups", "no confirmation that world saving was re-enabled; check the console")
	}
}

// ---------------------------------------------------------------- listing ----

// Record is the API view of a backup.
type Record struct {
	store.BackupRecord
	Exists bool `json:"exists_in_repository"`
}

func (m *Manager) List(ctx context.Context, limit int) ([]Record, error) {
	records, err := m.deps.Store.ListBackups(limit)
	if err != nil {
		return nil, err
	}
	present := map[string]bool{}
	if snapshots, err := m.deps.Restic.Snapshots(ctx, nil); err == nil {
		for _, s := range snapshots {
			present[s.ID] = true
			present[s.ShortID] = true
		}
	}
	out := make([]Record, 0, len(records))
	for _, r := range records {
		out = append(out, Record{BackupRecord: r, Exists: present[r.SnapshotID] || present[shortID(r.SnapshotID)]})
	}
	return out, nil
}

// Health summarises the repository for the UI.
type Health struct {
	Available     bool   `json:"available"`
	ResticVersion string `json:"restic_version"`
	Repository    string `json:"repository"`
	SizeBytes     int64  `json:"size_bytes"`
	SnapshotCount int    `json:"snapshot_count"`
	LastCheck     string `json:"last_check"`
	LastBackupAt  string `json:"last_backup_at"`
	LastDuration  int64  `json:"last_duration_ms"`
	Error         string `json:"error,omitempty"`
}

func (m *Manager) Health(ctx context.Context) Health {
	health := Health{Repository: m.deps.Paths.ResticRepo()}
	version, err := m.deps.Restic.Available(ctx)
	if err != nil {
		health.Error = err.Error()
		return health
	}
	health.Available = true
	health.ResticVersion = version
	if stats, err := m.deps.Restic.Stats(ctx, "raw-data"); err == nil {
		health.SizeBytes = stats.TotalSize
	} else {
		health.Error = err.Error()
	}
	if snapshots, err := m.deps.Restic.Snapshots(ctx, nil); err == nil {
		health.SnapshotCount = len(snapshots)
	}
	if v, ok, _ := m.deps.Store.GetKV("backups.last_check"); ok {
		health.LastCheck = v
	}
	if last, ok, _ := m.deps.Store.LastSuccessfulBackup(); ok {
		health.LastBackupAt = last.CreatedAt.UTC().Format(time.RFC3339)
		health.LastDuration = last.DurationMs
	}
	return health
}

// Preview lists what a restore would put back.
type Preview struct {
	BackupID   string      `json:"backup_id"`
	SnapshotID string      `json:"snapshot_id"`
	WorldID    string      `json:"world_id"`
	CreatedAt  string      `json:"created_at"`
	TotalBytes int64       `json:"total_bytes"`
	Entries    []FileEntry `json:"entries"`
	Truncated  bool        `json:"truncated"`
}

func (m *Manager) Preview(ctx context.Context, id string) (Preview, error) {
	record, ok, err := m.deps.Store.GetBackup(id)
	if err != nil {
		return Preview{}, err
	}
	if !ok {
		return Preview{}, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	const limit = 400
	entries, err := m.deps.Restic.ListFiles(ctx, record.SnapshotID, limit)
	if err != nil {
		return Preview{}, err
	}
	preview := Preview{
		BackupID: record.ID, SnapshotID: record.SnapshotID, WorldID: record.WorldID,
		CreatedAt: record.CreatedAt.UTC().Format(time.RFC3339), TotalBytes: record.SizeBytes,
		Entries: entries, Truncated: len(entries) >= limit,
	}
	return preview, nil
}

// Delete removes a snapshot and its record.
func (m *Manager) Delete(ctx context.Context, id, actor string) error {
	record, ok, err := m.deps.Store.GetBackup(id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if record.SnapshotID != "" {
		if err := m.deps.Restic.ForgetSnapshot(ctx, record.SnapshotID, true); err != nil {
			return err
		}
	}
	if err := m.deps.Store.DeleteBackup(record.ID); err != nil {
		return err
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "backup.delete", Target: record.ID,
		Detail: "snapshot=" + shortID(record.SnapshotID)})
	m.deps.Bus.Publish(events.TypeBackupsChanged, map[string]any{"deleted": record.ID})
	m.refreshRepoSize()
	return nil
}

// SetLabel updates the label and notes of a backup.
func (m *Manager) SetLabel(id, label, notes, actor string) (store.BackupRecord, error) {
	record, ok, err := m.deps.Store.GetBackup(id)
	if err != nil {
		return record, err
	}
	if !ok {
		return record, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	record.Label = label
	record.Notes = notes
	if err := m.deps.Store.PutBackup(record); err != nil {
		return record, err
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "backup.label", Target: record.ID,
		Detail: "label=" + label})
	return record, nil
}

// Verify runs a repository check, optionally re-reading a percentage of the data.
func (m *Manager) Verify(ctx context.Context, readSubset, actor string) (string, error) {
	out, err := m.deps.Restic.Check(ctx, readSubset)
	result := "ok"
	if err != nil {
		result = "error"
	} else {
		_ = m.deps.Store.SetKV("backups.last_check", time.Now().UTC().Format(time.RFC3339))
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "backup.verify", Target: "repository",
		Detail: "read_subset=" + readSubset, Result: result})
	return out, err
}

// ApplyRetention enforces the configured retention rules.
func (m *Manager) ApplyRetention(ctx context.Context, actor string) error {
	r := m.deps.Settings.Get().BackupRetention
	if r.KeepLast <= 0 && r.KeepDaily <= 0 && r.KeepWeekly <= 0 && r.KeepMonthly <= 0 {
		return nil
	}
	if _, err := m.deps.Restic.Forget(ctx, r.KeepLast, r.KeepDaily, r.KeepWeekly, r.KeepMonthly, true); err != nil {
		return err
	}
	// Reconcile the local index with what survived in the repository.
	snapshots, err := m.deps.Restic.Snapshots(ctx, nil)
	if err != nil {
		return err
	}
	alive := map[string]bool{}
	for _, s := range snapshots {
		alive[s.ID] = true
		alive[s.ShortID] = true
	}
	records, err := m.deps.Store.ListBackups(1000)
	if err != nil {
		return err
	}
	removed := 0
	for _, rec := range records {
		if rec.Status != store.BackupComplete || rec.SnapshotID == "" {
			continue
		}
		if !alive[rec.SnapshotID] && !alive[shortID(rec.SnapshotID)] {
			_ = m.deps.Store.DeleteBackup(rec.ID)
			removed++
		}
	}
	if removed > 0 {
		_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "backup.retention",
			Target: "repository", Detail: fmt.Sprintf("forgot %d snapshots", removed)})
		m.deps.Bus.Publish(events.TypeBackupsChanged, map[string]any{"retention_removed": removed})
	}
	m.refreshRepoSize()
	return nil
}

func (m *Manager) applyRetentionAsync(actor string) {
	if m.deps.Store.IsClosed() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	if err := m.ApplyRetention(ctx, actor); err != nil {
		m.log.Warn("retention failed", "error", err)
		m.deps.Bus.Warn("backups", "applying retention rules failed: "+err.Error())
	}
}

// --------------------------------------------------------------- operations ----

func (m *Manager) beginOperation(op *operation) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current != nil {
		return fmt.Errorf("%w: %s", ErrBusy, m.current.description)
	}
	m.current = op
	return nil
}

func (m *Manager) endOperation() {
	m.mu.Lock()
	m.current = nil
	m.mu.Unlock()
}

func (m *Manager) setCancelSafe(safe bool) {
	m.mu.Lock()
	if m.current != nil {
		m.current.cancelSafe = safe
	}
	m.mu.Unlock()
}

// Current reports the running backup or restore, if any.
func (m *Manager) Current() (id, kind, description string, cancellable bool, running bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil {
		return "", "", "", false, false
	}
	return m.current.ID, m.current.Kind, m.current.description, m.current.cancelSafe, true
}

// Cancel stops the running operation when it is safe to do so. A restore that has
// already started replacing world data is never cancelled: finishing or rolling
// back is safer than stopping half way.
func (m *Manager) Cancel(actor string) error {
	m.mu.Lock()
	op := m.current
	m.mu.Unlock()
	if op == nil {
		return errors.New("nothing to cancel")
	}
	if !op.cancelSafe {
		return ErrNotCancelled
	}
	op.cancel()
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: op.Kind + ".cancel", Target: op.ID})
	return nil
}

func (m *Manager) publishProgress(kind, id string, percent float64, message string) {
	eventType := events.TypeBackupProgress
	if kind == "restore" {
		eventType = events.TypeRestoreProgress
	}
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	m.deps.Bus.Publish(eventType, map[string]any{
		"id": id, "percent": percent, "message": message,
	})
}

func (m *Manager) refreshRepoSize() {
	if m.deps.Invalidate != nil {
		m.deps.Invalidate("backups", m.deps.Paths.Backups())
	}
}

func newID(prefix string) string {
	buf := make([]byte, 4)
	_, _ = rand.Read(buf)
	return fmt.Sprintf("%s-%s-%s", prefix, time.Now().UTC().Format("20060102T150405"), hex.EncodeToString(buf))
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	value := float64(n)
	units := []string{"KiB", "MiB", "GiB", "TiB"}
	for _, u := range units {
		value /= unit
		if value < unit {
			return fmt.Sprintf("%.1f %s", value, u)
		}
	}
	return fmt.Sprintf("%.1f PiB", value)
}

// SortRecords orders records newest first, used by tests and the API.
func SortRecords(records []Record) {
	sort.Slice(records, func(i, j int) bool {
		return records[i].CreatedAt.After(records[j].CreatedAt)
	})
}
