package api

import (
	"net/http"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/generation"
)

func (s *Server) handleGenerationStatus(w http.ResponseWriter, r *http.Request) {
	s.ok(w, s.deps.Generation.Status())
}

func (s *Server) handleGenerationJobs(w http.ResponseWriter, r *http.Request) {
	jobs, err := s.deps.Store.ListJobs(intParam(r, "limit", 50))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"jobs": jobs, "status": s.deps.Generation.Status()})
}

func (s *Server) handleGenerationEstimate(w http.ResponseWriter, r *http.Request) {
	var params generation.Params
	if !s.decode(w, r, &params) {
		return
	}
	if params.WorldID == "" {
		params.WorldID = s.deps.Settings.Get().ActiveWorld
	}
	estimate, err := s.deps.Generation.Estimate(params)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, estimate)
}

func (s *Server) handleGenerationStart(w http.ResponseWriter, r *http.Request) {
	var params generation.Params
	if !s.decode(w, r, &params) {
		return
	}
	if params.WorldID == "" {
		params.WorldID = s.deps.Settings.Get().ActiveWorld
	}
	// Starting a job may run a pre-generation backup, so it gets a long budget.
	ctx, cancel := contextWithTimeout(r, 6*time.Hour)
	defer cancel()
	job, err := s.deps.Commands.StartGeneration(ctx, s.actor(r), params)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"job": job, "status": s.deps.Generation.Status()})
}

func (s *Server) handleGenerationPause(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Commands.PauseGeneration(s.actor(r)); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, s.deps.Generation.Status())
}

func (s *Server) handleGenerationResume(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Commands.ResumeGeneration(s.actor(r)); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, s.deps.Generation.Status())
}

func (s *Server) handleGenerationCancel(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 2*time.Hour)
	defer cancel()
	if err := s.deps.Commands.CancelGeneration(ctx, s.actor(r), r.URL.Query().Get("confirm")); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, s.deps.Generation.Status())
}

func (s *Server) handleGenerationPlugin(w http.ResponseWriter, r *http.Request) {
	if boolParam(r, "check") {
		ctx, cancel := contextWithTimeout(r, 60*time.Second)
		defer cancel()
		status, err := s.deps.Generation.CheckForUpdate(ctx)
		if err != nil {
			s.ok(w, map[string]any{"plugin": status, "error": err.Error()})
			return
		}
		s.ok(w, map[string]any{"plugin": status})
		return
	}
	s.ok(w, map[string]any{"plugin": s.deps.Generation.PluginStatus()})
}

func (s *Server) handleGenerationPluginInstall(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 10*time.Minute)
	defer cancel()
	status, err := s.deps.Commands.InstallGenerationPlugin(ctx, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"plugin": status})
}
