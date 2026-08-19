package mods

import (
	"context"
	"fmt"
)

// Pack is a small curated set of content that fits one flavour. Packs are
// deliberately opinionated and short: each entry is popular, maintained,
// server-side content from Modrinth, installed one by one with the same
// checksum verification as a single install. Per the add-on's own rules there
// are no "performance cleaner" style plugins in any of them.
type Pack struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Loader      string   `json:"loader"`
	Projects    []string `json:"projects"`
}

// packs is the catalog. Slugs are verified against Modrinth; a pack install
// resolves each at install time, so a project that gains a newer matching
// release is picked up naturally.
var packs = []Pack{
	{
		ID:     "paper-admin",
		Name:   "Admin toolkit",
		Loader: "paper",
		Description: "The plugins almost every survival server ends up wanting: LuckPerms for permissions, " +
			"CoreProtect for grief rollback, EssentialsX for homes, warps and kits, and BlueMap for a live web map.",
		Projects: []string{"luckperms", "coreprotect", "essentialsx", "bluemap"},
	},
	{
		ID:     "babric-foundation",
		Name:   "Mod foundation",
		Loader: "bta-babric",
		Description: "The libraries most BTA mods depend on - HalpLibe and Catalyst - plus BTWaila's server half " +
			"so players with the client mod see block info. Install this first, then add content mods.",
		Projects: []string{"halplibe", "catalyst", "btwaila"},
	},
	{
		ID:     "babric-content",
		Name:   "Content picks",
		Loader: "bta-babric",
		Description: "The most-downloaded server-side content mods for BTA: Signal Industries (machines and power), " +
			"Bonus Blocks, Iron Furnaces and Stardew Farming. Needs the mod foundation pack.",
		Projects: []string{"signal-industries", "bonus-blocks-bta", "iron-furnaces-bta", "stardew-farming-bta"},
	},
}

// Packs lists the catalog entries that fit the active flavour.
func (m *Manager) Packs() []Pack {
	loader := m.loader()
	out := []Pack{}
	for _, pack := range packs {
		if pack.Loader == loader {
			out = append(out, pack)
		}
	}
	return out
}

// PackResult reports what a pack install did, per project.
type PackResult struct {
	Project string `json:"project"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

// InstallPack installs every project in a pack. One failing project does not
// abort the rest - half a pack plus a clear error beats an all-or-nothing
// retry of large downloads.
func (m *Manager) InstallPack(ctx context.Context, id, actor string) ([]PackResult, error) {
	var pack *Pack
	for i := range packs {
		if packs[i].ID == id && packs[i].Loader == m.loader() {
			pack = &packs[i]
			break
		}
	}
	if pack == nil {
		return nil, fmt.Errorf("no pack %q fits this server flavour", id)
	}
	out := make([]PackResult, 0, len(pack.Projects))
	for _, project := range pack.Projects {
		entry, err := m.Install(ctx, project, actor, pack.ID)
		result := PackResult{Project: project}
		if err != nil {
			result.Error = err.Error()
		} else {
			result.Version = entry.Version
		}
		out = append(out, result)
	}
	return out, nil
}
