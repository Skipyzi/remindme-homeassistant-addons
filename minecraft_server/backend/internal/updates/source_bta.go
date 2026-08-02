package updates

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Better than Adventure! publishes its server JAR as a GitHub release asset.
// There is no build API: one release is one installable version.
const btaReleasesAPI = "https://api.github.com/repos/Better-than-Adventure/bta-download-repo/releases?per_page=50"

// btaAssetPattern matches the server JAR in a release. The naming has changed
// several times (bta-7.2-server.jar, bta.v7.3_04.server.jar,
// better-than-adventure-7.1.Prerelease.2-server.jar), so the match is on the
// project prefix and the "server.jar" ending rather than on an exact name.
var btaAssetPattern = regexp.MustCompile(`(?i)^(bta|better[-_.]than[-_.]adventure)[._-].*server\.jar$`)

// btaVersionPattern extracts the version out of a release tag: "v7.3", "v7.3_04"
// and the pre-release form "v7.2-prerelease-2".
var btaVersionPattern = regexp.MustCompile(`^v?([0-9]+(?:\.[0-9]+)*(?:_[0-9]+)?(?:-[A-Za-z0-9.-]+)?)$`)

// BTASource installs Better than Adventure! releases.
type BTASource struct {
	// api is overridable in tests.
	api string
	// token, when set, is sent as a GitHub bearer token. It is only used to lift
	// the anonymous rate limit and is never required.
	token string
}

func NewBTASource() *BTASource { return &BTASource{api: btaReleasesAPI} }

func (s *BTASource) Flavour() string     { return "bta" }
func (s *BTASource) ProjectName() string { return "Better than Adventure!" }

// DownloadHosts covers the release URL and the storage host GitHub redirects to.
func (s *BTASource) DownloadHosts() []string {
	return []string{
		"github.com",
		"objects.githubusercontent.com",
		"release-assets.githubusercontent.com",
		"api.github.com",
	}
}

func (s *BTASource) StagedName(version string, _ int) string {
	return fmt.Sprintf("bta-%s.jar", version)
}

func (s *BTASource) endpoint() string {
	if s.api == "" {
		return btaReleasesAPI
	}
	return s.api
}

func (s *BTASource) headers() map[string]string {
	h := map[string]string{"Accept": "application/vnd.github+json"}
	if s.token != "" {
		h["Authorization"] = "Bearer " + s.token
	}
	return h
}

type githubRelease struct {
	TagName    string    `json:"tag_name"`
	Draft      bool      `json:"draft"`
	Prerelease bool      `json:"prerelease"`
	CreatedAt  time.Time `json:"published_at"`
	Assets     []struct {
		Name               string `json:"name"`
		Size               int64  `json:"size"`
		Digest             string `json:"digest"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// build turns a release into an installable build, or reports that it has no
// server JAR (the client-only and instance-only releases do not).
func (r githubRelease) build() (Build, string, bool) {
	version, ok := btaVersion(r.TagName)
	if !ok || r.Draft {
		return Build{}, "", false
	}
	for _, asset := range r.Assets {
		if !btaAssetPattern.MatchString(asset.Name) {
			continue
		}
		channel := "stable"
		if r.Prerelease {
			channel = "prerelease"
		}
		// GitHub publishes the asset digest as "sha256:<hex>". A release without
		// one leaves SHA256 empty, and the installer refuses it.
		sha := strings.TrimPrefix(asset.Digest, "sha256:")
		if !strings.HasPrefix(asset.Digest, "sha256:") {
			sha = ""
		}
		return Build{
			// A BTA release has exactly one build, so the number carries no
			// information; 1 keeps "newest build" comparisons meaningful.
			Build:    1,
			Channel:  channel,
			Time:     r.CreatedAt,
			FileName: asset.Name,
			SHA256:   sha,
			URL:      asset.BrowserDownloadURL,
		}, version, true
	}
	return Build{}, "", false
}

func btaVersion(tag string) (string, bool) {
	m := btaVersionPattern.FindStringSubmatch(strings.TrimSpace(tag))
	if m == nil {
		return "", false
	}
	return m[1], true
}

func (s *BTASource) releases(ctx context.Context) ([]githubRelease, error) {
	var payload []githubRelease
	if err := httpGetJSON(ctx, s.endpoint(), s.headers(), &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// Versions lists the BTA releases that ship a server JAR, newest first.
func (s *BTASource) Versions(ctx context.Context, includePreReleases bool) ([]string, error) {
	releases, err := s.releases(ctx)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(releases))
	for _, release := range releases {
		build, version, ok := release.build()
		if !ok || seen[version] {
			continue
		}
		if build.Channel == "prerelease" && !includePreReleases {
			continue
		}
		seen[version] = true
		out = append(out, version)
	}
	sort.Slice(out, func(i, j int) bool { return compareBTAVersions(out[i], out[j]) > 0 })
	return out, nil
}

// Builds returns the single build of one BTA version.
func (s *BTASource) Builds(ctx context.Context, version string) ([]Build, error) {
	if err := s.ValidVersion(version); err != nil {
		return nil, err
	}
	releases, err := s.releases(ctx)
	if err != nil {
		return nil, err
	}
	for _, release := range releases {
		build, released, ok := release.build()
		if ok && released == version {
			return []Build{build}, nil
		}
	}
	return nil, fmt.Errorf("Better than Adventure! %s has no server JAR in its release", version)
}

// compareBTAVersions orders 7.3_04 above 7.3 and 7.10 above 7.9, and puts a
// release above the pre-releases that led to it.
func compareBTAVersions(a, b string) int {
	aBase, aPre, _ := strings.Cut(a, "-")
	bBase, bPre, _ := strings.Cut(b, "-")
	split := func(v string) []int {
		v = strings.ReplaceAll(v, "_", ".")
		parts := strings.Split(v, ".")
		out := make([]int, 0, len(parts))
		for _, p := range parts {
			n, _ := strconv.Atoi(p)
			out = append(out, n)
		}
		return out
	}
	aParts, bParts := split(aBase), split(bBase)
	for i := 0; i < len(aParts) || i < len(bParts); i++ {
		var an, bn int
		if i < len(aParts) {
			an = aParts[i]
		}
		if i < len(bParts) {
			bn = bParts[i]
		}
		if an != bn {
			if an > bn {
				return 1
			}
			return -1
		}
	}
	switch {
	case aPre == bPre:
		return 0
	case aPre == "":
		return 1
	case bPre == "":
		return -1
	case aPre > bPre:
		return 1
	default:
		return -1
	}
}

// ValidVersion accepts a BTA version such as 7.3 or 7.3_04.
func (s *BTASource) ValidVersion(v string) error {
	if v == "" {
		return fmt.Errorf("a Better than Adventure! version is required")
	}
	if len(v) > 24 {
		return fmt.Errorf("version string is too long")
	}
	if !btaVersionPattern.MatchString(v) {
		return fmt.Errorf("%q is not a Better than Adventure! version", v)
	}
	return nil
}
