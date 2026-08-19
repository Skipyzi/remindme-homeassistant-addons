package mods

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// SearchResult is one Modrinth project, trimmed to what the UI shows.
type SearchResult struct {
	Project     string `json:"project"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Downloads   int64  `json:"downloads"`
	IconURL     string `json:"icon_url,omitempty"`
	ServerSide  string `json:"server_side"`
	Installed   bool   `json:"installed"`
}

type searchResponse struct {
	Hits []struct {
		ProjectID   string `json:"project_id"`
		Slug        string `json:"slug"`
		Title       string `json:"title"`
		Description string `json:"description"`
		Downloads   int64  `json:"downloads"`
		IconURL     string `json:"icon_url"`
		ServerSide  string `json:"server_side"`
	} `json:"hits"`
	TotalHits int `json:"total_hits"`
}

// gameVersion is the Minecraft version content is matched against. Paper
// declares real Minecraft versions on Modrinth; BTA content is published under
// the fixed game version "b1.7.3" with the BTA release in the version number,
// so for Babric the facet is skipped and matching happens per version below.
func (m *Manager) gameVersion() string {
	if m.loader() == "paper" {
		return m.deps.Settings.Get().PaperVersion
	}
	return ""
}

// Search asks Modrinth for server-side content matching the flavour's loader
// and, where the loader declares real versions, the installed game version.
func (m *Manager) Search(ctx context.Context, query string) ([]SearchResult, error) {
	if m.loader() == "" {
		return nil, ErrUnsupported
	}
	group := []string{}
	for _, l := range m.loaderFamily() {
		group = append(group, "loaders:"+l)
	}
	facets := [][]string{group}
	if v := m.gameVersion(); v != "" {
		facets = append(facets, []string{"versions:" + v})
	}
	// client-only content is useless on a server and confusing in the list.
	facets = append(facets, []string{"server_side:required", "server_side:optional"})

	facetJSON := "["
	for i, group := range facets {
		if i > 0 {
			facetJSON += ","
		}
		facetJSON += `["` + strings.Join(group, `","`) + `"]`
	}
	facetJSON += "]"

	params := url.Values{}
	params.Set("facets", facetJSON)
	params.Set("limit", "20")
	if strings.TrimSpace(query) == "" {
		params.Set("index", "downloads")
	} else {
		params.Set("query", query)
	}

	var payload searchResponse
	if err := m.getJSON(ctx, m.api()+"/search?"+params.Encode(), &payload); err != nil {
		return nil, err
	}

	installed := map[string]bool{}
	if list, err := m.List(); err == nil {
		for _, entry := range list {
			if entry.Project != "" {
				installed[entry.Project] = true
			}
		}
	}

	out := make([]SearchResult, 0, len(payload.Hits))
	for _, hit := range payload.Hits {
		project := hit.Slug
		if project == "" {
			project = hit.ProjectID
		}
		out = append(out, SearchResult{
			Project:     project,
			Title:       hit.Title,
			Description: hit.Description,
			Downloads:   hit.Downloads,
			IconURL:     hit.IconURL,
			ServerSide:  hit.ServerSide,
			Installed:   installed[project],
		})
	}
	return out, nil
}

// modVersion mirrors the parts of a Modrinth version object the manager uses.
type modVersion struct {
	ID            string    `json:"id"`
	ProjectID     string    `json:"project_id"`
	VersionNumber string    `json:"version_number"`
	VersionType   string    `json:"version_type"`
	GameVersions  []string  `json:"game_versions"`
	Loaders       []string  `json:"loaders"`
	Published     time.Time `json:"date_published"`
	Files         []struct {
		Filename string            `json:"filename"`
		Primary  bool              `json:"primary"`
		Size     int64             `json:"size"`
		URL      string            `json:"url"`
		Hashes   map[string]string `json:"hashes"`
	} `json:"files"`
	Dependencies []struct {
		ProjectID string `json:"project_id"`
		Type      string `json:"dependency_type"`
	} `json:"dependencies"`
}

// resolve picks the version of a project to install: the newest release for the
// flavour's loader that fits the running game version.
func (m *Manager) resolve(ctx context.Context, project string) (*modVersion, error) {
	if err := validProject(project); err != nil {
		return nil, err
	}
	var versions []modVersion
	loaders := "["
	for i, l := range m.loaderFamily() {
		if i > 0 {
			loaders += ","
		}
		loaders += fmt.Sprintf("%q", l)
	}
	loaders += "]"
	endpoint := fmt.Sprintf("%s/project/%s/version?loaders=%s", m.api(), url.PathEscape(project), url.QueryEscape(loaders))
	if err := m.getJSON(ctx, endpoint, &versions); err != nil {
		return nil, err
	}
	game := m.gameVersion()
	// BTA content pins game_versions to b1.7.3 and encodes the BTA release in
	// the version number (6.1.4+8.0); prefer versions suffixed for the installed
	// BTA line, fall back to the newest.
	btaLine := ""
	if m.loader() == "bta-babric" {
		installed := m.deps.Settings.Get().PaperVersion
		if i := strings.IndexAny(installed, "_-"); i > 0 {
			installed = installed[:i]
		}
		parts := strings.Split(installed, ".")
		if len(parts) >= 2 {
			btaLine = parts[0] + "." + parts[1]
		}
	}

	sort.Slice(versions, func(i, j int) bool { return versions[i].Published.After(versions[j].Published) })
	var fallback *modVersion
	for i := range versions {
		v := &versions[i]
		if v.VersionType != "release" && fallback == nil && len(versions) > 1 {
			continue
		}
		if game != "" && !contains(v.GameVersions, game) {
			continue
		}
		if btaLine != "" {
			if strings.Contains(v.VersionNumber, "+"+btaLine) {
				return v, nil
			}
			if fallback == nil {
				fallback = v
			}
			continue
		}
		return v, nil
	}
	if fallback != nil {
		return fallback, nil
	}
	if game != "" {
		return nil, fmt.Errorf("%s has no release for %s on %s", project, game, m.loader())
	}
	return nil, fmt.Errorf("%s has no release for %s", project, m.loader())
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// validProject keeps API paths free of anything but a Modrinth slug or id.
func validProject(p string) error {
	if p == "" || len(p) > 64 {
		return fmt.Errorf("invalid project identifier")
	}
	for _, r := range p {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return fmt.Errorf("invalid character %q in project identifier", r)
		}
	}
	return nil
}
