// Package appcfg loads add-on options, owns the persistent controller settings
// and describes the on-disk layout below /data.
package appcfg

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// DefaultFlavour is the server flavour an installation that predates multi
// flavour support is on, and the one a new installation starts with.
const DefaultFlavour = "paper"

// flavourRef is shared by every copy of a Paths value. Paths is passed around by
// value, so the active flavour has to live behind a pointer for a switch to
// reach the managers that were handed a copy at construction time.
type flavourRef struct {
	mu      sync.RWMutex
	name    string
	jarName string
}

// Paths is the canonical /data layout. Every other package resolves files
// through this struct so no path is ever assembled from user input.
//
// The parts that belong to one server flavour - the runtime directory, the
// server JAR and the worlds - are nested under the flavour name so two flavours
// can be installed side by side without their world formats ever meeting.
type Paths struct {
	Data    string
	flavour *flavourRef
}

func NewPaths(data string) Paths {
	return Paths{
		Data:    filepath.Clean(data),
		flavour: &flavourRef{name: DefaultFlavour, jarName: DefaultFlavour + ".jar"},
	}
}

// Flavour is the active server flavour.
func (p Paths) Flavour() string {
	if p.flavour == nil {
		return DefaultFlavour
	}
	p.flavour.mu.RLock()
	defer p.flavour.mu.RUnlock()
	return p.flavour.name
}

// SetFlavour points every copy of this Paths value at another flavour. It is
// only ever called while Minecraft is stopped: the caller holds the supervisor
// lease, and EnsureLayout has to be run afterwards.
func (p Paths) SetFlavour(name, jarName string) {
	if p.flavour == nil || name == "" {
		return
	}
	p.flavour.mu.Lock()
	defer p.flavour.mu.Unlock()
	p.flavour.name = name
	p.flavour.jarName = jarName
}

func (p Paths) jarName() string {
	if p.flavour == nil {
		return DefaultFlavour + ".jar"
	}
	p.flavour.mu.RLock()
	defer p.flavour.mu.RUnlock()
	if p.flavour.jarName == "" {
		return p.flavour.name + ".jar"
	}
	return p.flavour.jarName
}

func (p Paths) join(parts ...string) string {
	return filepath.Join(append([]string{p.Data}, parts...)...)
}

// Runtime is the working directory of the Minecraft process.
func (p Paths) Runtime() string     { return p.join("runtime", p.Flavour()) }
func (p Paths) RuntimeLogs() string { return filepath.Join(p.Runtime(), "logs") }
func (p Paths) Plugins() string     { return filepath.Join(p.Runtime(), "plugins") }
func (p Paths) ServerJar() string   { return filepath.Join(p.Runtime(), p.jarName()) }
func (p Paths) EulaFile() string    { return filepath.Join(p.Runtime(), "eula.txt") }

// HasServerJar reports whether another flavour already has a server installed,
// without making it active.
func (p Paths) HasServerJar(flavour, jarName string) bool {
	if flavour == "" || jarName == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(p.join("runtime", flavour), jarName))
	return err == nil
}

// WorldsRoot holds one directory per flavour.
func (p Paths) WorldsRoot() string      { return p.join("worlds") }
func (p Paths) Worlds() string          { return filepath.Join(p.WorldsRoot(), p.Flavour()) }
func (p Paths) World(id string) string  { return filepath.Join(p.Worlds(), id) }
func (p Paths) Backups() string         { return p.join("backups") }
func (p Paths) ResticRepo() string      { return filepath.Join(p.Backups(), "repo") }
func (p Paths) Staging() string         { return p.join("staging") }
func (p Paths) Presets() string         { return p.join("presets") }
func (p Paths) Config() string          { return p.join("config") }
func (p Paths) ConfigSnapshots() string { return filepath.Join(p.Config(), "snapshots") }
func (p Paths) SettingsFile() string    { return filepath.Join(p.Config(), "settings.json") }
func (p Paths) Trash() string           { return p.join("trash") }
func (p Paths) Jars() string            { return p.join("jars") }
func (p Paths) Secrets() string         { return p.join("secrets") }
func (p Paths) Run() string             { return p.join("run") }
func (p Paths) BridgeSocket() string    { return filepath.Join(p.Run(), "bridge.sock") }
func (p Paths) PidFile() string         { return filepath.Join(p.Run(), "minecraft.pid") }
func (p Paths) Audit() string           { return p.join("audit") }
func (p Paths) AuditLog() string        { return filepath.Join(p.Audit(), "audit.log") }
func (p Paths) Database() string        { return p.join("controller.db") }
func (p Paths) ResticPassword() string  { return filepath.Join(p.Secrets(), "restic.pass") }
func (p Paths) BridgeToken() string     { return filepath.Join(p.Secrets(), "bridge.token") }

// EnsureLayout creates every directory the controller relies on. Secret and run
// directories are private; the rest inherit the /data permissions.
func (p Paths) EnsureLayout() error {
	dirs := []struct {
		path string
		mode os.FileMode
	}{
		{p.Runtime(), 0o755},
		{p.RuntimeLogs(), 0o755},
		{p.Plugins(), 0o755},
		{p.WorldsRoot(), 0o755},
		{p.Worlds(), 0o755},
		{p.Backups(), 0o755},
		{p.Staging(), 0o755},
		{p.Presets(), 0o755},
		{p.Config(), 0o755},
		{p.ConfigSnapshots(), 0o755},
		{p.Trash(), 0o755},
		{p.Jars(), 0o755},
		{p.Audit(), 0o755},
		{p.Secrets(), 0o700},
		{p.Run(), 0o700},
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d.path, d.mode); err != nil {
			return err
		}
		// MkdirAll honours umask; force the mode we asked for.
		if err := os.Chmod(d.path, d.mode); err != nil {
			return err
		}
	}
	return nil
}

// layoutMarker records which /data layout is on disk. Its absence means the
// pre-flavour layout, where worlds and the runtime directory were not nested
// under a flavour name.
const layoutMarker = ".layout"

// MigrateLayout moves an installation created before multi-flavour support into
// the nested layout. It is a rename of two directories, it happens before
// anything else touches /data, and it is a no-op once the marker exists.
//
// Everything that existed before was PaperMC, so that is where it goes.
func (p Paths) MigrateLayout() (bool, error) {
	marker := filepath.Join(p.WorldsRoot(), layoutMarker)
	if _, err := os.Stat(marker); err == nil {
		return false, nil
	}
	moved := false

	// /data/worlds/<id> -> /data/worlds/paper/<id>
	entries, err := os.ReadDir(p.WorldsRoot())
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	legacy := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || e.Name() == DefaultFlavour {
			continue
		}
		legacy = append(legacy, e.Name())
	}
	if len(legacy) > 0 {
		target := filepath.Join(p.WorldsRoot(), DefaultFlavour)
		if err := os.MkdirAll(target, 0o755); err != nil {
			return false, err
		}
		for _, name := range legacy {
			from := filepath.Join(p.WorldsRoot(), name)
			to := filepath.Join(target, name)
			if _, err := os.Stat(to); err == nil {
				// Already migrated under the same name; leave both alone rather
				// than merging two world directories.
				continue
			}
			if err := os.Rename(from, to); err != nil {
				return moved, fmt.Errorf("move world %q into the paper layout: %w", name, err)
			}
			moved = true
		}
	}

	if err := os.MkdirAll(p.WorldsRoot(), 0o755); err != nil {
		return moved, err
	}
	if err := os.WriteFile(marker, []byte("flavour-nested\n"), 0o644); err != nil {
		return moved, err
	}
	return moved, nil
}

// ErrUnsafePath is returned for any path that escapes its intended root.
var ErrUnsafePath = errors.New("unsafe path")

// Confine resolves rel below root and fails if the result escapes root. It also
// rejects absolute inputs, traversal segments and NUL bytes. Symlinks are
// checked by the caller (see atomicfs.NoSymlinks) because the target may not
// exist yet.
func Confine(root, rel string) (string, error) {
	if rel == "" {
		return "", ErrUnsafePath
	}
	if strings.ContainsRune(rel, 0) {
		return "", ErrUnsafePath
	}
	rel = strings.ReplaceAll(rel, "\\", "/")
	if strings.HasPrefix(rel, "/") || filepath.IsAbs(rel) {
		return "", ErrUnsafePath
	}
	// A drive-letter prefix is never a legitimate relative name. VolumeName only
	// recognises one on Windows, so it is checked here as well: the add-on runs on
	// Linux, and "C:/Windows/System32" would otherwise be accepted there as an
	// ordinary relative path.
	if vol := filepath.VolumeName(rel); vol != "" {
		return "", ErrUnsafePath
	}
	if len(rel) >= 2 && rel[1] == ':' {
		return "", ErrUnsafePath
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".." {
			return "", ErrUnsafePath
		}
	}
	root = filepath.Clean(root)
	full := filepath.Clean(filepath.Join(root, filepath.FromSlash(rel)))
	if full != root && !strings.HasPrefix(full, root+string(filepath.Separator)) {
		return "", ErrUnsafePath
	}
	return full, nil
}
