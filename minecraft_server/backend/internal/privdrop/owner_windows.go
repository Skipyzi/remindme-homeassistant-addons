//go:build windows

package privdrop

import "os"

// Windows is a development-only target: the add-on always runs on Linux, and
// Resolve never enables the drop off root, so these are never reached.

func (a Account) owns(path string) (bool, error) {
	if _, err := os.Lstat(path); err != nil {
		return false, err
	}
	return true, nil
}

func chownPath(string, int, int) error { return nil }
