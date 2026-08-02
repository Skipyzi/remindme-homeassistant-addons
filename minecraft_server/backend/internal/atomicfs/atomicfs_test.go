package atomicfs

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWriteFileIsAtomicAndLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "server.properties")

	if err := WriteFile(target, []byte("view-distance=7\n"), 0o644); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := WriteFile(target, []byte("view-distance=5\n"), 0o644); err != nil {
		t.Fatalf("second write: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "view-distance=5\n" {
		t.Fatalf("unexpected content %q", got)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("expected only the target file, found %v", names)
	}
}

func TestReplaceDirKeepsPreviousCopyAndRollsBack(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "world")
	staged := filepath.Join(root, "staged")

	mustMkdirWithFile(t, target, "level.dat", "original")
	mustMkdirWithFile(t, staged, "level.dat", "restored")

	aside, err := ReplaceDir(staged, target)
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if aside == "" {
		t.Fatal("expected the previous copy to be kept")
	}
	if got := readFile(t, filepath.Join(target, "level.dat")); got != "restored" {
		t.Fatalf("target not replaced, got %q", got)
	}
	if got := readFile(t, filepath.Join(aside, "level.dat")); got != "original" {
		t.Fatalf("previous copy lost, got %q", got)
	}

	// Simulate a failed health check: the previous world must come back exactly.
	if err := RestoreAside(aside, target); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if got := readFile(t, filepath.Join(target, "level.dat")); got != "original" {
		t.Fatalf("rollback did not restore the original, got %q", got)
	}
}

func TestHardlinkTreeSharesDataAndSkipsSymlinks(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "world")
	dst := filepath.Join(root, "snapshot")
	mustMkdirWithFile(t, filepath.Join(src, "region"), "r.0.0.mca", "chunkdata")

	if runtime.GOOS != "windows" {
		if err := os.Symlink(filepath.Join(src, "region", "r.0.0.mca"),
			filepath.Join(src, "region", "link.mca")); err != nil {
			t.Fatalf("symlink: %v", err)
		}
	}

	linked, copied, err := HardlinkTree(src, dst)
	if err != nil {
		t.Fatalf("hardlink tree: %v", err)
	}
	if linked+copied != 1 {
		t.Fatalf("expected exactly one regular file, linked=%d copied=%d", linked, copied)
	}
	if _, err := os.Lstat(filepath.Join(dst, "region", "link.mca")); err == nil {
		t.Fatal("the symlink should not have been copied into the snapshot")
	}

	// A hardlink shares content: writing through the original is visible in the
	// snapshot, which is why the world must be flushed before linking.
	if linked == 1 {
		info1, err := os.Stat(filepath.Join(src, "region", "r.0.0.mca"))
		if err != nil {
			t.Fatal(err)
		}
		info2, err := os.Stat(filepath.Join(dst, "region", "r.0.0.mca"))
		if err != nil {
			t.Fatal(err)
		}
		if !os.SameFile(info1, info2) {
			t.Fatal("expected the snapshot entry to be the same file")
		}
	}
}

func TestNoSymlinksRejectsLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	root := t.TempDir()
	mustMkdirWithFile(t, root, "level.dat", "x")
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "sneaky")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	err := NoSymlinks(root)
	if !errors.Is(err, ErrSymlinkFound) {
		t.Fatalf("expected ErrSymlinkFound, got %v", err)
	}
}

func TestSafeName(t *testing.T) {
	valid := []string{"survival", "world-2", "my_world.backup", "a"}
	for _, name := range valid {
		if err := SafeName(name); err != nil {
			t.Errorf("SafeName(%q) rejected a valid name: %v", name, err)
		}
	}
	invalid := []string{"", "..", ".hidden", "with space", "slash/name", "back\\slash",
		"nul\x00", "con", string(make([]byte, 65))}
	for _, name := range invalid {
		if err := SafeName(name); err == nil {
			t.Errorf("SafeName(%q) accepted an unsafe name", name)
		}
	}
}

func TestDirSizeIgnoresMissingDirectories(t *testing.T) {
	bytes, files, err := DirSize(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if bytes != 0 || files != 0 {
		t.Fatalf("expected zero for a missing directory, got %d bytes in %d files", bytes, files)
	}
}

func mustMkdirWithFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}
