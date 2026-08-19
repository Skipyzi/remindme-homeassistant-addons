package updates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Build is one downloadable server build.
type Build struct {
	Build    int       `json:"build"`
	Channel  string    `json:"channel"`
	Time     time.Time `json:"time"`
	FileName string    `json:"file_name"`
	SHA256   string    `json:"sha256"`
	URL      string    `json:"url"`
}

// Source is where a flavour's server JARs come from. Each flavour publishes its
// releases differently; everything after "which file, from where, with which
// checksum" - staging, verification, the swap and the rollback - is shared.
type Source interface {
	// Flavour is the backend name this source installs for.
	Flavour() string
	// ProjectName is what the UI calls the upstream project.
	ProjectName() string
	// Versions lists installable versions, newest first.
	Versions(ctx context.Context, includePreReleases bool) ([]string, error)
	// Builds lists the builds of one version, newest first.
	Builds(ctx context.Context, version string) ([]Build, error)
	// ValidVersion rejects anything that must not reach a URL path.
	ValidVersion(version string) error
	// DownloadHosts is the allow-list a JAR may be fetched from, including any
	// host the download may be redirected to.
	DownloadHosts() []string
	// StagedName is the file name a downloaded build is staged under.
	StagedName(version string, build int) string
	// AllowsUnverified is true only for a source that publishes no checksums at
	// all (BTA's own CDN). The installer then computes and records the SHA-256
	// of what it downloaded instead of refusing; every source that does publish
	// one is still verified against it and refused on mismatch.
	AllowsUnverified() bool
	// Bundle is true when the source ships a zip bundle (launcher, libraries,
	// mods) instead of a single server JAR.
	Bundle() bool
}

const (
	maxJarBytes = 200 << 20
	// userAgent identifies the add-on to the APIs it calls, which ask callers to
	// send something descriptive.
	userAgent = "home-assistant-minecraft-addon/1.0 (+https://github.com/skipyzi/remindme-homeassistant-addons)"
)

// httpGetJSON fetches and decodes a JSON document.
func httpGetJSON(ctx context.Context, endpoint string, headers map[string]string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("update API unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusGone {
			// This is what PaperMC's retired v2 API answers. If it happens again,
			// the add-on is talking to an endpoint that has been sunset.
			return fmt.Errorf("the update API reports this endpoint is gone (HTTP 410): %s - the add-on needs an update", endpoint)
		}
		return fmt.Errorf("update API returned HTTP %d for %s", resp.StatusCode, endpoint)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

// httpDownload fetches a server JAR.
//
// Only https and only the source's own hosts are accepted, and every redirect
// hop is checked as well: GitHub serves release assets by redirecting to a
// storage host, and following a redirect blindly would defeat the allow-list.
func httpDownload(ctx context.Context, rawURL string, hosts []string) ([]byte, error) {
	allowed := make(map[string]bool, len(hosts))
	for _, h := range hosts {
		allowed[h] = true
	}
	check := func(u *url.URL) error {
		if u.Scheme != "https" || !allowed[u.Host] {
			return fmt.Errorf("refusing to download a server JAR from %q", u.Host)
		}
		return nil
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid download URL: %w", err)
	}
	if err := check(parsed); err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	client := &http.Client{
		Timeout: 20 * time.Minute,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects while downloading the server JAR")
			}
			return check(r.URL)
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxJarBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxJarBytes {
		return nil, errors.New("the downloaded JAR is larger than the 200 MB limit")
	}
	return data, nil
}

// selectTarget resolves the build to install. Build 0 means "the newest stable
// one", which is what the install button and scheduled updates ask for; anything
// else has to match exactly.
//
// This lives next to pickStable on purpose: an earlier version of the install path
// had its own copy of the channel check, and it kept matching the pre-v3 channel
// name after PaperMC started reporting "STABLE", so build 0 resolved to nothing.
func selectTarget(builds []Build, build int, version string) (Build, error) {
	if build == 0 {
		if target, ok := pickStable(builds); ok {
			return target, nil
		}
		return Build{}, fmt.Errorf("no builds have been published for %s", version)
	}
	for _, candidate := range builds {
		if candidate.Build == build {
			return candidate, nil
		}
	}
	return Build{}, fmt.Errorf("build %d of %s not found", build, version)
}

// pickStable prefers a stable build and only falls back to a pre-release build
// when a version has nothing else, which is the case for a freshly opened
// Minecraft version.
func pickStable(builds []Build) (Build, bool) {
	for _, b := range builds {
		if b.Channel == "stable" || b.Channel == "default" {
			return b, true
		}
	}
	if len(builds) > 0 {
		return builds[0], true
	}
	return Build{}, false
}
