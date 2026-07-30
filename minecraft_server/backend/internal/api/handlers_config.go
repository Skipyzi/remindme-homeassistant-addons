package api

import (
	"net/http"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/presets"
)

// handleConfigGet returns the structured settings with their metadata, so the UI
// can render a form that always matches the backend's own validation rules.
func (s *Server) handleConfigGet(w http.ResponseWriter, r *http.Request) {
	knobs, err := s.deps.Config.Knobs()
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	settings := s.deps.Settings.Get()
	s.ok(w, map[string]any{
		"knobs":            knobs,
		"files":            s.deps.Config.List(),
		"active_preset":    settings.ActivePreset,
		"user_overrides":   settings.PresetOverrides["knobs"],
		"restart_required": s.deps.Supervisor.IsRunning(),
	})
}

type knobUpdate struct {
	Values map[string]any `json:"values"`
}

func (s *Server) handleConfigPut(w http.ResponseWriter, r *http.Request) {
	var req knobUpdate
	if !s.decode(w, r, &req) {
		return
	}
	if len(req.Values) == 0 {
		s.ok(w, map[string]any{"changed": 0})
		return
	}
	results, err := s.deps.Commands.SetKnobs(s.actor(r), req.Values)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	restart := false
	for _, res := range results {
		if res.RestartRequired && !res.Unchanged {
			restart = true
		}
	}
	s.ok(w, map[string]any{
		"changed": len(req.Values), "results": results,
		"restart_required": restart && s.deps.Supervisor.IsRunning(),
	})
}

func (s *Server) handleConfigFiles(w http.ResponseWriter, r *http.Request) {
	s.ok(w, map[string]any{"files": s.deps.Config.List()})
}

func (s *Server) handleConfigFileGet(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	info, content, err := s.deps.Config.Read(name)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	snapshots, _ := s.deps.Config.Snapshots(name)
	s.ok(w, map[string]any{"file": info, "content": content, "snapshots": snapshots})
}

type fileWrite struct {
	Content string `json:"content"`
	// SHA256 is the digest the editor loaded. When it no longer matches, the file
	// changed underneath the editor and the write is refused.
	SHA256 string `json:"sha256"`
}

func (s *Server) handleConfigFilePut(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var req fileWrite
	if !s.decode(w, r, &req) {
		return
	}
	if req.SHA256 != "" {
		current, _, err := s.deps.Config.Read(name)
		if err != nil {
			s.fail(w, 0, err)
			return
		}
		if current.SHA256 != "" && current.SHA256 != req.SHA256 {
			s.fail(w, http.StatusConflict, errConflict(name))
			return
		}
	}
	result, err := s.deps.Commands.WriteConfigFile(s.actor(r), name, req.Content)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, result)
}

func errConflict(name string) error {
	return &conflictError{name: name}
}

type conflictError struct{ name string }

func (e *conflictError) Error() string {
	return e.name + " changed on disk since it was opened; reload the file and apply the change again"
}

func (s *Server) handleConfigSnapshots(w http.ResponseWriter, r *http.Request) {
	snapshots, err := s.deps.Config.Snapshots(r.PathValue("name"))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"snapshots": snapshots})
}

type snapshotRestore struct {
	Snapshot string `json:"snapshot"`
}

func (s *Server) handleConfigSnapshotRestore(w http.ResponseWriter, r *http.Request) {
	var req snapshotRestore
	if !s.decode(w, r, &req) {
		return
	}
	result, err := s.deps.Config.RestoreSnapshot(r.PathValue("name"), req.Snapshot, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, result)
}

// ----------------------------------------------------------------- presets ----

func (s *Server) handlePresetsList(w http.ResponseWriter, r *http.Request) {
	list, err := s.deps.Presets.List()
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{
		"presets": list,
		"active":  s.deps.Settings.Get().ActivePreset,
		"catalog": mcconfig.KnobCatalog(),
	})
}

func (s *Server) handlePresetSave(w http.ResponseWriter, r *http.Request) {
	var preset presets.Preset
	if !s.decode(w, r, &preset) {
		return
	}
	saved, err := s.deps.Presets.Save(preset, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, saved)
}

func (s *Server) handlePresetDiff(w http.ResponseWriter, r *http.Request) {
	diff, err := s.deps.Presets.Diff(r.PathValue("id"))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, diff)
}

type presetApply struct {
	// OverrideUserChanges re-applies values the user changed by hand since the
	// last preset application. Off by default so a preset never silently reverts
	// a deliberate change.
	OverrideUserChanges bool `json:"override_user_changes"`
}

func (s *Server) handlePresetApply(w http.ResponseWriter, r *http.Request) {
	var req presetApply
	if !s.decodeOptional(w, r, &req) {
		return
	}
	result, err := s.deps.Commands.ApplyPreset(s.actor(r), r.PathValue("id"), req.OverrideUserChanges)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, result)
}

func (s *Server) handlePresetDelete(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Presets.Delete(r.PathValue("id"), s.actor(r)); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"deleted": r.PathValue("id")})
}
