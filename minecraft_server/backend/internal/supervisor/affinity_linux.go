//go:build linux

package supervisor

import (
	"os/exec"
	"runtime"

	"golang.org/x/sys/unix"
)

// startPinned starts cmd with the child confined to a set of CPUs.
//
// The obvious implementation - start, then sched_setaffinity(childPid) - fails
// with EPERM: the server runs as an unprivileged user, and changing another
// user's affinity needs CAP_SYS_NICE, which container runtimes drop. Wrapping
// the launch in taskset fails differently: the Home Assistant base image ships
// no util-linux.
//
// So the mask is set on the launching thread instead, which any process may do
// to itself, and the child inherits it across fork and keeps it across exec.
// The thread is locked for the duration so the fork really happens on the
// thread that carries the mask, and the controller's own mask is restored
// immediately afterwards - the controller stays free to use every core.
func startPinned(cmd *exec.Cmd, cpus []int) error {
	if len(cpus) == 0 {
		return cmd.Start()
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	var saved unix.CPUSet
	if err := unix.SchedGetaffinity(0, &saved); err != nil {
		// Without a mask to restore, pinning is not worth the risk of leaving
		// the controller confined.
		return cmd.Start()
	}
	var set unix.CPUSet
	set.Zero()
	for _, cpu := range cpus {
		set.Set(cpu)
	}
	if err := unix.SchedSetaffinity(0, &set); err != nil {
		return cmd.Start()
	}
	defer func() { _ = unix.SchedSetaffinity(0, &saved) }()
	return cmd.Start()
}

// pinningSupported reports whether this build can pin at all.
func pinningSupported() bool { return true }
