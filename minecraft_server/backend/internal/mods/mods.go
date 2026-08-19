// Package mods installs server-side content - plugins for Paper, Fabric mods
// for Babric - from Modrinth, the same trusted source Chunky already comes
// from. Every download is verified against the SHA-512 Modrinth publishes for
// the file, restricted to Modrinth's CDN host, filtered to the flavour's loader
// and to content whose server_side flag says it runs on a server at all.
//
// Installs are additive and recoverable (a mod is removed by deleting its
// file), so unlike server updates they carry no journal - only an audit entry
// and a restart-required flag.
package mods

import (
	"context"
	"crypto/sha512"
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
	"strings"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

const (
	modrinthAPI  = "https://api.modrinth.com/v2"
	cdnHost      = "cdn.modrinth.com"
	maxModBytes  = 100 << 20
	userAgent    = "home-assistant-minecraft-addon/1.0 (+https://github.com/skipyzi/remindme-homeassistant-addons)"
	manifestName = ".mods.json"
)

var ErrUnsupported = errors.New("this server flavour cannot load mods or plugins")

type Deps struct {
	Paths    appcfg.Paths
	Backend  adapter.Backend
	Settings *appcfg.Store
	Store    *store.Store
	Bus      *events.Bus
	Log      *slog.Logger
	// API is overridable in tests; empty means the real Modrinth.
	API string
	// Client is overridable in tests.
	Client *http.Client
}

type Manager struct {
	deps Deps
	log  *slog.Logger
}

func New(d Deps) *Manager {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Client == nil {
		d.Client = &http.Client{Timeout: 5 * time.Minute}
	}
	return &Manager{deps: d, log: d.Log.With("component", "mods")}
}

func (m *Manager) api() string {
	if m.deps.API != "" {
		return m.deps.API
	}
	return modrinthAPI
}

// loader is the Modrinth loader of the active flavour, empty when the flavour
// cannot load content.
func (m *Manager) loader() string { return m.deps.Backend.Capabilities().ModLoader }

// loaderFamily is every Modrinth loader tag the flavour can actually load:
// Paper runs Bukkit and Spigot plugins unchanged, and much of the ecosystem is
// tagged only with those.
func (m *Manager) loaderFamily() []string {
	switch m.loader() {
	case "paper":
		return []string{"paper", "bukkit", "spigot", "folia"}
	case "":
		return nil
	default:
		return []string{m.loader()}
	}
}

// Dir is the directory installed content lives in.
func (m *Manager) Dir() (string, error) {
	caps := m.deps.Backend.Capabilities()
	if caps.ModLoader == "" || caps.ModDir == "" {
		return "", ErrUnsupported
	}
	return appcfg.Confine(m.deps.Paths.Runtime(), caps.ModDir)
}

// ------------------------------------------------------------------ records --

// Installed is one piece of content the manager put there (or adopted).
type Installed struct {
	Project     string    `json:"project"`
	Title       string    `json:"title"`
	VersionID   string    `json:"version_id"`
	Version     string    `json:"version"`
	FileName    string    `json:"file_name"`
	SHA512      string    `json:"sha512"`
	SizeBytes   int64     `json:"size_bytes"`
	InstalledAt time.Time `json:"installed_at"`
	// Managed is false for a jar somebody dropped into the directory by hand;
	// it is listed and removable, but has no project to check updates against.
	Managed bool `json:"managed"`
	// Pack records which curated pack installed it, if any.
	Pack string `json:"pack,omitempty"`
}

// manifest is the on-disk record, stored inside the mod directory itself so it
// travels with the runtime (and with the flavour).
type manifest struct {
	Mods []Installed `json:"mods"`
}

func (m *Manager) manifestPath() (string, error) {
	dir, err := m.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, manifestName), nil
}

func (m *Manager) readManifest() (manifest, error) {
	var out manifest
	path, err := m.manifestPath()
	if err != nil {
		return out, err
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		// A corrupt manifest must not brick the page; the files are still there
		// and will be adopted as unmanaged.
		m.log.Warn("mod manifest unreadable, starting over", "error", err)
		return manifest{}, nil
	}
	return out, nil
}

func (m *Manager) writeManifest(mf manifest) error {
	path, err := m.manifestPath()
	if err != nil {
		return err
	}
	sort.Slice(mf.Mods, func(i, j int) bool { return mf.Mods[i].FileName < mf.Mods[j].FileName })
	raw, err := json.MarshalIndent(mf, "", "  ")
	if err != nil {
		return err
	}
	return atomicfs.WriteFile(path, append(raw, '\n'), 0o644)
}

// List returns everything in the mod directory: managed entries from the
// manifest plus any jar that was dropped in by hand.
func (m *Manager) List() ([]Installed, error) {
	dir, err := m.Dir()
	if err != nil {
		return nil, err
	}
	mf, err := m.readManifest()
	if err != nil {
		return nil, err
	}
	byFile := map[string]Installed{}
	for _, entry := range mf.Mods {
		byFile[entry.FileName] = entry
	}

	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []Installed{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]Installed, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".jar") {
			continue
		}
		// The management bridge is add-on infrastructure, not user content; it is
		// neither installable nor removable here, so listing it only invites a
		// remove attempt that will be refused.
		if strings.EqualFold(e.Name(), "mcbridge.jar") {
			continue
		}
		if known, ok := byFile[e.Name()]; ok {
			out = append(out, known)
			continue
		}
		info, _ := e.Info()
		var size int64
		var mod time.Time
		if info != nil {
			size = info.Size()
			mod = info.ModTime()
		}
		out = append(out, Installed{
			FileName: e.Name(), Title: e.Name(), SizeBytes: size,
			InstalledAt: mod, Managed: false,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FileName < out[j].FileName })
	return out, nil
}

// Remove deletes one jar and its record. The bridge plugin is part of the
// add-on, not installable through this manager and not removable through it.
func (m *Manager) Remove(fileName, actor string) error {
	if err := safeJarName(fileName); err != nil {
		return fmt.Errorf("invalid file name: %w", err)
	}
	if strings.EqualFold(fileName, "mcbridge.jar") {
		return errors.New("the management bridge is part of the add-on and cannot be removed here")
	}
	dir, err := m.Dir()
	if err != nil {
		return err
	}
	full, err := appcfg.Confine(dir, fileName)
	if err != nil {
		return err
	}
	if err := os.Remove(full); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%s is not installed", fileName)
		}
		return err
	}
	mf, _ := m.readManifest()
	kept := mf.Mods[:0]
	for _, entry := range mf.Mods {
		if entry.FileName != fileName {
			kept = append(kept, entry)
		}
	}
	mf.Mods = kept
	if err := m.writeManifest(mf); err != nil {
		m.log.Warn("could not update the mod manifest", "error", err)
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "mods.remove", Target: fileName})
	m.deps.Bus.Publish(events.TypeConfigChanged, map[string]any{"file": fileName, "restart_required": true})
	return nil
}

// ------------------------------------------------------------------- fetch ---

func (m *Manager) getJSON(ctx context.Context, endpoint string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := m.deps.Client.Do(req)
	if err != nil {
		return fmt.Errorf("Modrinth is unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Modrinth returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
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
	// In tests the API stub also serves the files; outside tests only Modrinth's
	// content-addressed CDN is acceptable.
	if m.deps.API == "" && (parsed.Scheme != "https" || parsed.Host != cdnHost) {
		return nil, fmt.Errorf("refusing to download a mod from %q", parsed.Host)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := m.deps.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxModBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxModBytes {
		return nil, fmt.Errorf("the file is larger than the %d MB limit", maxModBytes>>20)
	}
	return data, nil
}

// checksum512 is what everything installed here is verified with.
func checksum512(data []byte) string {
	sum := sha512.Sum512(data)
	return hex.EncodeToString(sum[:])
}
