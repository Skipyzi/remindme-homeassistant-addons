//go:build windows

package supervisor

import (
	"os"
	"syscall"
)

// Windows is a development-only target: the add-on itself always runs on Linux.
// Process groups and POSIX signals do not exist here, so termination falls back
// to TerminateProcess.

func sysProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{} }

func terminateProcess(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}

func killProcess(pid int) error { return terminateProcess(pid) }

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := syscall.OpenProcess(syscall.PROCESS_QUERY_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle)
	var code uint32
	if err := syscall.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}
