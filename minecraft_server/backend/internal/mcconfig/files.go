package mcconfig

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

var (
	ErrUnknownFile = errors.New("this configuration file is not editable")
	ErrTooLarge    = errors.New("configuration file is too large")
)

// maxFileSize caps both reads and writes. Paper's own files are a few tens of
// kilobytes; a megabyte is generous and stops a mistake from eating memory.
const maxFileSize = 1 << 20

const snapshotsPerFile = 20

// FileInfo describes an editable file for the UI.
type FileInfo struct {
	Name            string `json:"name"`
	RelPath         string `json:"rel_path"`
	Format          string `json:"format"`
	Description     string `json:"description"`
	RestartRequired bool   `json:"restart_required"`
	Exists          bool   `json:"exists"`
	SizeBytes       int64  `json:"size_bytes"`
	ModifiedAt      string `json:"modified_at"`
	SHA256          string `json:"sha256"`
}

type Manager struct {
	paths   appcfg.Paths
	backend adapter.Backend
	store   *store.Store
	bus     *events.Bus
	log     *slog.Logger

	mu sync.Mutex
}

func NewManager(paths appcfg.Paths, backend adapter.Backend, st *store.Store, bus *events.Bus, log *slog.Logger) *Manager {
	if log == nil {
		log = slog.Default()
	}
	return &Manager{
		paths:   paths,
		backend: backend,
		store:   st,
		bus:     bus,
		log:     log.With("component", "mcconfig"),
	}
}

// allowed is the editable-file table of the active flavour. It is rebuilt on
// every use rather than cached: the backend can be switched at runtime, and a
// cached table would let one flavour's file names resolve against the other's
// runtime directory.
func (m *Manager) allowed() map[string]adapter.ConfigFile {
	files := m.backend.ConfigFiles()
	out := make(map[string]adapter.ConfigFile, len(files))
	for _, f := range files {
		out[f.Name] = f
	}
	return out
}

// resolve maps an allow-listed name onto an absolute path. Names are looked up in
// a fixed table, so no user-supplied path ever reaches the filesystem.
func (m *Manager) resolve(name string) (adapter.ConfigFile, string, error) {
	spec, ok := m.allowed()[name]
	if !ok {
		return adapter.ConfigFile{}, "", fmt.Errorf("%w: %s", ErrUnknownFile, name)
	}
	full, err := appcfg.Confine(m.paths.Runtime(), spec.RelPath)
	if err != nil {
		return spec, "", err
	}
	return spec, full, nil
}

func (m *Manager) List() []FileInfo {
	allowed := m.allowed()
	names := make([]string, 0, len(allowed))
	for name := range allowed {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]FileInfo, 0, len(names))
	for _, name := range names {
		spec, full, err := m.resolve(name)
		if err != nil {
			continue
		}
		info := FileInfo{
			Name:            spec.Name,
			RelPath:         spec.RelPath,
			Format:          spec.Format,
			Description:     spec.Description,
			RestartRequired: spec.RestartRequired,
		}
		if st, err := os.Stat(full); err == nil {
			info.Exists = true
			info.SizeBytes = st.Size()
			info.ModifiedAt = st.ModTime().UTC().Format(time.RFC3339)
			if raw, err := os.ReadFile(full); err == nil {
				sum := sha256.Sum256(raw)
				info.SHA256 = hex.EncodeToString(sum[:])
			}
		}
		out = append(out, info)
	}
	return out
}

// Read returns the raw content of an allow-listed file.
func (m *Manager) Read(name string) (FileInfo, string, error) {
	spec, full, err := m.resolve(name)
	if err != nil {
		return FileInfo{}, "", err
	}
	info := FileInfo{
		Name: spec.Name, RelPath: spec.RelPath, Format: spec.Format,
		Description: spec.Description, RestartRequired: spec.RestartRequired,
	}
	raw, err := os.ReadFile(full)
	if err != nil {
		if os.IsNotExist(err) {
			// A file Paper has not written yet is reported as empty rather than
			// as an error, so the editor can create it.
			return info, "", nil
		}
		return info, "", err
	}
	if len(raw) > maxFileSize {
		return info, "", ErrTooLarge
	}
	st, _ := os.Stat(full)
	sum := sha256.Sum256(raw)
	info.Exists = true
	info.SHA256 = hex.EncodeToString(sum[:])
	if st != nil {
		info.SizeBytes = st.Size()
		info.ModifiedAt = st.ModTime().UTC().Format(time.RFC3339)
	}
	return info, string(raw), nil
}

// WriteResult tells the caller what happened and whether Minecraft must be
// restarted for the change to take effect.
type WriteResult struct {
	Name            string `json:"name"`
	SnapshotPath    string `json:"snapshot_path"`
	RestartRequired bool   `json:"restart_required"`
	SHA256          string `json:"sha256"`
	Unchanged       bool   `json:"unchanged"`
}

// Write validates, snapshots and atomically replaces a configuration file.
//
// Order matters: validation first (never snapshot a file to accept garbage),
// then the snapshot (so a bad but valid change can be undone), then the atomic
// replace, then the audit entry.
func (m *Manager) Write(name, content, actor string) (WriteResult, error) {
	spec, full, err := m.resolve(name)
	if err != nil {
		return WriteResult{}, err
	}
	if len(content) > maxFileSize {
		return WriteResult{}, ErrTooLarge
	}
	raw := []byte(normalizeNewlines(content))
	if err := Validate(spec.Format, raw); err != nil {
		return WriteResult{}, fmt.Errorf("%s: %w", name, err)
	}

	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	if existing, err := os.ReadFile(full); err == nil {
		if existingSum := sha256.Sum256(existing); hex.EncodeToString(existingSum[:]) == digest {
			return WriteResult{Name: name, RestartRequired: false, SHA256: digest, Unchanged: true}, nil
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	journalID, jErr := m.store.JournalBegin(store.OpConfigWrite, "validate", map[string]any{
		"file": name, "actor": actor,
	})
	if jErr != nil {
		m.log.Warn("could not open journal entry", "error", jErr)
	}

	snapshot, err := m.snapshot(name, full)
	if err != nil {
		_ = m.store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return WriteResult{}, fmt.Errorf("snapshot %s: %w", name, err)
	}
	_ = m.store.JournalPhase(journalID, "write", map[string]any{"snapshot": snapshot})

	if err := atomicfs.WriteFile(full, raw, 0o644); err != nil {
		_ = m.store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return WriteResult{}, err
	}
	_ = m.store.JournalEnd(journalID, store.JournalDone, "")

	_ = m.store.Audit(store.AuditEntry{
		Actor:  actor,
		Action: "config.write",
		Target: name,
		Detail: fmt.Sprintf("bytes=%d sha256=%s snapshot=%s", len(raw), digest[:12], filepath.Base(snapshot)),
	})
	m.bus.Publish(events.TypeConfigChanged, map[string]any{
		"file": name, "restart_required": spec.RestartRequired,
	})
	return WriteResult{
		Name:            name,
		SnapshotPath:    snapshot,
		RestartRequired: spec.RestartRequired,
		SHA256:          digest,
	}, nil
}

// snapshot copies the current file into /data/config/snapshots. Missing files
// produce no snapshot, which is not an error: creating whitelist.json for the
// first time is normal.
func (m *Manager) snapshot(name, full string) (string, error) {
	if _, err := os.Stat(full); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if err := os.MkdirAll(m.paths.ConfigSnapshots(), 0o755); err != nil {
		return "", err
	}
	dst := filepath.Join(m.paths.ConfigSnapshots(),
		fmt.Sprintf("%s.%s.bak", sanitizeSnapshotName(name), time.Now().UTC().Format("20060102T150405")))
	if err := atomicfs.CopyFile(full, dst); err != nil {
		return "", err
	}
	m.pruneSnapshots(name)
	return dst, nil
}

func (m *Manager) pruneSnapshots(name string) {
	prefix := sanitizeSnapshotName(name) + "."
	entries, err := os.ReadDir(m.paths.ConfigSnapshots())
	if err != nil {
		return
	}
	var matching []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), prefix) {
			matching = append(matching, e.Name())
		}
	}
	if len(matching) <= snapshotsPerFile {
		return
	}
	sort.Strings(matching)
	for _, old := range matching[:len(matching)-snapshotsPerFile] {
		_ = os.Remove(filepath.Join(m.paths.ConfigSnapshots(), old))
	}
}

func sanitizeSnapshotName(name string) string {
	return strings.NewReplacer("/", "_", "\\", "_", string(filepath.Separator), "_").Replace(name)
}

// Snapshots lists the available snapshots of a file, newest first.
func (m *Manager) Snapshots(name string) ([]string, error) {
	if _, _, err := m.resolve(name); err != nil {
		return nil, err
	}
	prefix := sanitizeSnapshotName(name) + "."
	entries, err := os.ReadDir(m.paths.ConfigSnapshots())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), prefix) {
			out = append(out, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(out)))
	return out, nil
}

// RestoreSnapshot puts a snapshot back, taking a snapshot of the current content
// first so the restore itself is reversible.
func (m *Manager) RestoreSnapshot(name, snapshotName, actor string) (WriteResult, error) {
	if err := atomicfs.SafeName(snapshotName); err != nil {
		return WriteResult{}, fmt.Errorf("invalid snapshot name: %w", err)
	}
	snapPath, err := appcfg.Confine(m.paths.ConfigSnapshots(), snapshotName)
	if err != nil {
		return WriteResult{}, err
	}
	raw, err := os.ReadFile(snapPath)
	if err != nil {
		return WriteResult{}, err
	}
	return m.Write(name, string(raw), actor)
}

// Validate parses content according to its declared format.
func Validate(format string, raw []byte) error {
	switch format {
	case "properties":
		return ValidateProperties(raw)
	case "yaml":
		var out any
		if err := yaml.Unmarshal(raw, &out); err != nil {
			return fmt.Errorf("invalid YAML: %w", err)
		}
		return nil
	case "lines":
		// One entry per line, which is how a Beta-era server keeps its operator
		// and whitelist files. There is nothing to parse; the only thing worth
		// refusing is a NUL byte, which means the file is not text at all.
		if bytes.IndexByte(raw, 0) >= 0 {
			return errors.New("this file must be plain text, one entry per line")
		}
		return nil
	case "json":
		if len(strings.TrimSpace(string(raw))) == 0 {
			return errors.New("JSON file must not be empty (use [] or {})")
		}
		var out any
		if err := json.Unmarshal(raw, &out); err != nil {
			return fmt.Errorf("invalid JSON: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unsupported format %q", format)
	}
}

func normalizeNewlines(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	if s != "" && !strings.HasSuffix(s, "\n") {
		s += "\n"
	}
	return s
}

// ---------------------------------------------------------------- properties --

// Properties loads the backend's main key/value file.
func (m *Manager) Properties() (*Properties, error) {
	_, content, err := m.Read(m.backend.PropertiesFile())
	if err != nil {
		return nil, err
	}
	return ParseProperties([]byte(content)), nil
}

// SetProperties applies a set of key/value changes to the properties file in one
// validated, snapshotted, atomic write. Unknown keys are allowed (Paper adds new
// ones over time) but keys and values are checked for shape.
func (m *Manager) SetProperties(changes map[string]string, actor string) (WriteResult, error) {
	props, err := m.Properties()
	if err != nil {
		return WriteResult{}, err
	}
	keys := make([]string, 0, len(changes))
	for k := range changes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !keyPattern.MatchString(k) {
			return WriteResult{}, fmt.Errorf("invalid property key %q", k)
		}
		v := changes[k]
		if strings.ContainsAny(v, "\n\r\x00") {
			return WriteResult{}, fmt.Errorf("value for %q contains a line break", k)
		}
		props.Set(k, v)
	}
	return m.Write(m.backend.PropertiesFile(), string(props.Bytes()), actor)
}

// EnsureDefaults writes any missing default property, used on first start.
//
// enforced holds values the controller owns rather than seeds - the listen port
// for a backend that has no launch argument for it - and is written even when the
// key already exists.
func (m *Manager) EnsureDefaults(actor string, enforced map[string]string) error {
	props, err := m.Properties()
	if err != nil {
		return err
	}
	changed := map[string]string{}
	for k, v := range m.backend.DefaultProperties() {
		if _, ok := props.Get(k); !ok {
			changed[k] = v
		}
	}
	for k, v := range enforced {
		if current, ok := props.Get(k); !ok || current != v {
			changed[k] = v
		}
	}
	if len(changed) == 0 {
		return nil
	}
	_, err = m.SetProperties(changed, actor)
	return err
}
