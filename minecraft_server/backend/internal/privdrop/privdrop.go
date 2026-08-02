// Package privdrop runs Minecraft as an unprivileged user.
//
// Home Assistant add-on containers run as root, and every Minecraft server warns
// loudly about that on each start - with reason: a plugin, a mod or a world
// exploit runs with whatever the server process has. The controller itself stays
// root (it needs to write /data and to signal the JVM), but the JVM it launches
// does not have to be.
package privdrop

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DefaultUID and DefaultGID match the "minecraft" user created in the image.
const (
	DefaultUID = 1000
	DefaultGID = 1000
)

// Account is the identity the server process runs as.
type Account struct {
	UID     int
	GID     int
	Enabled bool
	// Reason explains a disabled drop, for the log and the UI.
	Reason string
}

// Resolve decides whether the server can be dropped to an unprivileged user.
//
// It refuses when asked to (the add-on option), and when the controller is not
// root itself - during development the controller runs as an ordinary user and
// cannot change anyone's identity.
func Resolve(runAsRoot bool) Account {
	if runAsRoot {
		return Account{Reason: "run_server_as_root is enabled"}
	}
	if os.Geteuid() != 0 {
		return Account{Reason: "the controller is not running as root"}
	}
	uid := envInt("MC_SERVER_UID", DefaultUID)
	gid := envInt("MC_SERVER_GID", DefaultGID)
	if uid <= 0 || gid <= 0 {
		return Account{Reason: "no unprivileged uid is configured"}
	}
	return Account{UID: uid, GID: gid, Enabled: true}
}

func envInt(key string, fallback int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key))); err == nil {
		return v
	}
	return fallback
}

// Describe is what the UI shows.
func (a Account) Describe() string {
	if !a.Enabled {
		return "root (" + a.Reason + ")"
	}
	return fmt.Sprintf("uid %d", a.UID)
}

// EnsureOwned gives the account ownership of the paths the server writes to.
//
// The walk is skipped when the root of a tree already has the right owner, so
// this costs one stat per call once an installation has settled, rather than a
// walk of every world on every start.
func (a Account) EnsureOwned(paths ...string) error {
	if !a.Enabled {
		return nil
	}
	for _, path := range paths {
		if path == "" {
			continue
		}
		owned, err := a.owns(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if owned {
			continue
		}
		if err := a.chownTree(path); err != nil {
			return fmt.Errorf("give %s to uid %d: %w", path, a.UID, err)
		}
	}
	return nil
}

// EnsureOwnedFile changes one file's owner without walking anything.
func (a Account) EnsureOwnedFile(path string) error {
	if !a.Enabled || path == "" {
		return nil
	}
	if err := chownPath(path, a.UID, a.GID); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (a Account) chownTree(root string) error {
	return filepath.WalkDir(root, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		// The link is retargeted rather than its target: the level link points
		// into the worlds directory, which is given away in its own right.
		return chownPath(path, a.UID, a.GID)
	})
}
