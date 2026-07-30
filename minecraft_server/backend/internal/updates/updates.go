// Package updates installs PaperMC builds in a controlled way: staged download,
// checksum verification, backup, atomic swap, health check and rollback.
package updates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/javaruntime"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

const (
	// PaperMC's v2 API was retired and now answers 410 Gone; v3 ("Fill") is the
	// replacement and lives on its own host. Downloads are served from a separate
	// data host, whose URL comes from the build metadata rather than being
	// constructed here.
	fillAPI      = "https://fill.papermc.io/v3/projects/paper"
	maxJarBytes  = 200 << 20
	previousName = "paper.jar.previous"
	// userAgent identifies the add-on to the PaperMC API, which asks callers to
	// send something descriptive.
	userAgent = "home-assistant-minecraft-addon/1.0 (+https://github.com/skipyzi/remindme-homeassistant-addons)"
)

// downloadHosts are the only hosts a server JAR may be fetched from.
var downloadHosts = map[string]bool{
	"fill-data.papermc.io": true,
	"fill.papermc.io":      true,
}

type Deps struct {
	Paths      appcfg.Paths
	Settings   *appcfg.Store
	Store      *store.Store
	Bus        *events.Bus
	Supervisor *supervisor.Supervisor
	Log        *slog.Logger
	Backup      func(ctx context.Context, worldID, kind, label string, lease *supervisor.Lease) error
	ActiveWorld func() string
	// CheckJava reports whether the container has a JVM that can run a JAR. It is
	// consulted before the staged JAR replaces the installed one.
	CheckJava    func(jarPath string) error
	StartTimeout time.Duration
}

type Manager struct {
	deps Deps
	log  *slog.Logger
}

func NewManager(d Deps) *Manager {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.StartTimeout <= 0 {
		d.StartTimeout = 5 * time.Minute
	}
	return &Manager{deps: d, log: d.Log.With("component", "updates")}
}

// Build is one PaperMC build.
type Build struct {
	Build    int       `json:"build"`
	Channel  string    `json:"channel"`
	Time     time.Time `json:"time"`
	FileName string    `json:"file_name"`
	SHA256   string    `json:"sha256"`
	URL      string    `json:"url"`
}

// Installed describes the JAR currently on disk.
type Installed struct {
	Present     bool   `json:"present"`
	Version     string `json:"version"`
	Build       int    `json:"build"`
	SizeBytes   int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
	ModifiedAt  string `json:"modified_at"`
	HasPrevious bool   `json:"has_previous"`
	// RequiredJava is what the installed JAR declares it needs, and JavaRuntimes
	// is what the container has, so the UI can explain a refusal.
	RequiredJava  int    `json:"required_java,omitempty"`
	JavaRuntimes  string `json:"java_runtimes,omitempty"`
	JavaSupported bool   `json:"java_supported"`
	JavaProblem   string `json:"java_problem,omitempty"`
}

func (m *Manager) Installed() Installed {
	settings := m.deps.Settings.Get()
	out := Installed{Version: settings.PaperVersion, Build: settings.PaperBuild}
	st, err := os.Stat(m.deps.Paths.ServerJar())
	if err != nil {
		return out
	}
	out.Present = true
	out.SizeBytes = st.Size()
	out.ModifiedAt = st.ModTime().UTC().Format(time.RFC3339)
	if raw, err := os.ReadFile(m.deps.Paths.ServerJar()); err == nil {
		sum := sha256.Sum256(raw)
		out.SHA256 = hex.EncodeToString(sum[:])
	}
	if _, err := os.Stat(filepath.Join(m.deps.Paths.Jars(), previousName)); err == nil {
		out.HasPrevious = true
	}
	if info, err := paper.InspectJar(m.deps.Paths.ServerJar()); err == nil {
		out.RequiredJava = info.RequiredJava
		if info.MinecraftVersion != "" && out.Version == "" {
			out.Version = info.MinecraftVersion
		}
	}
	runtimes := javaruntime.Discover()
	out.JavaRuntimes = javaruntime.Describe(runtimes)
	if _, err := javaruntime.Select(runtimes, out.RequiredJava); err != nil {
		out.JavaProblem = err.Error()
	} else {
		out.JavaSupported = true
	}
	return out
}

// Versions lists the Minecraft versions Paper supports, newest first.
//
// v3 groups versions by their minor line ({"1.21": ["1.21.4", ...]}), and JSON
// object order is not something to rely on, so the list is flattened and sorted
// here. Pre-releases (anything with a suffix such as -rc1 or -pre2) are left out:
// they are not what a home server should be offered by default.
func (m *Manager) Versions(ctx context.Context) ([]string, error) {
	var payload struct {
		Versions map[string][]string `json:"versions"`
	}
	if err := m.getJSON(ctx, fillAPI, &payload); err != nil {
		return nil, err
	}
	return flattenVersions(payload.Versions), nil
}

func flattenVersions(groups map[string][]string) []string {
	out := make([]string, 0, 64)
	for _, versions := range groups {
		for _, version := range versions {
			if strings.Contains(version, "-") {
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
// 26.x scheme sorts above the 1.x one.
func compareVersions(a, b string) int {
	aParts, bParts := strings.Split(a, "."), strings.Split(b, ".")
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
	return 0
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
func (m *Manager) Builds(ctx context.Context, version string) ([]Build, error) {
	if err := validVersion(version); err != nil {
		return nil, err
	}
	var payload []fillBuild
	if err := m.getJSON(ctx, fillAPI+"/versions/"+version+"/builds", &payload); err != nil {
		return nil, err
	}
	out := make([]Build, 0, len(payload))
	for _, b := range payload {
		out = append(out, b.toBuild())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Build > out[j].Build })
	return out, nil
}

// LatestStable returns the newest build on the stable channel for a version.
func (m *Manager) LatestStable(ctx context.Context, version string) (Build, error) {
	builds, err := m.Builds(ctx, version)
	if err != nil {
		return Build{}, err
	}
	if build, ok := pickStable(builds); ok {
		return build, nil
	}
	return Build{}, fmt.Errorf("no builds published for %s", version)
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

// Available reports what could be installed.
type Available struct {
	Installed      Installed `json:"installed"`
	TargetVersion  string    `json:"target_version"`
	LatestBuild    int       `json:"latest_build"`
	LatestChannel  string    `json:"latest_channel"`
	LatestSHA256   string    `json:"latest_sha256"`
	UpdateAvailable bool     `json:"update_available"`
	Versions       []string  `json:"versions,omitempty"`
	Error          string    `json:"error,omitempty"`
}

func (m *Manager) Check(ctx context.Context, version string) Available {
	out := Available{Installed: m.Installed()}
	if version == "" {
		version = m.deps.Settings.Get().PaperVersion
	}
	versions, err := m.Versions(ctx)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Versions = versions
	if version == "" && len(versions) > 0 {
		version = versions[0]
	}
	out.TargetVersion = version
	build, err := m.LatestStable(ctx, version)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.LatestBuild = build.Build
	out.LatestChannel = build.Channel
	out.LatestSHA256 = build.SHA256
	out.UpdateAvailable = !out.Installed.Present ||
		out.Installed.Version != version || out.Installed.Build < build.Build
	return out
}

// Result reports what an install did.
type Result struct {
	Version    string `json:"version"`
	Build      int    `json:"build"`
	Previous   string `json:"previous"`
	Started    bool   `json:"started"`
	RolledBack bool   `json:"rolled_back"`
	SHA256     string `json:"sha256"`
}

// Install downloads and activates a build.
//
// Nothing is installed without an explicit request; scheduled updates only exist
// when the operator turns them on. The previous JAR is kept so a failed start can
// be undone immediately.
func (m *Manager) Install(ctx context.Context, version string, build int, actor string) (Result, error) {
	result := Result{Version: version, Build: build}
	if err := validVersion(version); err != nil {
		return result, err
	}

	builds, err := m.Builds(ctx, version)
	if err != nil {
		return result, err
	}
	var target *Build
	for i := range builds {
		if build == 0 || builds[i].Build == build {
			if build == 0 && builds[i].Channel != "default" {
				continue
			}
			target = &builds[i]
			break
		}
	}
	if target == nil {
		return result, fmt.Errorf("build %d of %s not found", build, version)
	}
	result.Build = target.Build
	result.SHA256 = target.SHA256
	if target.SHA256 == "" {
		return result, errors.New("PaperMC did not publish a checksum for this build; refusing to install it")
	}

	lease, err := m.deps.Supervisor.Acquire(supervisor.ActivityUpdating)
	if err != nil {
		return result, err
	}
	defer m.deps.Supervisor.Release(lease)

	journalID, _ := m.deps.Store.JournalBegin(store.OpUpdate, "download", map[string]any{
		"version": version, "build": target.Build, "actor": actor,
	})
	failed := func(err error) (Result, error) {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		m.deps.Bus.Fail("updates", "update failed: "+err.Error())
		return result, err
	}

	// 1. Download to staging and verify. The URL comes from the build metadata; it
	// points at PaperMC's content-addressed data host, so it is not constructed
	// here and it is checked against the allow-list before use.
	if target.URL == "" {
		return failed(errors.New("PaperMC did not publish a download URL for this build"))
	}
	m.deps.Supervisor.Note("downloading %s build %d", version, target.Build)
	data, err := m.download(ctx, target.URL)
	if err != nil {
		return failed(err)
	}
	sum := sha256.Sum256(data)
	actual := hex.EncodeToString(sum[:])
	if actual != target.SHA256 {
		return failed(fmt.Errorf("checksum mismatch: expected %s, got %s", target.SHA256, actual))
	}
	staged := filepath.Join(m.deps.Paths.Jars(), fmt.Sprintf("paper-%s-%d.jar", version, target.Build))
	if err := atomicfs.WriteFile(staged, data, 0o644); err != nil {
		return failed(err)
	}

	// 1b. Refuse a JAR this container cannot run, before anything is swapped.
	// Minecraft 26.x needs Java 25; the alternative would be a download, a stop, a
	// failed start and a rollback to tell the operator the same thing.
	if m.deps.CheckJava != nil {
		if err := m.deps.CheckJava(staged); err != nil {
			_ = os.Remove(staged)
			return failed(err)
		}
	}

	// 2. Back up the world and the configuration before changing the server.
	if m.deps.Backup != nil {
		worldID := m.deps.ActiveWorld()
		if worldID != "" {
			m.deps.Supervisor.Note("backing up %s before the update", worldID)
			if err := m.deps.Backup(ctx, worldID, "pre_update",
				fmt.Sprintf("before %s build %d", version, target.Build), lease); err != nil {
				return failed(fmt.Errorf("pre-update backup failed: %w", err))
			}
		}
	}

	// 3. Stop the server.
	wasRunning := m.deps.Supervisor.IsRunning() || m.deps.Supervisor.State() == supervisor.StateStarting
	if wasRunning {
		if err := m.deps.Supervisor.Stop(ctx, supervisor.StopOptions{Reason: "server update"}); err != nil {
			return failed(fmt.Errorf("could not stop Minecraft: %w", err))
		}
	}

	// 4. Swap the JAR, keeping the old one.
	_ = m.deps.Store.JournalPhase(journalID, "swap", map[string]any{"staged": staged})
	previous := filepath.Join(m.deps.Paths.Jars(), previousName)
	if current, err := os.ReadFile(m.deps.Paths.ServerJar()); err == nil {
		if err := atomicfs.WriteFile(previous, current, 0o644); err != nil {
			m.log.Warn("could not keep the previous JAR", "error", err)
		} else {
			result.Previous = previous
		}
	}
	if err := atomicfs.WriteFile(m.deps.Paths.ServerJar(), data, 0o644); err != nil {
		return failed(err)
	}
	prevSettings := m.deps.Settings.Get()
	if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) {
		s.PaperVersion = version
		s.PaperBuild = target.Build
	}); err != nil {
		return failed(err)
	}

	// 5. Start and verify, rolling back on failure.
	if wasRunning {
		_ = m.deps.Store.JournalPhase(journalID, "verify", nil)
		startErr := m.deps.Supervisor.Start()
		if startErr == nil {
			readyCtx, cancel := context.WithTimeout(ctx, m.deps.StartTimeout)
			startErr = m.deps.Supervisor.WaitReady(readyCtx)
			cancel()
		}
		if startErr != nil {
			m.deps.Bus.Fail("updates", "the new build did not start; rolling back")
			m.rollback(ctx, prevSettings, previous, wasRunning)
			result.RolledBack = true
			return failed(fmt.Errorf("the new build failed to start (%w); the previous JAR was restored", startErr))
		}
		result.Started = true
	}

	_ = m.deps.Store.JournalEnd(journalID, store.JournalDone, "")
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "server.update", Target: version,
		Detail: fmt.Sprintf("build=%d sha256=%s started=%t", target.Build, actual[:16], result.Started)})
	m.deps.Bus.Publish(events.TypeSettingsChanged, map[string]any{
		"paper_version": version, "paper_build": target.Build,
	})
	return result, nil
}

func (m *Manager) rollback(ctx context.Context, prev appcfg.Settings, previousJar string, wasRunning bool) {
	if m.deps.Supervisor.IsRunning() || m.deps.Supervisor.State() == supervisor.StateStarting {
		_ = m.deps.Supervisor.Stop(ctx, supervisor.StopOptions{Reason: "update rollback"})
	}
	if previousJar != "" {
		if raw, err := os.ReadFile(previousJar); err == nil {
			if err := atomicfs.WriteFile(m.deps.Paths.ServerJar(), raw, 0o644); err != nil {
				m.deps.Bus.Fail("updates", "could not restore the previous JAR: "+err.Error())
			}
		}
	}
	if _, err := m.deps.Settings.Update(func(s *appcfg.Settings) {
		s.PaperVersion = prev.PaperVersion
		s.PaperBuild = prev.PaperBuild
	}); err != nil {
		m.log.Warn("could not restore version settings", "error", err)
	}
	if wasRunning {
		if err := m.deps.Supervisor.Start(); err != nil {
			m.deps.Bus.Fail("updates", "rollback could not restart Minecraft: "+err.Error())
		}
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: "controller", Action: "server.update_rollback",
		Target: prev.PaperVersion, Detail: "the new build failed to start", Result: "error"})
}

// EnsureInstalled downloads the newest stable build when no JAR exists yet. It is
// called only when the user asks for it from the UI.
func (m *Manager) EnsureInstalled(ctx context.Context, actor string) (Result, error) {
	if m.Installed().Present {
		return Result{}, errors.New("a server JAR is already installed")
	}
	version := m.deps.Settings.Get().PaperVersion
	if version == "" {
		versions, err := m.Versions(ctx)
		if err != nil {
			return Result{}, err
		}
		if len(versions) == 0 {
			return Result{}, errors.New("PaperMC returned no versions")
		}
		version = versions[0]
	}
	return m.Install(ctx, version, 0, actor)
}

func (m *Manager) getJSON(ctx context.Context, endpoint string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("PaperMC API unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusGone {
			// This is what the retired v2 API answers. If it ever happens again,
			// the add-on is talking to an endpoint PaperMC has sunset.
			return fmt.Errorf("PaperMC reports this API endpoint is gone (HTTP 410): %s - the add-on needs an update", endpoint)
		}
		return fmt.Errorf("PaperMC API returned HTTP %d for %s", resp.StatusCode, endpoint)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

func (m *Manager) download(ctx context.Context, rawURL string) ([]byte, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid download URL: %w", err)
	}
	if parsed.Scheme != "https" || !downloadHosts[parsed.Host] {
		return nil, fmt.Errorf("refusing to download a server JAR from %q", parsed.Host)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := (&http.Client{Timeout: 20 * time.Minute}).Do(req)
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

// validVersion keeps API paths free of anything but a Minecraft version string.
func validVersion(v string) error {
	if v == "" {
		return errors.New("a Minecraft version is required")
	}
	if len(v) > 24 {
		return errors.New("version string is too long")
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
