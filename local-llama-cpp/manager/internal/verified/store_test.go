package verified

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"remindme.local/model-manager/internal/catalog"
)

func testVariant() catalog.Variant {
	return catalog.Variant{ID: "test-q4", Repo: "owner/repo", File: "test.gguf", ExpectedBytes: 8, SHA256: "abc"}
}

func TestStoreRecordsReloadsAndRemovesVerifiedModel(t *testing.T) {
	modelDir := t.TempDir()
	path := filepath.Join(modelDir, "test.gguf")
	if err := os.WriteFile(path, []byte("GGUFtest"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{Path: filepath.Join(t.TempDir(), "verified.json"), ModelDir: modelDir}
	variant := testVariant()
	if err := store.Record(variant, path); err != nil {
		t.Fatal(err)
	}
	if !store.Has(variant) {
		t.Fatal("recorded model was not verified")
	}
	reloaded := Store{Path: store.Path, ModelDir: modelDir}
	if !reloaded.Has(variant) {
		t.Fatal("verification did not reload")
	}
	info, err := os.Stat(store.Path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%v", info.Mode().Perm())
	}
	if err := reloaded.Remove(variant.ID); err != nil {
		t.Fatal(err)
	}
	if reloaded.Has(variant) {
		t.Fatal("removed verification remained active")
	}
}

func TestStoreRejectsOutsidePathAndIdentityChanges(t *testing.T) {
	modelDir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "test.gguf")
	if err := os.WriteFile(outside, []byte("GGUFtest"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := Store{Path: filepath.Join(t.TempDir(), "verified.json"), ModelDir: modelDir}
	variant := testVariant()
	if err := store.Record(variant, outside); err == nil {
		t.Fatal("outside model path was accepted")
	}
	inside := filepath.Join(modelDir, variant.File)
	if err := os.WriteFile(inside, []byte("GGUFtest"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Record(variant, inside); err != nil {
		t.Fatal(err)
	}
	variant.SHA256 = "changed"
	if store.Has(variant) {
		t.Fatal("changed catalog identity reused stale verification")
	}
}
