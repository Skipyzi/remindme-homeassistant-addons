// Package worlds manages world sets. The Overworld, the Nether and the End are
// treated as one logical unit: they share a seed and a level.dat lineage, and
// backing up or switching one without the others produces a broken world.
package worlds

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

// Dimensions are the directory names Bukkit uses inside a world container. It
// is the default for backends that do not say otherwise; BTA, for example, has
// one directory with its dimensions nested inside it.
var Dimensions = []string{"world", "world_nether", "world_the_end"}

var (
	ErrNotFound      = errors.New("world not found")
	ErrExists        = errors.New("a world with this name already exists")
	ErrActiveRunning = errors.New("the active world cannot be changed while Minecraft is running")
	ErrInvalidWorld  = errors.New("world data is not valid")
)

const metaFile = "meta.json"

// Meta is the controller's per-world metadata, stored inside the world directory
// so an exported archive carries it along.
type Meta struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Seed         string    `json:"seed"`
	Notes        string    `json:"notes"`
	Source       string    `json:"source"` // created | imported | cloned | restored
	Archived     bool      `json:"archived"`
	CreatedAt    time.Time `json:"created_at"`
	LastPlayedAt time.Time `json:"last_played_at"`

	// Generation bookkeeping, filled in by the generation manager.
	GenerationStatus  string `json:"generation_status"` // none | partial | complete
	GeneratedRadius   int    `json:"generated_radius"`
	BorderRadius      int    `json:"border_radius"`
	LastGenerationJob string `json:"last_generation_job"`
}

// Info is the API view of a world.
type Info struct {
	Meta
	Active         bool             `json:"active"`
	SizeBytes      int64            `json:"size_bytes"`
	DimensionSizes map[string]int64 `json:"dimension_sizes"`
	SizeUpdatedAt  string           `json:"size_updated_at"`
	Exists         map[string]bool  `json:"dimensions_present"`
	Path           string           `json:"path"`
	BackupCount    int              `json:"backup_count"`
	LastBackupAt   string           `json:"last_backup_at"`
}

// BackupFunc creates a safety backup. It is injected to avoid a dependency cycle
// with the backups package.
type BackupFunc func(ctx context.Context, worldID, kind, label string, lease *supervisor.Lease) error

type Deps struct {
	Paths      appcfg.Paths
	Settings   *appcfg.Store
	Store      *store.Store
	Bus        *events.Bus
	Supervisor *supervisor.Supervisor
	Config     *mcconfig.Manager
	Log        *slog.Logger
	Backup     BackupFunc
	// Invalidate asks the stats collector to re-measure a directory.
	Invalidate func(name, path string)
	// Backend supplies the world set layout and how the active world is bound to
	// the server.
	Backend adapter.Backend
	// StartTimeout bounds the health check after a world switch.
	StartTimeout time.Duration
}

type Manager struct {
	deps Deps
	log  *slog.Logger
}

func NewManager(d Deps) *Manager {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.StartTimeout <= 0 {
		d.StartTimeout = 5 * time.Minute
	}
	return &Manager{deps: d, log: d.Log.With("component", "worlds")}
}

// dimensions is the world set layout of the active backend.
func (m *Manager) dimensions() []string {
	if m.deps.Backend != nil {
		if dims := m.deps.Backend.Capabilities().Dimensions; len(dims) > 0 {
			return dims
		}
	}
	return Dimensions
}

// binding is how the active backend is pointed at a world set.
func (m *Manager) binding() adapter.WorldBinding {
	if m.deps.Backend == nil {
		return adapter.BindContainerArg
	}
	return m.deps.Backend.Capabilities().WorldBinding
}

// ---------------------------------------------------------------- listing ----

func (m *Manager) dir(id string) (string, error) {
	if err := atomicfs.SafeName(id); err != nil {
		return "", fmt.Errorf("invalid world name: %w", err)
	}
	return appcfg.Confine(m.deps.Paths.Worlds(), id)
}

func (m *Manager) List() ([]Info, error) {
	entries, err := os.ReadDir(m.deps.Paths.Worlds())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	active := m.deps.Settings.Get().ActiveWorld
	backups, _ := m.deps.Store.ListBackups(500)

	out := make([]Info, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := m.info(e.Name(), active, backups)
		if err != nil {
			m.log.Warn("skipping unreadable world", "world", e.Name(), "error", err)
			continue
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Manager) Get(id string) (Info, error) {
	active := m.deps.Settings.Get().ActiveWorld
	backups, _ := m.deps.Store.ListBackups(500)
	return m.info(id, active, backups)
}

func (m *Manager) info(id, active string, backups []store.BackupRecord) (Info, error) {
	dir, err := m.dir(id)
	if err != nil {
		return Info{}, err
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return Info{}, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	meta, err := m.readMeta(id)
	if err != nil {
		return Info{}, err
	}
	info := Info{
		Meta:           meta,
		Active:         id == active,
		Path:           dir,
		DimensionSizes: map[string]int64{},
		Exists:         map[string]bool{},
	}
	for _, dim := range m.dimensions() {
		dimPath := filepath.Join(dir, dim)
		if st, err := os.Stat(dimPath); err == nil && st.IsDir() {
			info.Exists[dim] = true
		}
		if rec, ok, err := m.deps.Store.GetSize(dimPath); err == nil && ok {
			info.DimensionSizes[dim] = rec.Bytes
		}
	}
	if rec, ok, err := m.deps.Store.GetSize(dir); err == nil && ok {
		info.SizeBytes = rec.Bytes
		info.SizeUpdatedAt = rec.UpdatedAt.UTC().Format(time.RFC3339)
	}
	for _, b := range backups {
		if b.WorldID != id || b.Status != store.BackupComplete {
			continue
		}
		info.BackupCount++
		if info.LastBackupAt == "" {
			info.LastBackupAt = b.CreatedAt.UTC().Format(time.RFC3339)
		}
	}
	return info, nil
}

func (m *Manager) readMeta(id string) (Meta, error) {
	dir, err := m.dir(id)
	if err != nil {
		return Meta{}, err
	}
	meta := Meta{ID: id, Name: id, Source: "unknown", GenerationStatus: "none"}
	raw, err := os.ReadFile(filepath.Join(dir, metaFile))
	if err != nil {
		if os.IsNotExist(err) {
			// A world folder created outside the add-on is still usable; the
			// metadata is simply defaulted and written on the next change.
			if st, statErr := os.Stat(dir); statErr == nil {
				meta.CreatedAt = st.ModTime()
			}
			return meta, nil
		}
		return meta, err
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return meta, fmt.Errorf("world metadata is corrupt: %w", err)
	}
	meta.ID = id
	if meta.Name == "" {
		meta.Name = id
	}
	return meta, nil
}

func (m *Manager) writeMeta(meta Meta) error {
	dir, err := m.dir(meta.ID)
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return atomicfs.WriteFile(filepath.Join(dir, metaFile), append(raw, '\n'), 0o644)
}

// UpdateMeta applies fn to a world's metadata.
func (m *Manager) UpdateMeta(id string, fn func(*Meta)) (Meta, error) {
	meta, err := m.readMeta(id)
	if err != nil {
		return meta, err
	}
	fn(&meta)
	return meta, m.writeMeta(meta)
}

// ---------------------------------------------------------------- creation ----

type CreateRequest struct {
	Name  string `json:"name"`
	Seed  string `json:"seed"`
	Notes string `json:"notes"`
}

// Create prepares an empty world set. Minecraft generates the actual terrain the
// first time the world is activated and started.
func (m *Manager) Create(req CreateRequest, actor string) (Info, error) {
	id := normalizeID(req.Name)
	dir, err := m.dir(id)
	if err != nil {
		return Info{}, err
	}
	if _, err := os.Stat(dir); err == nil {
		return Info{}, fmt.Errorf("%w: %s", ErrExists, id)
	}
	if strings.ContainsAny(req.Seed, "\n\r\x00") || len(req.Seed) > 64 {
		return Info{}, fmt.Errorf("invalid seed")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Info{}, err
	}
	meta := Meta{
		ID: id, Name: req.Name, Seed: strings.TrimSpace(req.Seed), Notes: req.Notes,
		Source: "created", CreatedAt: time.Now().UTC(), GenerationStatus: "none",
	}
	if err := m.writeMeta(meta); err != nil {
		return Info{}, err
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "world.create", Target: id,
		Detail: fmt.Sprintf("seed=%q", meta.Seed)})
	m.deps.Bus.Publish(events.TypeWorldsChanged, map[string]any{"created": id})
	m.invalidate(id)
	return m.Get(id)
}

// Clone copies a world set. Cloning the active world while the server runs is
// refused: the files would be copied mid-write.
func (m *Manager) Clone(sourceID, newName, actor string) (Info, error) {
	src, err := m.dir(sourceID)
	if err != nil {
		return Info{}, err
	}
	if _, err := os.Stat(src); err != nil {
		return Info{}, fmt.Errorf("%w: %s", ErrNotFound, sourceID)
	}
	if m.isActive(sourceID) && m.deps.Supervisor.IsRunning() {
		return Info{}, fmt.Errorf("stop Minecraft before cloning the active world")
	}
	id := normalizeID(newName)
	dst, err := m.dir(id)
	if err != nil {
		return Info{}, err
	}
	if _, err := os.Stat(dst); err == nil {
		return Info{}, fmt.Errorf("%w: %s", ErrExists, id)
	}
	// Copy into a staging directory first so an interrupted clone never leaves a
	// half-copied world in the worlds list.
	staging := filepath.Join(m.deps.Paths.Staging(), fmt.Sprintf("clone-%s-%d", id, time.Now().UnixNano()))
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return Info{}, err
	}
	defer os.RemoveAll(staging)

	if err := atomicfs.CopyTree(src, staging); err != nil {
		return Info{}, fmt.Errorf("copy world: %w", err)
	}
	if err := atomicfs.MoveDir(staging, dst); err != nil {
		return Info{}, err
	}
	sourceMeta, _ := m.readMeta(sourceID)
	meta := Meta{
		ID: id, Name: newName, Seed: sourceMeta.Seed, Notes: sourceMeta.Notes,
		Source: "cloned", CreatedAt: time.Now().UTC(),
		GenerationStatus: sourceMeta.GenerationStatus, GeneratedRadius: sourceMeta.GeneratedRadius,
		BorderRadius: sourceMeta.BorderRadius,
	}
	if err := m.writeMeta(meta); err != nil {
		return Info{}, err
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "world.clone", Target: id,
		Detail: "source=" + sourceID})
	m.deps.Bus.Publish(events.TypeWorldsChanged, map[string]any{"cloned": id, "source": sourceID})
	m.invalidate(id)
	return m.Get(id)
}

// Rename changes the display name. The directory id is deliberately immutable:
// renaming a directory would invalidate backup paths and journal entries.
func (m *Manager) Rename(id, newName, actor string) (Info, error) {
	if strings.TrimSpace(newName) == "" || len(newName) > 64 {
		return Info{}, fmt.Errorf("name must be 1-64 characters")
	}
	if _, err := m.UpdateMeta(id, func(meta *Meta) { meta.Name = newName }); err != nil {
		return Info{}, err
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "world.rename", Target: id,
		Detail: "name=" + newName})
	return m.Get(id)
}

// Archive marks a world as archived so it is hidden from the quick switcher but
// keeps its data and backups.
func (m *Manager) Archive(id string, archived bool, actor string) (Info, error) {
	if archived && m.isActive(id) {
		return Info{}, fmt.Errorf("switch to another world before archiving this one")
	}
	if _, err := m.UpdateMeta(id, func(meta *Meta) { meta.Archived = archived }); err != nil {
		return Info{}, err
	}
	action := "world.archive"
	if !archived {
		action = "world.unarchive"
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: action, Target: id})
	m.deps.Bus.Publish(events.TypeWorldsChanged, map[string]any{"archived": id})
	return m.Get(id)
}

// Validate checks that a world set is usable. An empty world (never started) is
// valid; a world whose Overworld exists but has no level.dat is not.
func (m *Manager) Validate(id string) error {
	dir, err := m.dir(id)
	if err != nil {
		return err
	}
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	overworld := filepath.Join(dir, "world")
	if _, err := os.Stat(overworld); err != nil {
		if os.IsNotExist(err) {
			return nil // fresh world, Minecraft will create it
		}
		return err
	}
	if _, err := os.Stat(filepath.Join(overworld, "level.dat")); err != nil {
		// level.dat_old is what Minecraft leaves behind when a save was
		// interrupted; accepting it lets the user recover instead of being stuck.
		if _, oldErr := os.Stat(filepath.Join(overworld, "level.dat_old")); oldErr == nil {
			return nil
		}
		// An empty directory is a world the server has not written yet, not a
		// broken one. It exists because a backend that binds its world with a link
		// needs the target to be there before the link can be followed.
		if entries, readErr := os.ReadDir(overworld); readErr == nil && len(entries) == 0 {
			return nil
		}
		return fmt.Errorf("%w: %s has no level.dat", ErrInvalidWorld, id)
	}
	return nil
}

func (m *Manager) isActive(id string) bool {
	return m.deps.Settings.Get().ActiveWorld == id
}

func (m *Manager) invalidate(id string) {
	if m.deps.Invalidate == nil {
		return
	}
	dir, err := m.dir(id)
	if err != nil {
		return
	}
	m.deps.Invalidate("world:"+id, dir)
	for _, dim := range m.dimensions() {
		m.deps.Invalidate("world:"+id+":"+dim, filepath.Join(dir, dim))
	}
}

// ContainerArgs returns the launch arguments that point Minecraft at the active
// world. Switching worlds is a change of arguments, which is atomic by
// construction: no data is moved and there is no window in which the server could
// see half of two worlds.
//
// The flag itself is backend specific, so it comes from the adapter through
// Deps.ContainerArgs.
func (m *Manager) ContainerArgs() []string {
	active := m.deps.Settings.Get().ActiveWorld
	if active == "" {
		return nil
	}
	dir, err := m.dir(active)
	if err != nil {
		return nil
	}
	if m.deps.Backend == nil {
		return nil
	}
	return m.deps.Backend.WorldArgs(dir)
}

// EnsureActive picks a world when none is configured yet, creating a default one
// on a fresh installation.
func (m *Manager) EnsureActive() (string, error) {
	settings := m.deps.Settings.Get()
	if settings.ActiveWorld != "" {
		if err := m.Validate(settings.ActiveWorld); err == nil {
			return settings.ActiveWorld, nil
		}
		m.log.Warn("configured active world is unusable", "world", settings.ActiveWorld)
	}
	list, err := m.List()
	if err != nil {
		return "", err
	}
	for _, w := range list {
		if w.Archived {
			continue
		}
		if err := m.Validate(w.ID); err == nil {
			if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = w.ID }); err != nil {
				return "", err
			}
			return w.ID, nil
		}
	}
	info, err := m.Create(CreateRequest{Name: "survival", Notes: "Created automatically on first start"}, "controller")
	if err != nil {
		return "", err
	}
	if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) { s.ActiveWorld = info.ID }); err != nil {
		return "", err
	}
	return info.ID, nil
}

// PrepareRuntime makes sure the active world's directories and the seed property
// are in place before launch.
func (m *Manager) PrepareRuntime() error {
	id, err := m.EnsureActive()
	if err != nil {
		return err
	}
	dir, err := m.dir(id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	meta, err := m.readMeta(id)
	if err != nil {
		return err
	}
	props, err := m.deps.Config.Properties()
	if err != nil {
		return err
	}
	changes := map[string]string{}
	if props.GetOr("level-name", "") != "world" {
		changes["level-name"] = "world"
	}
	// The seed only matters until the Overworld exists; after that level.dat owns
	// it and changing the property would be misleading.
	if _, err := os.Stat(filepath.Join(dir, "world", "level.dat")); os.IsNotExist(err) {
		if props.GetOr("level-seed", "") != meta.Seed {
			changes["level-seed"] = meta.Seed
		}
	}
	if len(changes) > 0 {
		if _, err := m.deps.Config.SetProperties(changes, "controller"); err != nil {
			return err
		}
	}
	if err := m.bindLevelLink(dir); err != nil {
		return err
	}
	if _, err := m.UpdateMeta(id, func(mt *Meta) { mt.LastPlayedAt = time.Now().UTC() }); err != nil {
		m.log.Warn("could not update world metadata", "error", err)
	}
	return nil
}

// bindLevelLink points the level directory in the runtime working directory at
// the active world set.
//
// This is for backends that only ever look next to their working directory and
// have no equivalent of --world-container: BTA, being a Beta 1.7.3 fork, is one.
// The link is inside /data and is written by the controller only, and the world
// data itself stays in the worlds directory, so backups, sizes and the trash all
// keep working on the real path.
//
// Anything that is already there and is not a link is left alone and reported:
// replacing a real directory here would be deleting a world.
func (m *Manager) bindLevelLink(worldSet string) error {
	if m.binding() != adapter.BindLevelLink {
		return nil
	}
	level := m.dimensions()[0]
	linkPath := filepath.Join(m.deps.Paths.Runtime(), level)
	target := filepath.Join(worldSet, level)
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}

	switch info, err := os.Lstat(linkPath); {
	case err == nil && info.Mode()&os.ModeSymlink != 0:
		current, err := os.Readlink(linkPath)
		if err == nil && current == target {
			return nil
		}
		if err := os.Remove(linkPath); err != nil {
			return fmt.Errorf("could not replace the level link: %w", err)
		}
	case err == nil && info.IsDir():
		entries, readErr := os.ReadDir(linkPath)
		if readErr != nil {
			return readErr
		}
		if len(entries) > 0 {
			return fmt.Errorf("%s already contains a level directory that the add-on did not create; "+
				"move it out of the way before switching worlds", linkPath)
		}
		if err := os.Remove(linkPath); err != nil {
			return err
		}
	case err == nil:
		return fmt.Errorf("%s exists and is not a directory", linkPath)
	case !os.IsNotExist(err):
		return err
	}

	if err := os.Symlink(target, linkPath); err != nil {
		return fmt.Errorf("could not point the server at %s: %w", worldSet, err)
	}
	return nil
}

func normalizeID(name string) string {
	id := strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ', r == '.':
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-_")
	if out == "" {
		out = fmt.Sprintf("world-%d", time.Now().Unix())
	}
	if len(out) > 48 {
		out = out[:48]
	}
	return out
}
