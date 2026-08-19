//go:build linux

package stats

// storageKind classifies the block device behind a path: SD cards are the
// classic Pi smoothness killer, and the dashboard should say so rather than
// leave the operator to guess why evenings stutter.
func storageKind(path string) string {
	return classifyDevice(deviceFor(path, "/proc/mounts"), "/sys/block")
}
