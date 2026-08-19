package updates

import (
	"archive/zip"
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A trimmed capture of the Turnip Labs instance-repo releases: the asset prefix
// really did change from bta_babric_ to bta_fabric_, and some releases are
// GitHub pre-releases while others carry the -preN suffix in the tag.
const babricReleasesPayload = `[
  {
    "tag_name": "v8.0.1", "draft": false, "prerelease": false,
    "published_at": "2026-07-25T16:17:27Z",
    "assets": [
      {"name": "bta_fabric_instance_8.0.1.zip", "size": 379742, "digest": "sha256:aaaa",
       "browser_download_url": "https://github.com/x/releases/download/v8.0.1/bta_fabric_instance_8.0.1.zip"},
      {"name": "bta_fabric_server_8.0.1.zip", "size": 37175917, "digest": "sha256:945ee1379cfb9f9fa5fb2a99e6aff133df28835394a44f52dde220c07518885b",
       "browser_download_url": "https://github.com/x/releases/download/v8.0.1/bta_fabric_server_8.0.1.zip"}
    ]
  },
  {
    "tag_name": "v8.0-pre3", "draft": false, "prerelease": false,
    "published_at": "2026-07-12T13:02:32Z",
    "assets": [
      {"name": "bta_fabric_server_8.0-pre3.zip", "size": 1, "digest": "sha256:bbbb",
       "browser_download_url": "https://github.com/x/releases/download/v8.0-pre3/bta_fabric_server_8.0-pre3.zip"}
    ]
  },
  {
    "tag_name": "v7.3_03", "draft": false, "prerelease": false,
    "published_at": "2025-05-06T09:12:28Z",
    "assets": [
      {"name": "bta_babric_server_7.3_03.zip", "size": 100, "digest": "sha256:cccc",
       "browser_download_url": "https://github.com/x/releases/download/v7.3_03/bta_babric_server_7.3_03.zip"}
    ]
  }
]`

func babricStub(t *testing.T) *BabricSource {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(babricReleasesPayload))
	}))
	t.Cleanup(server.Close)
	return &BabricSource{api: server.URL}
}

func TestBabricVersionsSkipInstanceOnlyAssetsAndPreReleases(t *testing.T) {
	source := babricStub(t)
	versions, err := source.Versions(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"8.0.1", "7.3_03"}
	if len(versions) != len(want) || versions[0] != want[0] || versions[1] != want[1] {
		t.Fatalf("expected %v, got %v", want, versions)
	}
	// A -preN tag is a pre-release even when GitHub's flag says otherwise.
	on, _ := source.Versions(context.Background(), true)
	found := false
	for _, v := range on {
		if v == "8.0-pre3" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the suffixed pre-release when enabled: %v", on)
	}
}

func TestBabricBuildCarriesTheServerBundleDigest(t *testing.T) {
	source := babricStub(t)
	builds, err := source.Builds(context.Background(), "8.0.1")
	if err != nil {
		t.Fatal(err)
	}
	build := builds[0]
	if build.FileName != "bta_fabric_server_8.0.1.zip" {
		t.Fatalf("picked the wrong asset: %q", build.FileName)
	}
	if !strings.HasPrefix(build.SHA256, "945ee137") || strings.Contains(build.SHA256, ":") {
		t.Fatalf("digest not normalised: %q", build.SHA256)
	}
	if !source.Bundle() || source.AllowsUnverified() {
		t.Fatal("babric is a checksum-verified bundle source")
	}
}

func TestBabricAssetNaming(t *testing.T) {
	for _, name := range []string{"bta_fabric_server_8.0.1.zip", "bta_babric_server_7.3_03.zip"} {
		if !babricAssetPattern.MatchString(name) {
			t.Errorf("%q should match", name)
		}
	}
	for _, name := range []string{"bta_fabric_instance_8.0.1.zip", "bta_fabric_server_8.0.1.tar", "instance.cfg"} {
		if babricAssetPattern.MatchString(name) {
			t.Errorf("%q must not match", name)
		}
	}
}

// ------------------------------------------------------------------ bundles --

func makeBundle(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, content := range entries {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestInstallBundleUnpacksAndPreservesUserFiles(t *testing.T) {
	dir := t.TempDir()
	// What the user already has: their own mod, their properties, their world.
	if err := os.MkdirAll(filepath.Join(dir, "mods"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		"mods/my-own-mod.jar": "user mod",
		"server.properties":   "server-port=25565\n",
		"world/level.dat":     "nbt",
		// A stale library from the previous version, which must NOT survive.
		"libraries/old/stale-1.0.jar": "stale",
	} {
		full := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	bundle := makeBundle(t, map[string]string{
		"fabric-server-launch.jar":        "launcher",
		"server.jar":                      "the game",
		"libraries/net/fabric/loader.jar": "loader",
		"mods/halplibe.jar":               "base mod",
	})
	if err := installBundle(bundle, dir, "fabric-server-launch.jar"); err != nil {
		t.Fatal(err)
	}

	for path, want := range map[string]string{
		"fabric-server-launch.jar":        "launcher",
		"server.jar":                      "the game",
		"libraries/net/fabric/loader.jar": "loader",
		"mods/halplibe.jar":               "base mod",
		"mods/my-own-mod.jar":             "user mod",
		"server.properties":               "server-port=25565\n",
		"world/level.dat":                 "nbt",
	} {
		raw, err := os.ReadFile(filepath.Join(dir, path))
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if string(raw) != want {
			t.Fatalf("%s = %q, want %q", path, raw, want)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "libraries/old/stale-1.0.jar")); !os.IsNotExist(err) {
		t.Fatal("the stale library from the previous version survived")
	}
}

func TestInstallBundleRefusesEscapesAndImposters(t *testing.T) {
	dir := t.TempDir()
	if err := installBundle(makeBundle(t, map[string]string{
		"../escape.jar":            "x",
		"fabric-server-launch.jar": "launcher",
	}), dir, "fabric-server-launch.jar"); err == nil {
		t.Fatal("a path traversal entry must be refused")
	}
	if err := installBundle(makeBundle(t, map[string]string{
		"readme.txt": "not a server bundle",
	}), dir, "fabric-server-launch.jar"); err == nil {
		t.Fatal("a zip without the launcher must be refused")
	}
	if err := installBundle([]byte("not a zip"), dir, "fabric-server-launch.jar"); err == nil {
		t.Fatal("garbage must be refused")
	}
}
