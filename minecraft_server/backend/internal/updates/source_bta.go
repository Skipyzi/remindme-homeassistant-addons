package updates

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Better than Adventure! moved its distribution to its own CDN; the GitHub
// releases the add-on originally installed from stopped at 7.3_04 while the
// project itself went on to 8.x. The CDN publishes a versions.json per channel
// and a stable server.jar name inside every version directory.
//
// The CDN publishes no checksums. It is the project's first-party host over
// HTTPS, so the source declares AllowsUnverified and the installer computes and
// records the SHA-256 of what it downloaded instead of verifying against a
// published value - see Install.
const btaCDN = "https://downloads.betterthanadventure.net/bta-server"

// btaVersionPattern accepts a version such as 7.3, 7.3_04, 1.7.6.2 or the
// pre-release form 8.0-pre3, with or without the CDN's leading "v".
var btaVersionPattern = regexp.MustCompile(`^v?([0-9]+(?:\.[0-9]+)*(?:_[0-9]+)?(?:-[A-Za-z0-9.-]+)?)$`)

// BTASource installs Better than Adventure! releases from the official CDN.
type BTASource struct {
	// cdn is overridable in tests.
	cdn string
}

func NewBTASource() *BTASource { return &BTASource{cdn: btaCDN} }

func (s *BTASource) Flavour() string        { return "bta" }
func (s *BTASource) ProjectName() string    { return "Better than Adventure!" }
func (s *BTASource) AllowsUnverified() bool { return true }
func (s *BTASource) Bundle() bool           { return false }

func (s *BTASource) DownloadHosts() []string {
	return []string{"downloads.betterthanadventure.net"}
}

func (s *BTASource) StagedName(version string, _ int) string {
	return fmt.Sprintf("bta-%s.jar", version)
}

func (s *BTASource) endpoint() string {
	if s.cdn == "" {
		return btaCDN
	}
	return s.cdn
}

type btaManifest struct {
	Versions []string `json:"versions"`
	Default  string   `json:"default"`
}

func (s *BTASource) channel(ctx context.Context, name string) ([]string, error) {
	var manifest btaManifest
	if err := httpGetJSON(ctx, s.endpoint()+"/"+name+"/versions.json", nil, &manifest); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(manifest.Versions))
	for _, tag := range manifest.Versions {
		if version, ok := btaVersion(tag); ok {
			out = append(out, version)
		}
	}
	return out, nil
}

// Versions lists the CDN's release channel, newest first; pre-releases come
// from their own channel and are only offered when asked for. The nightly
// channel is deliberately ignored - hundreds of entries nobody should run a
// home server on.
func (s *BTASource) Versions(ctx context.Context, includePreReleases bool) ([]string, error) {
	out, err := s.channel(ctx, "release")
	if err != nil {
		return nil, err
	}
	if includePreReleases {
		pre, err := s.channel(ctx, "prerelease")
		if err != nil {
			return nil, err
		}
		out = append(out, pre...)
	}
	sort.Slice(out, func(i, j int) bool { return compareBTAVersions(out[i], out[j]) > 0 })
	return out, nil
}

// Builds returns the single build of one version. The download URL uses the
// stable server.jar name, which every version directory provides regardless of
// how the versioned file inside is spelled.
func (s *BTASource) Builds(ctx context.Context, version string) ([]Build, error) {
	if err := s.ValidVersion(version); err != nil {
		return nil, err
	}
	channel := "release"
	channelName := "stable"
	if strings.Contains(version, "-") {
		channel = "prerelease"
		channelName = "prerelease"
	}
	// The manifest is the authority on what exists; a constructed URL for a
	// version the CDN never published would otherwise 404 halfway through an
	// install.
	known, err := s.channel(ctx, channel)
	if err != nil {
		return nil, err
	}
	found := false
	for _, v := range known {
		if v == version {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("Better than Adventure! has not published %s on the %s channel", version, channel)
	}
	return []Build{{
		Build:    1,
		Channel:  channelName,
		FileName: fmt.Sprintf("bta.v%s.server.jar", version),
		SHA256:   "", // the CDN publishes none; the installer computes and records one
		URL:      fmt.Sprintf("%s/%s/v%s/server.jar", s.endpoint(), channel, version),
	}}, nil
}

func btaVersion(tag string) (string, bool) {
	m := btaVersionPattern.FindStringSubmatch(strings.TrimSpace(tag))
	if m == nil {
		return "", false
	}
	return m[1], true
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

// ValidVersion accepts a BTA version such as 7.3, 7.3_04 or 8.0-pre3.
func (s *BTASource) ValidVersion(v string) error {
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
