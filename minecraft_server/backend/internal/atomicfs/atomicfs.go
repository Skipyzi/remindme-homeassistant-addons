// Package atomicfs provides the filesystem primitives the controller needs to
// survive being killed at any moment: temp-file writes followed by rename,
// directory swaps with rollback, hardlink snapshots and cross-device moves.
package atomicfs

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// WriteFile writes data to path atomically: a temporary file in the same
// directory is written, flushed to disk, then renamed over the destination.
// Readers therefore see either the old or the new file, never a partial one.
func WriteFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	tmpName = ""
	return syncDir(dir)
}

// syncDir flushes a directory entry so the rename itself is durable. Not
// supported on Windows, where it is a no-op.
func syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		// Some filesystems refuse fsync on directories; the rename is still
		// ordered, so this must not fail the operation.
		return nil
	}
	return nil
}

// TempName returns a timestamped sibling name, used for staging and backups of
// directories that are about to be replaced.
func TempName(path, suffix string) string {
	return fmt.Sprintf("%s.%s.%d", path, suffix, time.Now().UnixNano())
}

// ReplaceDir atomically swaps target with staged.
//
// The sequence is: move target aside, move staged into place, and on any failure
// move the original back. The kept-aside copy is returned so the caller can
// delete it after the operation is confirmed, or restore from it later.
func ReplaceDir(staged, target string) (asideDir string, err error) {
	if _, err := os.Stat(staged); err != nil {
		return "", fmt.Errorf("staged directory unusable: %w", err)
	}
	if _, err := os.Stat(target); err == nil {
		aside := TempName(target, "previous")
		if err := os.Rename(target, aside); err != nil {
			return "", fmt.Errorf("move current aside: %w", err)
		}
		asideDir = aside
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(staged, target); err != nil {
		if asideDir != "" {
			if rbErr := os.Rename(asideDir, target); rbErr != nil {
				return asideDir, fmt.Errorf("install staged copy failed (%v) and rollback failed (%v)", err, rbErr)
			}
		}
		return "", fmt.Errorf("install staged copy: %w", err)
	}
	return asideDir, syncDir(filepath.Dir(target))
}

// RestoreAside undoes ReplaceDir by putting the kept-aside directory back.
func RestoreAside(asideDir, target string) error {
	if asideDir == "" {
		return errors.New("no previous copy to restore")
	}
	broken := TempName(target, "failed")
	if _, err := os.Stat(target); err == nil {
		if err := os.Rename(target, broken); err != nil {
			return fmt.Errorf("move failed copy aside: %w", err)
		}
	}
	if err := os.Rename(asideDir, target); err != nil {
		return fmt.Errorf("restore previous copy: %w", err)
	}
	_ = os.RemoveAll(broken)
	return nil
}

// HardlinkTree creates a copy of src at dst where regular files are hardlinks.
// This is how a multi-gigabyte world is "snapshotted" in milliseconds while
// Minecraft has saving disabled. Files that cannot be linked (different device)
// are copied. Symlinks are skipped deliberately: a snapshot must never follow a
// link out of the world directory.
func HardlinkTree(src, dst string) (linked int, copied int, err error) {
	err = filepath.WalkDir(src, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			info, err := d.Info()
			if err != nil {
				return err
			}
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		case d.Type()&fs.ModeSymlink != 0:
			return nil
		case !d.Type().IsRegular():
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.Link(path, target); err == nil {
			linked++
			return nil
		}
		if err := CopyFile(path, target); err != nil {
			return err
		}
		copied++
		return nil
	})
	return linked, copied, err
}

// CopyTree copies a directory recursively, skipping symlinks.
func CopyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o755)
		case d.Type()&fs.ModeSymlink != 0, !d.Type().IsRegular():
			return nil
		}
		return CopyFile(path, target)
	})
}

func CopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// MoveDir renames src to dst, falling back to copy+delete across devices.
func MoveDir(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := CopyTree(src, dst); err != nil {
		_ = os.RemoveAll(dst)
		return err
	}
	return os.RemoveAll(src)
}

// DirSize sums the apparent size of all regular files below root. Symlinks are
// not followed. Missing directories report zero rather than an error because
// sizes are advisory.
func DirSize(root string) (bytes int64, files int64, err error) {
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if d.IsDir() || d.Type()&fs.ModeSymlink != 0 || !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		bytes += info.Size()
		files++
		return nil
	})
	if err != nil && os.IsNotExist(err) {
		return 0, 0, nil
	}
	return bytes, files, err
}

// ErrSymlinkFound reports an unexpected link inside a tree that must be plain
// files and directories (an imported world, for example).
var ErrSymlinkFound = errors.New("archive or directory contains a symbolic link")

// NoSymlinks walks root and fails on the first link, device node or socket.
func NoSymlinks(root string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() || d.Type().IsRegular() {
			return nil
		}
		return fmt.Errorf("%w: %s", ErrSymlinkFound, path)
	})
}

// SafeName validates identifiers that become directory names (worlds, presets).
// Allowed: letters, digits, dash, underscore and dot, 1-64 characters, no
// leading dot and no reserved names.
func SafeName(name string) error {
	if name == "" || len(name) > 64 {
		return fmt.Errorf("name must be 1-64 characters")
	}
	if strings.HasPrefix(name, ".") {
		return fmt.Errorf("name must not start with a dot")
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.':
		default:
			return fmt.Errorf("name may only contain letters, digits, '-', '_' and '.'")
		}
	}
	switch strings.ToLower(name) {
	case "con", "prn", "aux", "nul", "..", ".":
		return fmt.Errorf("%q is a reserved name", name)
	}
	return nil
}
