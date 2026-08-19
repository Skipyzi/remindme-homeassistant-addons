// Package babric implements the Babric backend: Better than Adventure! run
// through the Fabric loader, which is what makes BTA moddable.
//
// The running server IS Better than Adventure - same console grammar, same
// properties file, same world format - so this backend embeds the bta one and
// changes only what the loader changes: the launcher JAR name, the launch
// context (the launcher reads fabric-server-launcher.properties, not
// arguments), and the mods directory the capabilities advertise.
package babric

import (
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/adapter/bta"
)

type Backend struct {
	bta.Backend
}

func New() *Backend { return &Backend{} }

func (b *Backend) Name() string        { return "babric" }
func (b *Backend) DisplayName() string { return "BTA with Babric" }
func (b *Backend) JarName() string     { return "fabric-server-launch.jar" }

// Capabilities: everything BTA reports, plus mods.
func (b *Backend) Capabilities() adapter.Capabilities {
	caps := b.Backend.Capabilities()
	caps.Notes = []string{
		"Better than Adventure! with the Babric/Fabric loader. Worlds are interchangeable with the plain BTA flavour of the same version, and with nothing newer.",
		"Mods go into the mods/ directory of the server folder. The bundle ships halplibe, which most BTA mods need; updates replace the bundle's own files and never touch mods you added.",
		"There are still no Bukkit plugins, so terrain pre-generation and bridge telemetry are unavailable.",
		"The listen port is written into server.properties because the server takes no launch arguments.",
	}
	return caps
}
