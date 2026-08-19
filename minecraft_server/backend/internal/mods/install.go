package mods

import (
	"context"
	"crypto/subtle"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
)

// Install downloads a project's best-matching version, verifies it against the
// SHA-512 Modrinth publishes, and places it in the flavour's mod directory. The
// server picks it up on the next start; nothing is restarted implicitly.
func (m *Manager) Install(ctx context.Context, project, actor, pack string) (Installed, error) {
	version, err := m.resolve(ctx, project)
	if err != nil {
		return Installed{}, err
	}

	fileIdx := -1
	for i := range version.Files {
		if version.Files[i].Primary || fileIdx == -1 {
			fileIdx = i
		}
	}
	if fileIdx == -1 {
		return Installed{}, fmt.Errorf("%s publishes no files for this version", project)
	}
	file := &version.Files[fileIdx]
	expected := file.Hashes["sha512"]
	if expected == "" {
		return Installed{}, fmt.Errorf("%s publishes no sha512 for %s; refusing to install it", project, file.Filename)
	}
	if err := safeJarName(file.Filename); err != nil {
		return Installed{}, fmt.Errorf("the published file name is not safe: %w", err)
	}
	if !strings.HasSuffix(strings.ToLower(file.Filename), ".jar") {
		return Installed{}, fmt.Errorf("%s is not a jar; only plain jars are installed here", file.Filename)
	}

	data, err := m.download(ctx, file.URL)
	if err != nil {
		return Installed{}, err
	}
	actual := checksum512(data)
	if subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) != 1 {
		return Installed{}, fmt.Errorf("checksum mismatch for %s: expected %s…, got %s…",
			file.Filename, expected[:16], actual[:16])
	}

	dir, err := m.Dir()
	if err != nil {
		return Installed{}, err
	}
	target, err := appcfg.Confine(dir, file.Filename)
	if err != nil {
		return Installed{}, err
	}
	if err := atomicfs.WriteFile(target, data, 0o644); err != nil {
		return Installed{}, err
	}

	entry := Installed{
		Project:   project,
		Title:     project,
		VersionID: version.ID,
		Version:   version.VersionNumber,
		FileName:  file.Filename,
		SHA512:    actual,
		SizeBytes: int64(len(data)),
		Managed:   true,
		Pack:      pack,
	}
	entry.InstalledAt = version.Published
	mf, _ := m.readManifest()
	kept := mf.Mods[:0]
	for _, existing := range mf.Mods {
		// An update replaces the record even when the file name changed.
		if existing.Project == project {
			if existing.FileName != file.Filename {
				_ = m.removeFile(existing.FileName)
			}
			continue
		}
		kept = append(kept, existing)
	}
	mf.Mods = append(kept, entry)
	if err := m.writeManifest(mf); err != nil {
		m.log.Warn("could not record the install", "error", err)
	}

	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "mods.install", Target: project,
		Detail: fmt.Sprintf("version=%s file=%s sha512=%s pack=%s", version.VersionNumber, file.Filename, actual[:16], pack)})
	m.deps.Bus.Publish(events.TypeConfigChanged, map[string]any{"file": file.Filename, "restart_required": true})
	return entry, nil
}

func (m *Manager) removeFile(name string) error {
	dir, err := m.Dir()
	if err != nil {
		return err
	}
	full, err := appcfg.Confine(dir, name)
	if err != nil {
		return err
	}
	err = os.Remove(full)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// safeJarName accepts the file names Modrinth actually publishes - version
// numbers routinely carry '+' (halplibe-6.1.4+8.0.jar), which the stricter
// world-name rule refuses - while still rejecting anything that could act as a
// path or hide its nature.
func safeJarName(name string) error {
	if name == "" || len(name) > 200 {
		return fmt.Errorf("empty or overlong file name")
	}
	if strings.HasPrefix(name, ".") {
		return fmt.Errorf("hidden file names are not accepted")
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.', r == '+', r == '(', r == ')', r == ' ':
		default:
			return fmt.Errorf("character %q is not allowed in a file name", r)
		}
	}
	return nil
}

// UpdateCheck reports, per managed mod, the newest matching version when it
// differs from the installed one.
type UpdateCheck struct {
	Project   string `json:"project"`
	Installed string `json:"installed"`
	Available string `json:"available"`
}

func (m *Manager) Updates(ctx context.Context) ([]UpdateCheck, error) {
	list, err := m.List()
	if err != nil {
		return nil, err
	}
	out := []UpdateCheck{}
	for _, entry := range list {
		if !entry.Managed || entry.Project == "" {
			continue
		}
		newest, err := m.resolve(ctx, entry.Project)
		if err != nil {
			continue
		}
		if newest.ID != entry.VersionID {
			out = append(out, UpdateCheck{
				Project: entry.Project, Installed: entry.Version, Available: newest.VersionNumber,
			})
		}
	}
	return out, nil
}

// Status is the mods view's one fetch.
type Status struct {
	Supported bool        `json:"supported"`
	Loader    string      `json:"loader"`
	Noun      string      `json:"noun"`
	Dir       string      `json:"dir"`
	Installed []Installed `json:"installed"`
	Packs     []Pack      `json:"packs"`
}

func (m *Manager) Status() Status {
	caps := m.deps.Backend.Capabilities()
	out := Status{Loader: caps.ModLoader, Noun: noun(caps.ModLoader)}
	if caps.ModLoader == "" {
		return out
	}
	out.Supported = true
	out.Dir = filepath.Join(m.deps.Paths.Runtime(), caps.ModDir)
	if list, err := m.List(); err == nil {
		out.Installed = list
	}
	out.Packs = m.Packs()
	return out
}

// noun is what the UI calls the content: Paper loads plugins, Babric loads mods.
func noun(loader string) string {
	if loader == "paper" {
		return "plugin"
	}
	return "mod"
}
