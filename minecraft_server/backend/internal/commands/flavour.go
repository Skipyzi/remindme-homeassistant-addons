package commands

import (
	"fmt"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/flavours"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

// FlavourStatus is what the UI shows on the flavour picker.
type FlavourStatus struct {
	Active    string          `json:"active"`
	Available []flavours.Info `json:"available"`
	// Installed says, per flavour, whether a server JAR is already there, so the
	// UI can tell "switch back to what you had" from "switch and then install".
	Installed map[string]bool `json:"installed"`
	// Running blocks the switch; it is reported rather than discovered by a
	// failed request.
	Running bool `json:"running"`
}

// FlavourStatus reports the flavours and which of them are installed.
func (s *Service) FlavourStatus() FlavourStatus {
	settings := s.deps.Settings.Get()
	out := FlavourStatus{
		Active:    s.deps.Paths.Flavour(),
		Available: flavours.All(),
		Installed: map[string]bool{},
		Running: s.deps.Supervisor.IsRunning() ||
			s.deps.Supervisor.State() == supervisor.StateStarting,
	}
	for _, info := range out.Available {
		version := settings.PerFlavour[info.Name].ServerVersion
		if info.Name == out.Active {
			version = settings.PaperVersion
		}
		out.Installed[info.Name] = version != "" || s.deps.Paths.HasServerJar(info.Name, info.JarName)
	}
	return out
}

// SwitchFlavour changes which server the add-on runs.
//
// The two flavours share nothing but the add-on: separate runtime directories,
// separate worlds, separate configuration and separate installed JARs. Switching
// therefore moves no data and is reversible - the previous flavour is exactly as
// it was left, which is why the confirmation is the flavour name rather than a
// warning about loss.
//
// Minecraft has to be stopped first. It is not stopped implicitly: a running
// server means players are on it.
func (s *Service) SwitchFlavour(actor, target, confirmation string) (FlavourStatus, error) {
	if !flavours.Exists(target) {
		return s.FlavourStatus(), fmt.Errorf("unknown server flavour %q", target)
	}
	current := s.deps.Paths.Flavour()
	if target == current {
		return s.FlavourStatus(), nil
	}
	if err := confirm(target, confirmation, "switching the server flavour"); err != nil {
		return s.FlavourStatus(), err
	}
	if s.deps.Settings.Get().MaintenanceMode {
		return s.FlavourStatus(), ErrMaintenance
	}

	lease, err := s.deps.Supervisor.Acquire(supervisor.ActivityMaintenanceOps)
	if err != nil {
		return s.FlavourStatus(), err
	}
	defer s.deps.Supervisor.Release(lease)

	if s.deps.Supervisor.IsRunning() || s.deps.Supervisor.State() == supervisor.StateStarting {
		return s.FlavourStatus(), fmt.Errorf(
			"stop Minecraft before switching to the %s server", target)
	}

	backend, err := flavours.New(target)
	if err != nil {
		return s.FlavourStatus(), err
	}

	journalID, _ := s.deps.Store.JournalBegin(store.OpFlavourSwitch, "switch", map[string]any{
		"from": current, "to": target, "actor": actor,
	})

	// Order matters: the settings are parked first, so a failure below leaves the
	// on-disk state and the recorded state agreeing on the old flavour.
	if _, err := s.deps.Settings.SwitchFlavour(target); err != nil {
		_ = s.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return s.FlavourStatus(), err
	}
	s.deps.Backend.Set(backend)
	s.deps.Paths.SetFlavour(backend.Name(), backend.JarName())

	if err := s.deps.Paths.EnsureLayout(); err != nil {
		_ = s.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return s.FlavourStatus(), err
	}
	enforced := map[string]string{}
	if !backend.Capabilities().ServerPortArg {
		enforced["server-port"] = fmt.Sprintf("%d", s.deps.ServerPort)
	}
	if err := s.deps.Config.EnsureDefaults(actor, enforced); err != nil {
		s.log.Warn("could not write default server properties after the switch", "error", err)
	}
	if err := s.deps.Config.EnsureListFiles(); err != nil {
		s.log.Warn("could not create configuration files after the switch", "error", err)
	}
	if _, err := s.deps.Worlds.EnsureActive(); err != nil {
		s.log.Warn("no usable world for the new flavour yet", "error", err)
	}

	_ = s.deps.Store.JournalEnd(journalID, store.JournalDone, "")
	_ = s.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "server.switch_flavour",
		Target: target, Detail: "from=" + current})
	return s.FlavourStatus(), nil
}
