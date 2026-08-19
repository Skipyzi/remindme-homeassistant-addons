//go:build !linux

package stats

// storageKind is Linux-only; development hosts report unknown.
func storageKind(string) string { return "" }
