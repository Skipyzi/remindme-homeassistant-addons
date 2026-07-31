// Package generation drives terrain pre-generation through Chunky and keeps it
// inside a safety envelope: it pauses when players join, when the Pi gets hot,
// when TPS drops, when the system is busy or when disk space runs low.
package generation

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

// Trusted download hosts. Anything else is refused even when the user configures
// it, unless they also supply an expected checksum (source "url").
var trustedHosts = map[string]bool{
	"api.modrinth.com": true,
	"cdn.modrinth.com": true,
}

const (
	maxPluginBytes = 32 << 20
	pluginFileName = "Chunky.jar"
)

// PluginStatus describes the installed terrain generation plugin.
type PluginStatus struct {
	Installed   bool   `json:"installed"`
	FileName    string `json:"file_name"`
	SizeBytes   int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
	InstalledAt string `json:"installed_at"`
	Source      string `json:"source"`
	Version     string `json:"version"`
	// Available is what the configured source offers for the running server
	// version, filled in by CheckForUpdate.
	Available string `json:"available_version,omitempty"`
	// Problem explains why the plugin cannot be installed at all.
	Problem string `json:"problem,omitempty"`
}

func (m *Manager) PluginStatus() PluginStatus {
	status := PluginStatus{FileName: pluginFileName}
	if !m.Supported() {
		status.Problem = ErrUnsupported.Error()
		return status
	}
	path := filepath.Join(m.deps.Paths.Plugins(), pluginFileName)
	st, err := os.Stat(path)
	if err != nil {
		// Accept a manually installed jar under any name containing "chunky".
		if entries, err := os.ReadDir(m.deps.Paths.Plugins()); err == nil {
			for _, e := range entries {
				if !e.IsDir() && strings.Contains(strings.ToLower(e.Name()), "chunky") &&
					strings.HasSuffix(e.Name(), ".jar") {
					if info, err := e.Info(); err == nil {
						status.Installed = true
						status.FileName = e.Name()
						status.SizeBytes = info.Size()
						status.InstalledAt = info.ModTime().UTC().Format(time.RFC3339)
						status.Source = "manual"
					}
					break
				}
			}
		}
		if v, ok, _ := m.deps.Store.GetKV("generation.plugin_version"); ok {
			status.Version = v
		}
		return status
	}
	status.Installed = true
	status.SizeBytes = st.Size()
	status.InstalledAt = st.ModTime().UTC().Format(time.RFC3339)
	if raw, err := os.ReadFile(path); err == nil {
		sum := sha256.Sum256(raw)
		status.SHA256 = hex.EncodeToString(sum[:])
	}
	if v, ok, _ := m.deps.Store.GetKV("generation.plugin_version"); ok {
		status.Version = v
	}
	if v, ok, _ := m.deps.Store.GetKV("generation.plugin_source"); ok {
		status.Source = v
	}
	return status
}

// modrinthVersion is the subset of the Modrinth API response we rely on.
type modrinthVersion struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	VersionNumber string   `json:"version_number"`
	GameVersions  []string `json:"game_versions"`
	Loaders       []string `json:"loaders"`
	DatePublished string   `json:"date_published"`
	VersionType   string   `json:"version_type"`
	Files         []struct {
		URL      string            `json:"url"`
		Filename string            `json:"filename"`
		Primary  bool              `json:"primary"`
		Size     int64             `json:"size"`
		Hashes   map[string]string `json:"hashes"`
	} `json:"files"`
}

// InstallPlugin downloads Chunky from the configured trusted source and verifies
// it before installing.
//
// Nothing is downloaded automatically: this runs only when the user asks for it.
// Modrinth publishes a SHA-512 for every file in its release metadata, and that
// hash - not the file we just downloaded - is what the download is checked
// against.
func (m *Manager) InstallPlugin(ctx context.Context, actor string) (PluginStatus, error) {
	if !m.Supported() {
		return PluginStatus{}, ErrUnsupported
	}
	opts := m.deps.Options
	switch opts.ChunkySource {
	case "manual":
		return m.PluginStatus(), errors.New("the Chunky source is set to manual: copy the JAR into /data/runtime/paper/plugins yourself")
	case "url":
		return m.installFromURL(ctx, opts.ChunkyDownloadURL, opts.ChunkySHA256, "url", "", actor)
	case "modrinth", "":
		version, err := m.resolveModrinthVersion(ctx)
		if err != nil {
			return m.PluginStatus(), err
		}
		var fileURL, expected, name string
		for _, f := range version.Files {
			if f.Primary || fileURL == "" {
				fileURL = f.URL
				expected = f.Hashes["sha512"]
				name = f.Filename
			}
		}
		if fileURL == "" || expected == "" {
			return m.PluginStatus(), errors.New("Modrinth did not provide a file with a checksum")
		}
		return m.installFromURL(ctx, fileURL, "sha512:"+expected, "modrinth", version.VersionNumber+" ("+name+")", actor)
	default:
		return m.PluginStatus(), fmt.Errorf("unknown Chunky source %q", opts.ChunkySource)
	}
}

// CheckForUpdate reports the newest compatible Chunky version without installing.
func (m *Manager) CheckForUpdate(ctx context.Context) (PluginStatus, error) {
	status := m.PluginStatus()
	if m.deps.Options.ChunkySource != "modrinth" && m.deps.Options.ChunkySource != "" {
		return status, nil
	}
	version, err := m.resolveModrinthVersion(ctx)
	if err != nil {
		return status, err
	}
	status.Available = version.VersionNumber
	return status, nil
}

func (m *Manager) resolveModrinthVersion(ctx context.Context) (modrinthVersion, error) {
	gameVersion := m.deps.ServerVersion()
	endpoint := "https://api.modrinth.com/v2/project/chunky/version?loaders=%5B%22paper%22%5D"
	if gameVersion != "" {
		endpoint += "&game_versions=%5B%22" + url.QueryEscape(gameVersion) + "%22%5D"
	}
	body, err := m.fetch(ctx, endpoint, 4<<20)
	if err != nil {
		return modrinthVersion{}, err
	}
	var versions []modrinthVersion
	if err := json.Unmarshal(body, &versions); err != nil {
		return modrinthVersion{}, fmt.Errorf("parse Modrinth response: %w", err)
	}
	for _, v := range versions {
		if v.VersionType == "release" && len(v.Files) > 0 {
			return v, nil
		}
	}
	if len(versions) > 0 {
		return versions[0], nil
	}
	if gameVersion != "" {
		return modrinthVersion{}, fmt.Errorf("Modrinth has no Chunky release for Paper %s", gameVersion)
	}
	return modrinthVersion{}, errors.New("Modrinth returned no Chunky releases")
}

func (m *Manager) installFromURL(ctx context.Context, rawURL, expectedHash, source, version, actor string) (PluginStatus, error) {
	if rawURL == "" {
		return m.PluginStatus(), errors.New("no download URL configured")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return m.PluginStatus(), fmt.Errorf("invalid download URL: %w", err)
	}
	if parsed.Scheme != "https" {
		return m.PluginStatus(), errors.New("plugin downloads must use https")
	}
	if source == "modrinth" && !trustedHosts[parsed.Host] {
		return m.PluginStatus(), fmt.Errorf("refusing to download from untrusted host %q", parsed.Host)
	}
	if expectedHash == "" {
		return m.PluginStatus(), errors.New("a checksum is required before a plugin is installed")
	}

	body, err := m.fetch(ctx, rawURL, maxPluginBytes)
	if err != nil {
		return m.PluginStatus(), err
	}
	if err := verifyHash(body, expectedHash); err != nil {
		_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "generation.plugin_rejected",
			Target: parsed.Host, Detail: err.Error(), Result: "error"})
		return m.PluginStatus(), err
	}
	if !looksLikeJar(body) {
		return m.PluginStatus(), errors.New("the downloaded file is not a JAR archive")
	}

	staged := filepath.Join(m.deps.Paths.Jars(), pluginFileName+".staged")
	if err := atomicfs.WriteFile(staged, body, 0o644); err != nil {
		return m.PluginStatus(), err
	}
	target := filepath.Join(m.deps.Paths.Plugins(), pluginFileName)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return m.PluginStatus(), err
	}
	if err := os.Rename(staged, target); err != nil {
		// Cross-device rename inside /data should not happen, but copy anyway.
		if err := atomicfs.CopyFile(staged, target); err != nil {
			return m.PluginStatus(), err
		}
		_ = os.Remove(staged)
	}
	sum := sha256.Sum256(body)
	_ = m.deps.Store.SetKV("generation.plugin_version", version)
	_ = m.deps.Store.SetKV("generation.plugin_source", source)
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "generation.plugin_install",
		Target: pluginFileName,
		Detail: fmt.Sprintf("source=%s host=%s version=%s bytes=%d sha256=%s",
			source, parsed.Host, version, len(body), hex.EncodeToString(sum[:])[:16])})
	m.deps.Bus.Warn("generation", "Chunky was installed; restart Minecraft to load it")
	return m.PluginStatus(), nil
}

func (m *Manager) fetch(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "home-assistant-minecraft-addon/1.0 (+https://github.com/skipyzi)")
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("download exceeds the %d byte limit", limit)
	}
	return body, nil
}

// verifyHash accepts "sha256:<hex>", "sha512:<hex>" or a bare SHA-256 hex string.
func verifyHash(data []byte, expected string) error {
	algo := "sha256"
	value := strings.ToLower(strings.TrimSpace(expected))
	if idx := strings.Index(value, ":"); idx > 0 {
		algo = value[:idx]
		value = value[idx+1:]
	}
	var actual string
	switch algo {
	case "sha256":
		sum := sha256.Sum256(data)
		actual = hex.EncodeToString(sum[:])
	case "sha512":
		sum := sha512.Sum512(data)
		actual = hex.EncodeToString(sum[:])
	default:
		return fmt.Errorf("unsupported checksum algorithm %q", algo)
	}
	if actual != value {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", value, actual)
	}
	return nil
}

func looksLikeJar(data []byte) bool {
	return len(data) > 4 && data[0] == 'P' && data[1] == 'K' && (data[2] == 3 || data[2] == 5 || data[2] == 7)
}
