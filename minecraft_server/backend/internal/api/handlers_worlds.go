package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/worlds"
)

func (s *Server) handleWorldsList(w http.ResponseWriter, r *http.Request) {
	list, err := s.deps.Worlds.List()
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"worlds": list, "active": s.deps.Settings.Get().ActiveWorld})
}

func (s *Server) handleWorldGet(w http.ResponseWriter, r *http.Request) {
	info, err := s.deps.Worlds.Get(r.PathValue("id"))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, info)
}

func (s *Server) handleWorldCreate(w http.ResponseWriter, r *http.Request) {
	var req worlds.CreateRequest
	if !s.decode(w, r, &req) {
		return
	}
	info, err := s.deps.Worlds.Create(req, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, info)
}

type cloneRequest struct {
	Name string `json:"name"`
}

func (s *Server) handleWorldClone(w http.ResponseWriter, r *http.Request) {
	var req cloneRequest
	if !s.decode(w, r, &req) {
		return
	}
	info, err := s.deps.Worlds.Clone(r.PathValue("id"), req.Name, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, info)
}

func (s *Server) handleWorldRename(w http.ResponseWriter, r *http.Request) {
	var req cloneRequest
	if !s.decode(w, r, &req) {
		return
	}
	info, err := s.deps.Worlds.Rename(r.PathValue("id"), req.Name, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, info)
}

type archiveRequest struct {
	Archived bool `json:"archived"`
}

func (s *Server) handleWorldArchive(w http.ResponseWriter, r *http.Request) {
	var req archiveRequest
	if !s.decode(w, r, &req) {
		return
	}
	info, err := s.deps.Worlds.Archive(r.PathValue("id"), req.Archived, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, info)
}

func (s *Server) handleWorldActivate(w http.ResponseWriter, r *http.Request) {
	var req worlds.ActivateRequest
	if !s.decodeOptional(w, r, &req) {
		return
	}
	req.WorldID = r.PathValue("id")
	ctx, cancel := contextWithTimeout(r, 30*time.Minute)
	defer cancel()
	result, err := s.deps.Commands.ActivateWorld(ctx, s.actor(r), req)
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, result)
}

func (s *Server) handleWorldDelete(w http.ResponseWriter, r *http.Request) {
	trashName, err := s.deps.Commands.DeleteWorld(s.actor(r), r.PathValue("id"), r.URL.Query().Get("confirm"))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"trash_name": trashName, "permanent": false})
}

func (s *Server) handleTrashList(w http.ResponseWriter, r *http.Request) {
	entries, err := s.deps.Worlds.Trash()
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"entries": entries})
}

func (s *Server) handleTrashRestore(w http.ResponseWriter, r *http.Request) {
	info, err := s.deps.Worlds.RestoreTrash(r.PathValue("name"), s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, info)
}

func (s *Server) handleTrashPurge(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Commands.PurgeWorld(s.actor(r), r.PathValue("name"), r.URL.Query().Get("confirm")); err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, map[string]any{"purged": r.PathValue("name")})
}

// handleWorldExport streams a ZIP archive of a world set.
func (s *Server) handleWorldExport(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.deps.Worlds.Get(id); err != nil {
		s.fail(w, 0, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename=%q", fmt.Sprintf("%s-%s.zip", id, time.Now().Format("20060102-1504"))))
	if err := s.deps.Worlds.ExportZip(id, w, s.actor(r)); err != nil {
		// Headers are already sent, so the error can only be logged.
		s.log.Error("world export failed", "world", id, "error", err)
	}
}

// maxUploadBytes bounds a world import upload.
const maxUploadBytes = int64(8) << 30

// handleWorldImport accepts a multipart upload and imports it as a new world.
func (s *Server) handleWorldImport(w http.ResponseWriter, r *http.Request) {
	reader, err := r.MultipartReader()
	if err != nil {
		s.fail(w, http.StatusBadRequest, fmt.Errorf("expected a multipart upload: %w", err))
		return
	}
	name := r.URL.Query().Get("name")
	var tmpPath string
	defer func() {
		if tmpPath != "" {
			_ = os.Remove(tmpPath)
		}
	}()

	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			s.fail(w, http.StatusBadRequest, err)
			return
		}
		switch part.FormName() {
		case "name":
			buf, _ := io.ReadAll(io.LimitReader(part, 256))
			if name == "" {
				name = string(buf)
			}
		case "file", "archive":
			if name == "" {
				name = trimExtension(part.FileName())
			}
			tmp, err := os.CreateTemp(s.deps.Paths.Staging(), "upload-*.zip")
			if err != nil {
				s.fail(w, http.StatusInternalServerError, err)
				return
			}
			tmpPath = tmp.Name()
			written, err := io.Copy(tmp, io.LimitReader(part, maxUploadBytes+1))
			closeErr := tmp.Close()
			if err != nil {
				s.fail(w, http.StatusInternalServerError, err)
				return
			}
			if closeErr != nil {
				s.fail(w, http.StatusInternalServerError, closeErr)
				return
			}
			if written > maxUploadBytes {
				s.fail(w, http.StatusRequestEntityTooLarge, errors.New("the uploaded archive is too large"))
				return
			}
		}
		_ = part.Close()
	}
	if tmpPath == "" {
		s.fail(w, http.StatusBadRequest, errors.New("no archive was uploaded"))
		return
	}
	if name == "" {
		name = "imported-world"
	}
	result, err := s.deps.Worlds.ImportZip(tmpPath, name, s.actor(r))
	if err != nil {
		s.fail(w, 0, err)
		return
	}
	s.ok(w, result)
}

func trimExtension(name string) string {
	base := filepath.Base(name)
	if ext := filepath.Ext(base); ext != "" {
		return base[:len(base)-len(ext)]
	}
	return base
}
