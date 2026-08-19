package updates

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Babric is Better than Adventure! with the Fabric loader, which is what makes
// BTA moddable. Turnip Labs publishes a complete server bundle per release - the
// Fabric launcher, its libraries and a mods directory - as a GitHub release
// asset with a SHA-256 digest, so unlike the plain BTA CDN this source is
// checksum-verified end to end. BTA 7.3_04 and newer only.
const babricReleasesAPI = "https://api.github.com/repos/Turnip-Labs/bta-fabric-instance-repo/releases?per_page=50"

// babricAssetPattern matches the server bundle. The prefix changed once
// (bta_babric_server_7.3_03.zip, bta_fabric_server_8.0.1.zip).
var babricAssetPattern = regexp.MustCompile(`(?i)^bta_(babric|fabric)_server_.*\.zip$`)

// BabricSource installs the Babric server bundles.
type BabricSource struct {
	// api is overridable in tests.
	api string
}

func NewBabricSource() *BabricSource { return &BabricSource{api: babricReleasesAPI} }

func (s *BabricSource) Flavour() string        { return "babric" }
func (s *BabricSource) ProjectName() string    { return "BTA with Babric" }
func (s *BabricSource) AllowsUnverified() bool { return false }
func (s *BabricSource) Bundle() bool           { return true }

// DownloadHosts covers the release URL and the storage host GitHub redirects to.
func (s *BabricSource) DownloadHosts() []string {
	return []string{
		"github.com",
		"objects.githubusercontent.com",
		"release-assets.githubusercontent.com",
		"api.github.com",
	}
}

func (s *BabricSource) StagedName(version string, _ int) string {
	return fmt.Sprintf("babric-%s.zip", version)
}

func (s *BabricSource) endpoint() string {
	if s.api == "" {
		return babricReleasesAPI
	}
	return s.api
}

type babricRelease struct {
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

func (r babricRelease) build() (Build, string, bool) {
	version, ok := btaVersion(r.TagName)
	if !ok || r.Draft {
		return Build{}, "", false
	}
	for _, asset := range r.Assets {
		if !babricAssetPattern.MatchString(asset.Name) {
			continue
		}
		channel := "stable"
		// Both GitHub's own pre-release flag and a suffixed tag (v8.0-pre3) mean
		// pre-release; the instance repo has used both.
		if r.Prerelease || strings.Contains(version, "-") {
			channel = "prerelease"
		}
		sha := strings.TrimPrefix(asset.Digest, "sha256:")
		if !strings.HasPrefix(asset.Digest, "sha256:") {
			sha = ""
		}
		return Build{
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

func (s *BabricSource) releases(ctx context.Context) ([]babricRelease, error) {
	var payload []babricRelease
	headers := map[string]string{"Accept": "application/vnd.github+json"}
	if err := httpGetJSON(ctx, s.endpoint(), headers, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// Versions lists the Babric releases that ship a server bundle, newest first.
func (s *BabricSource) Versions(ctx context.Context, includePreReleases bool) ([]string, error) {
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

// Builds returns the single bundle of one version.
func (s *BabricSource) Builds(ctx context.Context, version string) ([]Build, error) {
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
	return nil, fmt.Errorf("no Babric server bundle has been published for %s", version)
}

// ValidVersion accepts the same version grammar as plain BTA.
func (s *BabricSource) ValidVersion(v string) error {
	if v == "" {
		return fmt.Errorf("a Better than Adventure! version is required")
	}
	if len(v) > 24 {
		return fmt.Errorf("version string is too long")
	}
	if strings.HasPrefix(v, "v") || !btaVersionPattern.MatchString(v) {
		return fmt.Errorf("%q is not a Better than Adventure! version", v)
	}
	return nil
}
