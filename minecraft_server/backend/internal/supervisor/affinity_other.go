//go:build !linux

package supervisor

import "os/exec"

// CPU affinity is a Linux concept; development hosts start unpinned.
func startPinned(cmd *exec.Cmd, _ []int) error { return cmd.Start() }

func pinningSupported() bool { return false }
