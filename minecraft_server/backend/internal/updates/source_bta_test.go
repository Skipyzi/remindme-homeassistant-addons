package updates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A trimmed capture of the GitHub releases API for the BTA download repository.
// The asset naming really does differ between releases, and only some releases
// ship a server JAR at all.
const btaReleasesPayload = `[
  {
    "tag_name": "v7.3_04",
    "draft": false,
    "prerelease": false,
    "published_at": "2025-03-01T10:00:00Z",
    "assets": [
      {"name": "bta.v7.3_04.client.jar", "size": 16642291, "digest": "sha256:aaaa",
       "browser_download_url": "https://github.com/Better-than-Adventure/bta-download-repo/releases/download/v7.3_04/bta.v7.3_04.client.jar"},
      {"name": "bta.v7.3_04.server.jar", "size": 5064161, "digest": "sha256:7bc8509b735e8dc952a3c20d1ad9fb4f1132137fe506ad42cfb751b037dcc767",
       "browser_download_url": "https://github.com/Better-than-Adventure/bta-download-repo/releases/download/v7.3_04/bta.v7.3_04.server.jar"}
    ]
  },
  {
    "tag_name": "v7.4-prerelease-1",
    "draft": false,
    "prerelease": true,
    "published_at": "2025-04-01T10:00:00Z",
    "assets": [
      {"name": "bta-7.4-prerelease-1-server.jar", "size": 1, "digest": "sha256:bbbb",
       "browser_download_url": "https://github.com/x/releases/download/v7.4-prerelease-1/bta-7.4-prerelease-1-server.jar"}
    ]
  },
  {
    "tag_name": "v7.2",
    "draft": false,
    "prerelease": false,
    "published_at": "2024-11-01T10:00:00Z",
    "assets": [
      {"name": "bta-7.2-server.jar", "size": 6661282, "digest": "sha256:cccc",
       "browser_download_url": "https://github.com/x/releases/download/v7.2/bta-7.2-server.jar"}
    ]
  },
  {
    "tag_name": "v7.1",
    "draft": false,
    "prerelease": false,
    "published_at": "2024-09-01T10:00:00Z",
    "assets": [
      {"name": "bta-icon.png", "size": 100, "digest": "sha256:dddd",
       "browser_download_url": "https://github.com/x/releases/download/v7.1/bta-icon.png"}
    ]
  }
]`

func btaStub(t *testing.T) *BTASource {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/vnd.github+json" {
			t.Errorf("the GitHub API wants an explicit Accept header, got %q", r.Header.Get("Accept"))
		}
		_, _ = w.Write([]byte(btaReleasesPayload))
	}))
	t.Cleanup(server.Close)
	return &BTASource{api: server.URL}
}

func TestBTAVersionsSkipReleasesWithoutAServerJar(t *testing.T) {
	versions, err := btaStub(t).Versions(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"7.3_04", "7.2"}
	if len(versions) != len(want) {
		t.Fatalf("expected %v, got %v", want, versions)
	}
	for i := range want {
		if versions[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, versions)
		}
	}
}

func TestBTAPreReleasesAreOptIn(t *testing.T) {
	source := btaStub(t)
	off, err := source.Versions(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range off {
		if v == "7.4-prerelease-1" {
			t.Fatal("a pre-release must not be offered unless it was asked for")
		}
	}
	on, err := source.Versions(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, v := range on {
		if v == "7.4-prerelease-1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the pre-release should be offered when enabled: %v", on)
	}
}

func TestBTABuildCarriesTheAssetDigest(t *testing.T) {
	builds, err := btaStub(t).Builds(context.Background(), "7.3_04")
	if err != nil {
		t.Fatal(err)
	}
	if len(builds) != 1 {
		t.Fatalf("a BTA release is one build, got %d", len(builds))
	}
	build := builds[0]
	if build.Channel != "stable" {
		t.Errorf("unexpected channel %q", build.Channel)
	}
	// GitHub publishes the digest as "sha256:<hex>"; the prefix must be stripped
	// or the comparison against the downloaded file can never match.
	if !strings.HasPrefix(build.SHA256, "7bc8509b") || strings.Contains(build.SHA256, ":") {
		t.Errorf("checksum not normalised: %q", build.SHA256)
	}
	if build.FileName != "bta.v7.3_04.server.jar" {
		t.Errorf("unexpected asset %q", build.FileName)
	}
	// Build 0 means "newest stable" and has to resolve for a source that has only
	// one build per version.
	if _, err := selectTarget(builds, 0, "7.3_04"); err != nil {
		t.Fatalf("build 0 must resolve: %v", err)
	}
}

func TestBTAAssetNamingVariantsAreMatched(t *testing.T) {
	// The two naming schemes seen across releases.
	for _, name := range []string{"bta.v7.3.server.jar", "bta-7.2-server.jar", "bta.v7.3_04.server.jar",
		"better-than-adventure-7.1.Prerelease.2-server.jar", "bta-7.1-pre2a-server.jar"} {
		if !btaAssetPattern.MatchString(name) {
			t.Errorf("%q should be recognised as a server JAR", name)
		}
	}
	for _, name := range []string{"bta.v7.3.client.jar", "bta-icon.png", "bta.v7.3.mmc.zip"} {
		if btaAssetPattern.MatchString(name) {
			t.Errorf("%q must not be installed as a server", name)
		}
	}
}

func TestBTAUnknownVersionIsReported(t *testing.T) {
	if _, err := btaStub(t).Builds(context.Background(), "9.9"); err == nil {
		t.Fatal("expected an unknown version to be rejected")
	}
}

func TestBTAValidVersion(t *testing.T) {
	source := NewBTASource()
	for _, v := range []string{"7.3", "7.3_04", "7", "10.11.12", "7.2-prerelease-2"} {
		if err := source.ValidVersion(v); err != nil {
			t.Errorf("valid version %q rejected: %v", v, err)
		}
	}
	for _, v := range []string{"", "../../etc/passwd", "7.3/builds", "7.3?x=1", "latest", strings.Repeat("1", 25)} {
		if err := source.ValidVersion(v); err == nil {
			t.Errorf("expected %q to be rejected", v)
		}
	}
}

func TestBTAVersionOrdering(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"7.3_04", "7.3", 1},
		{"7.10", "7.9", 1},
		{"7.2", "7.3", -1},
		{"7.3", "7.3", 0},
		{"7.2", "7.2-prerelease-2", 1},
		{"7.2-prerelease-2", "7.2-prerelease-1", 1},
	}
	for _, tc := range cases {
		if got := compareBTAVersions(tc.a, tc.b); got != tc.want {
			t.Errorf("compareBTAVersions(%q,%q)=%d want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

// GitHub serves release assets by redirecting to a storage host. Following that
// blindly would defeat the allow-list, so every hop is checked.
func TestDownloadChecksEveryRedirectHop(t *testing.T) {
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not a jar"))
	}))
	defer evil.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+"/paper.jar", http.StatusFound)
	}))
	defer redirector.Close()

	// The first host is allowed, the redirect target is not.
	host := strings.TrimPrefix(redirector.URL, "http://")
	_, err := httpDownload(context.Background(), redirector.URL+"/a.jar", []string{host})
	if err == nil {
		t.Fatal("expected the redirect to an unlisted host to be refused")
	}
}
