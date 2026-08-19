// Package flavours is the list of server flavours the add-on can run.
//
// A flavour is a backend plus the metadata the UI needs to describe it. Adding
// one means implementing adapter.Backend and an updates.Source, and adding a
// line here; nothing above this package knows the names.
package flavours

import (
	"fmt"
	"sort"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/babric"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/bta"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/paper"
)

// Info describes one flavour for the API.
type Info struct {
	Name        string               `json:"name"`
	DisplayName string               `json:"display_name"`
	Summary     string               `json:"summary"`
	JarName     string               `json:"jar_name"`
	Caps        adapter.Capabilities `json:"capabilities"`
}

type entry struct {
	summary string
	build   func() adapter.Backend
}

var registry = map[string]entry{
	"paper": {
		summary: "The current Minecraft release, with Paper's performance patches, Bukkit plugins and terrain pre-generation.",
		build:   func() adapter.Backend { return paper.New() },
	},
	"bta": {
		summary: "Better than Adventure!, a continuation of Minecraft Beta 1.7.3. No mods, no plugins, no pre-generation; worlds are not interchangeable with a modern server's.",
		build:   func() adapter.Backend { return bta.New() },
	},
	"babric": {
		summary: "Better than Adventure! with the Babric/Fabric mod loader. Same game and worlds as plain BTA, plus a mods directory.",
		build:   func() adapter.Backend { return babric.New() },
	},
}

// New builds the backend for a flavour.
func New(name string) (adapter.Backend, error) {
	e, ok := registry[name]
	if !ok {
		return nil, fmt.Errorf("unknown server flavour %q", name)
	}
	return e.build(), nil
}

// Exists reports whether a flavour name is known.
func Exists(name string) bool {
	_, ok := registry[name]
	return ok
}

// All lists every flavour, PaperMC first and the rest alphabetically.
func All() []Info {
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		switch {
		case names[i] == "paper":
			return true
		case names[j] == "paper":
			return false
		default:
			return names[i] < names[j]
		}
	})
	out := make([]Info, 0, len(names))
	for _, name := range names {
		backend := registry[name].build()
		out = append(out, Info{
			Name:        backend.Name(),
			DisplayName: backend.DisplayName(),
			Summary:     registry[name].summary,
			JarName:     backend.JarName(),
			Caps:        backend.Capabilities(),
		})
	}
	return out
}
