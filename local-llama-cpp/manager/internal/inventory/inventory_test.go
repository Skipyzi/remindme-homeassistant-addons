package inventory

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestScanFindsManagedAndLegacyGGUFWithoutLeakingPaths(t *testing.T) {
	base := t.TempDir()
	models := filepath.Join(base, "models")
	cache := filepath.Join(base, ".cache", "llama.cpp")
	managed := filepath.Join(models, "known.gguf")
	legacy := filepath.Join(cache, "old.gguf")
	writeFile(t, managed, []byte("GGUFmanaged"))
	writeFile(t, legacy, []byte("GGUFlegacy"))

	result, err := (Scanner{Roots: []Root{
		{Path: models, Source: SourceManaged},
		{Path: filepath.Join(base, ".cache"), Source: SourceLegacyCache},
	}}).Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 {
		t.Fatalf("items = %d", len(result.Items))
	}
	if result.Items[0].Source != SourceLegacyCache || result.Items[1].Source != SourceManaged {
		t.Fatalf("unexpected deterministic order: %#v", result.Items)
	}
	for _, item := range result.Items {
		if !item.ValidGGUF || item.Size <= 4 || item.Path == "" {
			t.Fatalf("invalid inventory item: %#v", item)
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(base)) {
		t.Fatalf("response leaked path: %s", encoded)
	}
}

func TestScanListsInvalidGGUFButIgnoresPartialAndUnrelatedFiles(t *testing.T) {
	models := t.TempDir()
	writeFile(t, filepath.Join(models, "broken.GGUF"), []byte("nope"))
	writeFile(t, filepath.Join(models, "pending.gguf.partial"), []byte("GGUFpending"))
	writeFile(t, filepath.Join(models, "notes.txt"), []byte("GGUFnotes"))

	result, err := (Scanner{Roots: []Root{{Path: models, Source: SourceManaged}}}).Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].Name != "broken.GGUF" || result.Items[0].ValidGGUF {
		t.Fatalf("unexpected inventory: %#v", result.Items)
	}
}

func TestScanAssignsDifferentIDsToDuplicateBasenames(t *testing.T) {
	models := t.TempDir()
	writeFile(t, filepath.Join(models, "one", "same.gguf"), []byte("GGUFone"))
	writeFile(t, filepath.Join(models, "two", "same.gguf"), []byte("GGUFtwo"))

	result, err := (Scanner{Roots: []Root{{Path: models, Source: SourceManaged}}}).Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 || result.Items[0].ID == result.Items[1].ID {
		t.Fatalf("duplicate names did not receive distinct IDs: %#v", result.Items)
	}
	for _, item := range result.Items {
		if len(item.ID) != 32 {
			t.Fatalf("opaque ID length = %d", len(item.ID))
		}
	}
}

func TestScanDoesNotFollowFileOrDirectorySymlinks(t *testing.T) {
	models := t.TempDir()
	outside := t.TempDir()
	outsideModel := filepath.Join(outside, "outside.gguf")
	writeFile(t, outsideModel, []byte("GGUFoutside"))
	if err := os.Symlink(outsideModel, filepath.Join(models, "file-link.gguf")); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(models, "directory-link")); err != nil {
		t.Skipf("directory symlink creation is unavailable: %v", err)
	}

	result, err := (Scanner{Roots: []Root{{Path: models, Source: SourceManaged}}}).Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 0 {
		t.Fatalf("symlink targets were inventoried: %#v", result.Items)
	}
}

func TestScanStopsAtDepthAndEntryBounds(t *testing.T) {
	models := t.TempDir()
	writeFile(t, filepath.Join(models, "top.gguf"), []byte("GGUFtop"))
	writeFile(t, filepath.Join(models, "one", "nested.gguf"), []byte("GGUFnested"))
	writeFile(t, filepath.Join(models, "one", "two", "deep.gguf"), []byte("GGUFdeep"))

	result, err := (Scanner{
		Roots: []Root{{Path: models, Source: SourceManaged}}, MaxDepth: 2,
	}).Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 {
		t.Fatalf("depth-bounded items = %#v", result.Items)
	}

	_, err = (Scanner{
		Roots: []Root{{Path: models, Source: SourceManaged}}, MaxEntries: 2,
	}).Scan()
	if err == nil {
		t.Fatal("expected entry-bound scan failure")
	}
}

func TestResolveReturnsOnlyCurrentApprovedRegularFiles(t *testing.T) {
	models := t.TempDir()
	path := filepath.Join(models, "model.gguf")
	writeFile(t, path, []byte("GGUFmodel"))
	scanner := Scanner{Roots: []Root{{Path: models, Source: SourceManaged}}}
	result, err := scanner.Scan()
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := scanner.Resolve(result.Items[0].ID)
	if err != nil || resolved.Path != path {
		t.Fatalf("resolve = %#v, %v", resolved, err)
	}

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := scanner.Resolve(result.Items[0].ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing resolve error = %v", err)
	}
}

func TestScanReturnsWarningWhenOnlyOneApprovedRootIsUnavailable(t *testing.T) {
	models := t.TempDir()
	writeFile(t, filepath.Join(models, "model.gguf"), []byte("GGUFmodel"))
	result, err := (Scanner{Roots: []Root{
		{Path: models, Source: SourceManaged},
		{Path: filepath.Join(t.TempDir(), "missing"), Source: SourceLegacyCache},
	}}).Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || len(result.Warnings) != 1 || result.Warnings[0].Source != SourceLegacyCache {
		t.Fatalf("unexpected partial-root result: %#v", result)
	}
}
