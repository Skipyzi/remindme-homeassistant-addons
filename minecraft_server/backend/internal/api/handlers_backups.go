package api

import (
	"net/http"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/backups"
)

func (s *Server) handleBackupsList(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 60*time.Second)
	defer cancel()
	records, err := s.deps.Backups.List(ctx, intParam(r, "limit", 100))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	backups.SortRecords(records)
	id, kind, description, cancellable, running := s.deps.Backups.Current()
	s.ok(w, map[string]any{
		"backups": records,
		"current": map[string]any{
			"running": running, "id": id, "kind": kind,
			"description": description, "cancellable": cancellable,
		},
	})
}

func (s *Server) handleBackupCreate(w http.ResponseWriter, r *http.Request) {
	var req backups.CreateRequest
	if !s.decodeOptional(w, r, &req) {
		return
	}
	// Backups of a multi-gigabyte world can take a while on a Pi; the request is
	// detached so the browser closing does not abort it.
	ctx, cancel := contextWithTimeout(r, 6*time.Hour)
	defer cancel()
	record, err := s.deps.Commands.Backup(ctx, s.actor(r), req)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, record)
}

func (s *Server) handleBackupHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 2*time.Minute)
	defer cancel()
	s.ok(w, s.deps.Backups.Health(ctx))
}

type verifyRequest struct {
	// ReadSubset re-reads part of the stored data, for example "5%". Empty checks
	// only the repository structure, which is much faster on a Pi.
	ReadSubset string `json:"read_subset"`
}

func (s *Server) handleBackupVerify(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	if !s.decodeOptional(w, r, &req) {
		return
	}
	ctx, cancel := contextWithTimeout(r, 2*time.Hour)
	defer cancel()
	out, err := s.deps.Backups.Verify(ctx, req.ReadSubset, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"output": out, "ok": true})
}

func (s *Server) handleBackupRetention(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, time.Hour)
	defer cancel()
	if err := s.deps.Backups.ApplyRetention(ctx, s.actor(r)); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"applied": true})
}

func (s *Server) handleBackupCancel(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Backups.Cancel(s.actor(r)); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"cancelled": true})
}

func (s *Server) handleBackupPreview(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 2*time.Minute)
	defer cancel()
	preview, err := s.deps.Backups.Preview(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, preview)
}

type labelRequest struct {
	Label string `json:"label"`
	Notes string `json:"notes"`
}

func (s *Server) handleBackupLabel(w http.ResponseWriter, r *http.Request) {
	var req labelRequest
	if !s.decode(w, r, &req) {
		return
	}
	record, err := s.deps.Backups.SetLabel(r.PathValue("id"), req.Label, req.Notes, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, record)
}

type restoreRequest struct {
	backups.RestoreRequest
	Confirm string `json:"confirm"`
}

func (s *Server) handleBackupRestore(w http.ResponseWriter, r *http.Request) {
	var req restoreRequest
	if !s.decodeOptional(w, r, &req) {
		return
	}
	req.BackupID = r.PathValue("id")
	ctx, cancel := contextWithTimeout(r, 6*time.Hour)
	defer cancel()
	result, err := s.deps.Commands.RestoreBackup(ctx, s.actor(r), req.RestoreRequest, req.Confirm)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, result)
}

func (s *Server) handleBackupDelete(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 30*time.Minute)
	defer cancel()
	if err := s.deps.Commands.DeleteBackup(ctx, s.actor(r), r.PathValue("id"), r.URL.Query().Get("confirm")); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"deleted": r.PathValue("id")})
}
