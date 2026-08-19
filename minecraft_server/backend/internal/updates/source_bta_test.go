package updates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Trimmed captures of the official CDN's per-channel manifests. The release
// manifest really does mix the 1.7.x line with the 7.x/8.x one.
const btaReleaseManifest = `{
  "versions": ["v1.7.6", "v7.1", "v7.3_04", "v8.0", "v8.0.1"],
  "default": "v8.0.1"
}`

const btaPrereleaseManifest = `{
  "versions": ["v8.0-pre1", "v8.0-pre3"],
  "default": "v8.0-pre3"
}`

func btaStub(t *testing.T) *BTASource {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bta-server/release/versions.json":
			_, _ = w.Write([]byte(btaReleaseManifest))
		case "/bta-server/prerelease/versions.json":
			_, _ = w.Write([]byte(btaPrereleaseManifest))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return &BTASource{cdn: server.URL + "/bta-server"}
}

func TestBTAVersionsComeFromTheReleaseManifest(t *testing.T) {
	versions, err := btaStub(t).Versions(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"8.0.1", "8.0", "7.3_04", "7.1", "1.7.6"}
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
	off, _ := source.Versions(context.Background(), false)
	for _, v := range off {
		if strings.Contains(v, "-") {
			t.Fatalf("pre-release %q offered without the toggle", v)
		}
	}
	on, err := source.Versions(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, v := range on {
		if v == "8.0-pre3" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected 8.0-pre3 when pre-releases are enabled: %v", on)
	}
}

func TestBTABuildUsesTheStableServerJarName(t *testing.T) {
	source := btaStub(t)
	builds, err := source.Builds(context.Background(), "8.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if len(builds) != 1 {
		t.Fatalf("a CDN version is one build, got %d", len(builds))
	}
	build := builds[0]
	if !strings.HasSuffix(build.URL, "/bta-server/release/v8.0.1/server.jar") {
		t.Fatalf("unexpected URL %q", build.URL)
	}
	// The CDN publishes no checksums; the empty SHA plus AllowsUnverified is what
	// lets the installer compute-and-record instead of refusing.
	if build.SHA256 != "" {
		t.Fatalf("the CDN has no published checksum, got %q", build.SHA256)
	}
	if !source.AllowsUnverified() {
		t.Fatal("the first-party CDN source must allow an unverified download")
	}
	if source.Bundle() {
		t.Fatal("plain BTA is a single JAR, not a bundle")
	}
}

func TestBTAPreReleaseBuildsComeFromTheirChannel(t *testing.T) {
	builds, err := btaStub(t).Builds(context.Background(), "8.0-pre3")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(builds[0].URL, "/prerelease/v8.0-pre3/") {
		t.Fatalf("unexpected URL %q", builds[0].URL)
	}
	if builds[0].Channel != "prerelease" {
		t.Fatalf("unexpected channel %q", builds[0].Channel)
	}
}

func TestBTAUnpublishedVersionIsRefusedBeforeDownload(t *testing.T) {
	if _, err := btaStub(t).Builds(context.Background(), "9.9"); err == nil {
		t.Fatal("a version missing from the manifest must be refused")
	}
}

func TestBTAValidVersion(t *testing.T) {
	source := NewBTASource()
	for _, v := range []string{"7.3", "7.3_04", "8.0.1", "1.7.6.2", "8.0-pre3"} {
		if err := source.ValidVersion(v); err != nil {
			t.Errorf("valid version %q rejected: %v", v, err)
		}
	}
	for _, v := range []string{"", "v8.0.1", "../../etc/passwd", "8.0/../../x", "latest", strings.Repeat("1", 25)} {
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
		{"8.0", "7.3_04", 1},
		{"8.0.1", "8.0", 1},
		{"8.0", "8.0-pre3", 1},
		{"8.0-pre3", "8.0-pre1", 1},
		{"7.3", "7.3", 0},
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

	host := strings.TrimPrefix(redirector.URL, "http://")
	if _, err := httpDownload(context.Background(), redirector.URL+"/a.jar", []string{host}); err == nil {
		t.Fatal("expected the redirect to an unlisted host to be refused")
	}
}
