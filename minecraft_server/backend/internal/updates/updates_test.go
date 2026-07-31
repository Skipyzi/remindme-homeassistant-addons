package updates

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The payloads below are trimmed captures of the real PaperMC v3 ("Fill") API,
// which replaced v2 after it started answering 410 Gone.

const versionsPayload = `{
  "project": {"id": "paper", "name": "Paper"},
  "versions": {
    "26.1": ["26.1.2", "26.1.1"],
    "1.21": ["1.21.11", "1.21.11-rc3", "1.21.10", "1.21.9", "1.21.4", "1.21"],
    "1.20": ["1.20.6", "1.20.1"]
  }
}`

const buildsPayload = `[
  {
    "id": 232,
    "time": "2025-06-09T10:18:55.778Z",
    "channel": "STABLE",
    "downloads": {
      "server:default": {
        "name": "paper-1.21.4-232.jar",
        "checksums": {"sha256": "5ee4f542f628a14c644410b08c94ea42e772ef4d29fe92973636b6813d4eaffc"},
        "size": 51437498,
        "url": "https://fill-data.papermc.io/v1/objects/5ee4f542f628a14c644410b08c94ea42e772ef4d29fe92973636b6813d4eaffc/paper-1.21.4-232.jar"
      }
    }
  },
  {
    "id": 233,
    "time": "2025-06-10T10:18:55.778Z",
    "channel": "ALPHA",
    "downloads": {
      "server:default": {
        "name": "paper-1.21.4-233.jar",
        "checksums": {"sha256": "aaaa"},
        "size": 1,
        "url": "https://fill-data.papermc.io/v1/objects/aaaa/paper-1.21.4-233.jar"
      }
    }
  }
]`

func TestFlattenVersionsSortsNumericallyAndDropsPreReleases(t *testing.T) {
	var payload struct {
		Versions map[string][]string `json:"versions"`
	}
	if err := json.Unmarshal([]byte(versionsPayload), &payload); err != nil {
		t.Fatal(err)
	}
	versions := flattenVersions(payload.Versions)

	if len(versions) == 0 {
		t.Fatal("no versions parsed")
	}
	if versions[0] != "26.1.2" {
		t.Fatalf("expected the newest version first, got %q (%v)", versions[0], versions)
	}
	for _, version := range versions {
		if strings.Contains(version, "-") {
			t.Errorf("pre-release %q should not be offered", version)
		}
	}
	// A plain string sort would put 1.21.4 above 1.21.11; the numeric comparison
	// must not.
	indexOf := func(want string) int {
		for i, v := range versions {
			if v == want {
				return i
			}
		}
		return -1
	}
	if indexOf("1.21.11") > indexOf("1.21.4") {
		t.Fatalf("1.21.11 must sort above 1.21.4: %v", versions)
	}
	if indexOf("1.21.4") > indexOf("1.20.6") {
		t.Fatalf("1.21.4 must sort above 1.20.6: %v", versions)
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.21.11", "1.21.4", 1},
		{"1.21.4", "1.21.11", -1},
		{"26.1.2", "1.21.11", 1},
		{"1.21", "1.21.0", 0},
		{"1.21.4", "1.21.4", 0},
	}
	for _, tc := range cases {
		if got := compareVersions(tc.a, tc.b); got != tc.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestBuildParsingPullsTheServerJarAndItsChecksum(t *testing.T) {
	var payload []fillBuild
	if err := json.Unmarshal([]byte(buildsPayload), &payload); err != nil {
		t.Fatal(err)
	}
	build := payload[0].toBuild()
	if build.Build != 232 {
		t.Fatalf("expected build 232, got %d", build.Build)
	}
	if build.Channel != "stable" {
		t.Fatalf("expected the channel to be normalised to lower case, got %q", build.Channel)
	}
	if build.FileName != "paper-1.21.4-232.jar" {
		t.Fatalf("unexpected file name %q", build.FileName)
	}
	if !strings.HasPrefix(build.SHA256, "5ee4f542") {
		t.Fatalf("checksum not parsed: %q", build.SHA256)
	}
	if !strings.HasPrefix(build.URL, "https://fill-data.papermc.io/") {
		t.Fatalf("download URL not parsed: %q", build.URL)
	}
}

func TestPickStablePrefersStableOverPreRelease(t *testing.T) {
	builds := []Build{
		{Build: 233, Channel: "alpha"},
		{Build: 232, Channel: "stable"},
	}
	build, ok := pickStable(builds)
	if !ok || build.Build != 232 {
		t.Fatalf("expected the stable build, got %+v (ok=%v)", build, ok)
	}
	// A version that only has pre-release builds still has to be installable.
	only := []Build{{Build: 5, Channel: "alpha"}}
	build, ok = pickStable(only)
	if !ok || build.Build != 5 {
		t.Fatalf("expected the alpha build as a fallback, got %+v (ok=%v)", build, ok)
	}
	if _, ok := pickStable(nil); ok {
		t.Fatal("an empty build list must not produce a build")
	}
}

func TestSelectTargetResolvesBuildZeroToTheNewestStableBuild(t *testing.T) {
	var payload []fillBuild
	if err := json.Unmarshal([]byte(buildsPayload), &payload); err != nil {
		t.Fatal(err)
	}
	builds := make([]Build, 0, len(payload))
	for _, b := range payload {
		builds = append(builds, b.toBuild())
	}

	// Build 0 is what the install button and scheduled updates send. It regressed
	// once because the channel check still compared against the pre-v3 name, and
	// installing then failed with "build 0 of <version> not found".
	target, err := selectTarget(builds, 0, "1.21.4")
	if err != nil {
		t.Fatalf("build 0 must resolve: %v", err)
	}
	if target.Build != 232 || target.Channel != "stable" {
		t.Fatalf("expected the stable build 232, got %+v", target)
	}

	// An explicit build is taken as given, even a pre-release one.
	target, err = selectTarget(builds, 233, "1.21.4")
	if err != nil || target.Build != 233 {
		t.Fatalf("expected build 233, got %+v (%v)", target, err)
	}

	if _, err := selectTarget(builds, 999, "1.21.4"); err == nil {
		t.Fatal("expected an unknown build to be rejected")
	}
	if _, err := selectTarget(nil, 0, "1.21.4"); err == nil {
		t.Fatal("expected an empty build list to be reported")
	}
}

func TestSelectTargetAcceptsAVersionWithOnlyPreReleases(t *testing.T) {
	builds := []Build{{Build: 7, Channel: "alpha", SHA256: "x", URL: "https://fill-data.papermc.io/a"}}
	target, err := selectTarget(builds, 0, "26.3")
	if err != nil || target.Build != 7 {
		t.Fatalf("a freshly opened version has only pre-releases and must still install: %+v (%v)", target, err)
	}
}

func TestBuildsAndVersionsAgainstAStubAPI(t *testing.T) {
	var requested []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.Path)
		if r.Header.Get("User-Agent") == "" {
			t.Error("the PaperMC API asks for a descriptive User-Agent")
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/builds"):
			_, _ = w.Write([]byte(buildsPayload))
		default:
			_, _ = w.Write([]byte(versionsPayload))
		}
	}))
	defer server.Close()

	manager := NewManager(Deps{})
	// Point the client at the stub by overriding the endpoint the manager uses.
	base := server.URL + "/v3/projects/paper"

	var versionsDoc struct {
		Versions map[string][]string `json:"versions"`
	}
	if err := manager.getJSON(context.Background(), base, &versionsDoc); err != nil {
		t.Fatalf("versions: %v", err)
	}
	if len(flattenVersions(versionsDoc.Versions)) == 0 {
		t.Fatal("expected versions from the stub")
	}

	var buildsDoc []fillBuild
	if err := manager.getJSON(context.Background(), base+"/versions/1.21.4/builds", &buildsDoc); err != nil {
		t.Fatalf("builds: %v", err)
	}
	if len(buildsDoc) != 2 {
		t.Fatalf("expected two builds, got %d", len(buildsDoc))
	}
	if len(requested) != 2 {
		t.Fatalf("expected two requests, got %v", requested)
	}
}

func TestGoneStatusExplainsItself(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer server.Close()

	manager := NewManager(Deps{})
	err := manager.getJSON(context.Background(), server.URL+"/v2/projects/paper", &struct{}{})
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "410") || !strings.Contains(err.Error(), "gone") {
		t.Fatalf("the error should name the sunset endpoint: %v", err)
	}
}

func TestDownloadRefusesUnexpectedHosts(t *testing.T) {
	manager := NewManager(Deps{})
	cases := []string{
		"http://fill-data.papermc.io/v1/objects/x/paper.jar", // not https
		"https://evil.example.com/paper.jar",                 // not an allow-listed host
		"not a url at all",
	}
	for _, rawURL := range cases {
		if _, err := manager.download(context.Background(), rawURL); err == nil {
			t.Errorf("expected %q to be refused", rawURL)
		}
	}
}

func TestValidVersionRejectsPathTricks(t *testing.T) {
	for _, version := range []string{"1.21.4", "26.1.2", "1.21.11-rc3"} {
		if err := validVersion(version); err != nil {
			t.Errorf("valid version %q rejected: %v", version, err)
		}
	}
	for _, version := range []string{"", "../../etc/passwd", "1.21.4/builds", "1.21.4?x=1",
		strings.Repeat("1", 25)} {
		if err := validVersion(version); err == nil {
			t.Errorf("expected %q to be rejected", version)
		}
	}
}
