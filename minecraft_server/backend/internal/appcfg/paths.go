// Package appcfg loads add-on options, owns the persistent controller settings
// and describes the on-disk layout below /data.
package appcfg

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Paths is the canonical /data layout. Every other package resolves files
// through this struct so no path is ever assembled from user input.
type Paths struct {
	Data string
}

func NewPaths(data string) Paths { return Paths{Data: filepath.Clean(data)} }

func (p Paths) join(parts ...string) string {
	return filepath.Join(append([]string{p.Data}, parts...)...)
}

// Runtime is the working directory of the Minecraft process.
func (p Paths) Runtime() string     { return p.join("runtime", "paper") }
func (p Paths) RuntimeLogs() string { return filepath.Join(p.Runtime(), "logs") }
func (p Paths) Plugins() string     { return filepath.Join(p.Runtime(), "plugins") }
func (p Paths) ServerJar() string   { return filepath.Join(p.Runtime(), "paper.jar") }
func (p Paths) EulaFile() string    { return filepath.Join(p.Runtime(), "eula.txt") }

func (p Paths) Worlds() string          { return p.join("worlds") }
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
	if vol := filepath.VolumeName(rel); vol != "" {
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
