//go:build !windows

package privdrop

import (
	"os"
	"syscall"
)

// owns reports whether path already belongs to the account, which is what makes
// EnsureOwned cheap on every start after the first.
func (a Account) owns(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false, nil
	}
	return int(st.Uid) == a.UID && int(st.Gid) == a.GID, nil
}

func chownPath(path string, uid, gid int) error { return os.Lchown(path, uid, gid) }
