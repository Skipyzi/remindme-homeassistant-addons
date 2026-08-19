package mods

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/babric"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/bta"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/testsupport"
)

// stubModrinth serves a search response, a version list whose file points back
// at the stub itself, and the file bytes.
func stubModrinth(t *testing.T, fileContent []byte, versionNumber string) *httptest.Server {
	t.Helper()
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/search"):
			_, _ = fmt.Fprintf(w, `{"hits":[{"project_id":"AAAA","slug":"halplibe","title":"HalpLibe",
				"description":"Helper library","downloads":21309,"server_side":"required"}],"total_hits":1}`)
		case strings.Contains(r.URL.Path, "/version"):
			sha := checksum512(fileContent)
			payload := []map[string]any{{
				"id": "ver1", "project_id": "AAAA", "version_number": versionNumber,
				"version_type": "release", "game_versions": []string{"b1.7.3"},
				"loaders": []string{"bta-babric"}, "date_published": "2026-07-26T00:00:00Z",
				"files": []map[string]any{{
					"filename": "halplibe-6.1.4+8.0.jar", "primary": true, "size": len(fileContent),
					"url":    server.URL + "/file.jar",
					"hashes": map[string]string{"sha512": sha},
				}},
			}}
			_ = json.NewEncoder(w).Encode(payload)
		case r.URL.Path == "/file.jar":
			_, _ = w.Write(fileContent)
		case r.URL.Path == "/tampered.jar":
			_, _ = w.Write([]byte("something else entirely"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func newManager(t *testing.T, api string) (*Manager, *testsupport.Env) {
	t.Helper()
	env := testsupport.NewEnv(t)
	backend := babric.New()
	env.Paths.SetFlavour(backend.Name(), backend.JarName())
	if err := env.Paths.EnsureLayout(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(env.Paths.Runtime(), "mods"), 0o755); err != nil {
		t.Fatal(err)
	}
	return New(Deps{
		Paths: env.Paths, Backend: backend, Settings: env.Settings,
		Store: env.Store, Bus: env.Bus, Log: env.Log, API: api,
	}), env
}

func TestInstallVerifiesAndRecords(t *testing.T) {
	content := []byte("jar bytes")
	server := stubModrinth(t, content, "6.1.4+8.0")
	manager, env := newManager(t, server.URL)

	entry, err := manager.Install(context.Background(), "halplibe", "tester", "")
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if entry.FileName != "halplibe-6.1.4+8.0.jar" || !entry.Managed {
		t.Fatalf("unexpected entry: %+v", entry)
	}
	raw, err := os.ReadFile(filepath.Join(env.Paths.Runtime(), "mods", entry.FileName))
	if err != nil || string(raw) != string(content) {
		t.Fatalf("the jar did not land: %v", err)
	}

	list, err := manager.List()
	if err != nil || len(list) != 1 || list[0].Project != "halplibe" {
		t.Fatalf("list: %v %+v", err, list)
	}

	entries, err := env.Store.RecentAudit(5, "mods.install")
	if err != nil || len(entries) == 0 {
		t.Fatal("expected an audit entry for the install")
	}
}

func TestInstallRefusesATamperedDownload(t *testing.T) {
	content := []byte("jar bytes")
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/version"):
			payload := []map[string]any{{
				"id": "ver1", "project_id": "AAAA", "version_number": "1.0",
				"version_type": "release", "game_versions": []string{"b1.7.3"},
				"loaders": []string{"bta-babric"}, "date_published": "2026-07-26T00:00:00Z",
				"files": []map[string]any{{
					"filename": "mod.jar", "primary": true,
					"url":    server.URL + "/file.jar",
					"hashes": map[string]string{"sha512": checksum512(content)},
				}},
			}}
			_ = json.NewEncoder(w).Encode(payload)
		case r.URL.Path == "/file.jar":
			_, _ = w.Write([]byte("tampered bytes"))
		}
	}))
	defer server.Close()
	manager, env := newManager(t, server.URL)

	if _, err := manager.Install(context.Background(), "halplibe", "tester", ""); err == nil ||
		!strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected a checksum refusal, got %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(env.Paths.Runtime(), "mods"))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".jar") {
			t.Fatalf("a tampered file was written: %s", e.Name())
		}
	}
}

func TestRemoveDeletesFileAndRecordButNeverTheBridge(t *testing.T) {
	content := []byte("jar bytes")
	server := stubModrinth(t, content, "6.1.4+8.0")
	manager, _ := newManager(t, server.URL)
	entry, err := manager.Install(context.Background(), "halplibe", "tester", "")
	if err != nil {
		t.Fatal(err)
	}

	if err := manager.Remove("mcbridge.jar", "tester"); err == nil {
		t.Fatal("the bridge plugin must not be removable here")
	}
	if err := manager.Remove("../escape.jar", "tester"); err == nil {
		t.Fatal("a traversal name must be refused")
	}
	if err := manager.Remove(entry.FileName, "tester"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	list, _ := manager.List()
	if len(list) != 0 {
		t.Fatalf("still listed after removal: %+v", list)
	}
}

func TestHandDroppedJarsAreListedAsUnmanaged(t *testing.T) {
	manager, env := newManager(t, "http://unused.invalid")
	if err := os.WriteFile(filepath.Join(env.Paths.Runtime(), "mods", "mystery.jar"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	list, err := manager.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %+v", err, list)
	}
	if list[0].Managed || list[0].FileName != "mystery.jar" {
		t.Fatalf("expected an unmanaged entry: %+v", list[0])
	}
}

func TestUnsupportedFlavourIsRefused(t *testing.T) {
	env := testsupport.NewEnv(t)
	backend := bta.New() // plain BTA has no loader
	env.Paths.SetFlavour(backend.Name(), backend.JarName())
	manager := New(Deps{
		Paths: env.Paths, Backend: backend, Settings: env.Settings,
		Store: env.Store, Bus: env.Bus, Log: env.Log,
	})
	if _, err := manager.Search(context.Background(), "x"); err != ErrUnsupported {
		t.Fatalf("expected ErrUnsupported, got %v", err)
	}
	status := manager.Status()
	if status.Supported {
		t.Fatal("plain BTA must report unsupported")
	}
}

func TestPacksFitTheFlavour(t *testing.T) {
	manager, _ := newManager(t, "http://unused.invalid")
	for _, pack := range manager.Packs() {
		if pack.Loader != "bta-babric" {
			t.Fatalf("a %s pack was offered to babric", pack.Loader)
		}
	}
	env := testsupport.NewEnv(t)
	paperBackend := paper.New()
	env.Paths.SetFlavour(paperBackend.Name(), paperBackend.JarName())
	paperManager := New(Deps{
		Paths: env.Paths, Backend: paperBackend, Settings: env.Settings,
		Store: env.Store, Bus: env.Bus, Log: env.Log,
	})
	found := false
	for _, pack := range paperManager.Packs() {
		if pack.ID == "paper-admin" {
			found = true
		}
	}
	if !found {
		t.Fatal("the paper admin pack should be offered to paper")
	}
	if _, err := paperManager.InstallPack(context.Background(), "babric-foundation", "tester"); err == nil {
		t.Fatal("a pack for another flavour must be refused")
	}
}

func TestValidProject(t *testing.T) {
	for _, ok := range []string{"halplibe", "bonus-blocks-bta", "AAAA_1"} {
		if err := validProject(ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "a/b", "a?b", strings.Repeat("x", 70), "a b"} {
		if err := validProject(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
