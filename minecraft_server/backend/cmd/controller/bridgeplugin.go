package main

import (
	"crypto/sha256"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
)

// bridgePluginName is what the plugin is called inside the server's plugins
// directory.
const bridgePluginName = "McBridge.jar"

// ensureBridgePlugin installs or updates the telemetry plugin that ships with the
// image.
//
// The plugin is versioned with the add-on, not with the world, so the copy in
// /data is replaced whenever the image brings a different one. Comparing digests
// rather than timestamps avoids rewriting the file (and asking the operator to
// restart) on every start.
func ensureBridgePlugin(log *slog.Logger, env appcfg.Environment) {
	source := filepath.Join(env.AssetsDir, "mcbridge.jar")
	shipped, err := os.ReadFile(source)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("could not read the bundled telemetry plugin", "path", source, "error", err)
		}
		// Development checkouts have no built plugin; the controller works without it.
		log.Debug("no bundled telemetry plugin present", "path", source)
		return
	}

	target := filepath.Join(env.Paths.Plugins(), bridgePluginName)
	if installed, err := os.ReadFile(target); err == nil {
		if sha256.Sum256(installed) == sha256.Sum256(shipped) {
			return
		}
	}
	if err := atomicfs.WriteFile(target, shipped, 0o644); err != nil {
		log.Warn("could not install the telemetry plugin", "target", target, "error", err)
		return
	}
	log.Info("installed the management bridge plugin", "target", target, "bytes", len(shipped))
}
