package updates

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// PaperMC's v2 API was retired and now answers 410 Gone; v3 ("Fill") is the
// replacement and lives on its own host. Downloads are served from a separate
// data host, whose URL comes from the build metadata rather than being
// constructed here.
const fillAPI = "https://fill.papermc.io/v3/projects/paper"

// PaperSource installs PaperMC builds.
type PaperSource struct {
	// api is overridable in tests.
	api string
}

func NewPaperSource() *PaperSource { return &PaperSource{api: fillAPI} }

func (s *PaperSource) Flavour() string        { return "paper" }
func (s *PaperSource) ProjectName() string    { return "PaperMC" }
func (s *PaperSource) AllowsUnverified() bool { return false }
func (s *PaperSource) Bundle() bool           { return false }

func (s *PaperSource) DownloadHosts() []string {
	return []string{"fill-data.papermc.io", "fill.papermc.io"}
}

func (s *PaperSource) StagedName(version string, build int) string {
	return fmt.Sprintf("paper-%s-%d.jar", version, build)
}

func (s *PaperSource) endpoint() string {
	if s.api == "" {
		return fillAPI
	}
	return s.api
}

// Versions lists the Minecraft versions Paper supports, newest first.
//
// v3 groups versions by their minor line ({"1.21": ["1.21.4", ...]}), and JSON
// object order is not something to rely on, so the list is flattened and sorted
// here.
func (s *PaperSource) Versions(ctx context.Context, includePreReleases bool) ([]string, error) {
	var payload struct {
		Versions map[string][]string `json:"versions"`
	}
	if err := httpGetJSON(ctx, s.endpoint(), nil, &payload); err != nil {
		return nil, err
	}
	return flattenVersions(payload.Versions, includePreReleases), nil
}

// flattenVersions sorts numerically and, unless asked otherwise, drops
// pre-releases (anything with a suffix such as -rc1 or -pre2): they are not what
// a home server should be steered onto by default.
func flattenVersions(groups map[string][]string, includePreReleases bool) []string {
	out := make([]string, 0, 64)
	for _, versions := range groups {
		for _, version := range versions {
			if !includePreReleases && strings.Contains(version, "-") {
				continue
			}
			out = append(out, version)
		}
	}
	sort.Slice(out, func(i, j int) bool { return compareVersions(out[i], out[j]) > 0 })
	return out
}

// compareVersions orders Minecraft version strings numerically per component, so
// 1.21.11 sorts above 1.21.4 (a plain string sort gets that wrong) and the newer
// 26.x scheme sorts above the 1.x one. A pre-release sorts directly below the
// release it leads up to.
func compareVersions(a, b string) int {
	aBase, aPre, _ := strings.Cut(a, "-")
	bBase, bPre, _ := strings.Cut(b, "-")
	aParts, bParts := strings.Split(aBase, "."), strings.Split(bBase, ".")
	for i := 0; i < len(aParts) || i < len(bParts); i++ {
		var an, bn int
		if i < len(aParts) {
			an, _ = strconv.Atoi(aParts[i])
		}
		if i < len(bParts) {
			bn, _ = strconv.Atoi(bParts[i])
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

// fillBuild mirrors the parts of a v3 build object the add-on uses.
type fillBuild struct {
	ID        int       `json:"id"`
	Time      time.Time `json:"time"`
	Channel   string    `json:"channel"`
	Downloads map[string]struct {
		Name      string            `json:"name"`
		Checksums map[string]string `json:"checksums"`
		Size      int64             `json:"size"`
		URL       string            `json:"url"`
	} `json:"downloads"`
}

func (b fillBuild) toBuild() Build {
	out := Build{Build: b.ID, Channel: strings.ToLower(b.Channel), Time: b.Time}
	// The server JAR is published under this key; other keys (mojang mappings, for
	// example) are not what we install.
	if download, ok := b.Downloads["server:default"]; ok {
		out.FileName = download.Name
		out.SHA256 = download.Checksums["sha256"]
		out.URL = download.URL
	}
	return out
}

// Builds lists the builds of one version, newest first.
func (s *PaperSource) Builds(ctx context.Context, version string) ([]Build, error) {
	if err := s.ValidVersion(version); err != nil {
		return nil, err
	}
	var payload []fillBuild
	if err := httpGetJSON(ctx, s.endpoint()+"/versions/"+version+"/builds", nil, &payload); err != nil {
		return nil, err
	}
	out := make([]Build, 0, len(payload))
	for _, b := range payload {
		out = append(out, b.toBuild())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Build > out[j].Build })
	return out, nil
}

// ValidVersion keeps API paths free of anything but a Minecraft version string.
func (s *PaperSource) ValidVersion(v string) error {
	if v == "" {
		return fmt.Errorf("a Minecraft version is required")
	}
	if len(v) > 24 {
		return fmt.Errorf("version string is too long")
	}
	for _, r := range v {
		switch {
		case r >= '0' && r <= '9', r == '.', r == '-':
		case r >= 'a' && r <= 'z':
		default:
			return fmt.Errorf("invalid character %q in version", r)
		}
	}
	return nil
}
