package api

import (
	"net/http"
	"time"
)

func (s *Server) handleModsStatus(w http.ResponseWriter, r *http.Request) {
	s.ok(w, s.deps.Mods.Status())
}

func (s *Server) handleModsSearch(w http.ResponseWriter, r *http.Request) {
	results, err := s.deps.Mods.Search(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"results": results})
}

type modInstallRequest struct {
	Project string `json:"project"`
}

func (s *Server) handleModInstall(w http.ResponseWriter, r *http.Request) {
	var req modInstallRequest
	if !s.decode(w, r, &req) {
		return
	}
	ctx, cancel := contextWithTimeout(r, 10*time.Minute)
	defer cancel()
	entry, err := s.deps.Mods.Install(ctx, req.Project, s.actor(r), "")
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, entry)
}

func (s *Server) handleModRemove(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Mods.Remove(r.PathValue("file"), s.actor(r)); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"removed": r.PathValue("file"), "restart_required": true})
}

func (s *Server) handleModUpdates(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 2*time.Minute)
	defer cancel()
	updates, err := s.deps.Mods.Updates(ctx)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"updates": updates})
}

func (s *Server) handlePackInstall(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 20*time.Minute)
	defer cancel()
	results, err := s.deps.Mods.InstallPack(ctx, r.PathValue("id"), s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"results": results})
}
