//go:build !windows

package supervisor

import (
	"os"
	"syscall"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/privdrop"
)

// sysProcAttr puts Minecraft in its own process group so the controller can
// signal the JVM and anything it spawned as a unit, and drops it to an
// unprivileged user when one is configured.
func sysProcAttr(account privdrop.Account) *syscall.SysProcAttr {
	attr := &syscall.SysProcAttr{Setpgid: true}
	if account.Enabled {
		attr.Credential = &syscall.Credential{
			Uid: uint32(account.UID),
			Gid: uint32(account.GID),
		}
	}
	return attr
}

func signalGroup(pid int, sig syscall.Signal) error {
	// Negative pid targets the whole process group.
	if err := syscall.Kill(-pid, sig); err != nil {
		return syscall.Kill(pid, sig)
	}
	return nil
}

func terminateProcess(pid int) error { return signalGroup(pid, syscall.SIGTERM) }
func killProcess(pid int) error      { return signalGroup(pid, syscall.SIGKILL) }

// processAlive reports whether a pid exists. Signal 0 performs the permission and
// existence check without delivering anything.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}
