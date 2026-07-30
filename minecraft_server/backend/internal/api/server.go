// Package api exposes the REST API, the Server-Sent Events stream and the static
// web UI. It is written for Home Assistant Ingress: every path is relative, and
// requests that do not come through Ingress may read but not change state unless
// the operator opts in.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/backups"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/bridge"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/commands"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/generation"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/mcconfig"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/presets"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/stats"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/updates"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/worlds"
)

// requestHeader is the header the web UI sends with every state-changing request.
// A browser cannot set it on a cross-site form post without a CORS preflight, so
// requiring it blocks the simple CSRF shapes that Ingress alone would not.
const requestHeader = "X-Minecraft-Addon"
const requestHeaderValue = "1"

type Deps struct {
	Version     string
	Paths       appcfg.Paths
	Options     appcfg.Options
	Settings    *appcfg.Store
	Store       *store.Store
	Bus         *events.Bus
	Supervisor  *supervisor.Supervisor
	Config      *mcconfig.Manager
	Presets     *presets.Manager
	Worlds      *worlds.Manager
	Backups     *backups.Manager
	Generation  *generation.Manager
	Updates     *updates.Manager
	Commands    *commands.Service
	Stats       *stats.Collector
	Bridge      *bridge.Server
	FrontendDir string
	Log         *slog.Logger
}

type Server struct {
	deps Deps
	log  *slog.Logger
	mux  *http.ServeMux
}

func New(d Deps) *Server {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	s := &Server{deps: d, log: d.Log.With("component", "api"), mux: http.NewServeMux()}
	s.routes()
	return s
}

// Handler returns the fully wrapped HTTP handler.
func (s *Server) Handler() http.Handler {
	return s.withLogging(s.withSecurity(s.mux))
}

func (s *Server) routes() {
	m := s.mux

	// Status and telemetry.
	m.HandleFunc("GET /api/status", s.handleStatus)
	m.HandleFunc("GET /api/stats", s.handleStats)
	m.HandleFunc("GET /api/players", s.handlePlayers)
	m.HandleFunc("GET /api/console", s.handleConsole)
	m.HandleFunc("GET /api/events", s.handleEvents)
	m.HandleFunc("GET /api/audit", s.handleAudit)
	m.HandleFunc("GET /api/journal", s.handleJournal)

	// Server control.
	m.HandleFunc("POST /api/server/start", s.handleStart)
	m.HandleFunc("POST /api/server/stop", s.handleStop)
	m.HandleFunc("POST /api/server/restart", s.handleRestart)
	m.HandleFunc("POST /api/server/command", s.handleCommand)
	m.HandleFunc("POST /api/server/eula", s.handleEULA)
	m.HandleFunc("POST /api/server/maintenance", s.handleMaintenance)
	m.HandleFunc("GET /api/server/versions", s.handleServerVersions)
	m.HandleFunc("POST /api/server/install", s.handleServerInstall)
	m.HandleFunc("POST /api/server/update", s.handleServerUpdate)

	// Configuration.
	m.HandleFunc("GET /api/config", s.handleConfigGet)
	m.HandleFunc("PUT /api/config", s.handleConfigPut)
	m.HandleFunc("GET /api/config/files", s.handleConfigFiles)
	m.HandleFunc("GET /api/config/files/{name}", s.handleConfigFileGet)
	m.HandleFunc("PUT /api/config/files/{name}", s.handleConfigFilePut)
	m.HandleFunc("GET /api/config/files/{name}/snapshots", s.handleConfigSnapshots)
	m.HandleFunc("POST /api/config/files/{name}/restore", s.handleConfigSnapshotRestore)
	m.HandleFunc("GET /api/settings", s.handleSettingsGet)
	m.HandleFunc("PUT /api/settings", s.handleSettingsPut)

	// Presets.
	m.HandleFunc("GET /api/presets", s.handlePresetsList)
	m.HandleFunc("POST /api/presets", s.handlePresetSave)
	m.HandleFunc("GET /api/presets/{id}/diff", s.handlePresetDiff)
	m.HandleFunc("POST /api/presets/{id}/apply", s.handlePresetApply)
	m.HandleFunc("DELETE /api/presets/{id}", s.handlePresetDelete)

	// Worlds.
	m.HandleFunc("GET /api/worlds", s.handleWorldsList)
	m.HandleFunc("POST /api/worlds", s.handleWorldCreate)
	m.HandleFunc("POST /api/worlds/import", s.handleWorldImport)
	m.HandleFunc("GET /api/worlds/trash", s.handleTrashList)
	m.HandleFunc("POST /api/worlds/trash/{name}/restore", s.handleTrashRestore)
	m.HandleFunc("DELETE /api/worlds/trash/{name}", s.handleTrashPurge)
	m.HandleFunc("GET /api/worlds/{id}", s.handleWorldGet)
	m.HandleFunc("GET /api/worlds/{id}/export", s.handleWorldExport)
	m.HandleFunc("POST /api/worlds/{id}/clone", s.handleWorldClone)
	m.HandleFunc("POST /api/worlds/{id}/rename", s.handleWorldRename)
	m.HandleFunc("POST /api/worlds/{id}/activate", s.handleWorldActivate)
	m.HandleFunc("POST /api/worlds/{id}/archive", s.handleWorldArchive)
	m.HandleFunc("DELETE /api/worlds/{id}", s.handleWorldDelete)

	// Backups.
	m.HandleFunc("GET /api/backups", s.handleBackupsList)
	m.HandleFunc("POST /api/backups", s.handleBackupCreate)
	m.HandleFunc("GET /api/backups/health", s.handleBackupHealth)
	m.HandleFunc("POST /api/backups/verify", s.handleBackupVerify)
	m.HandleFunc("POST /api/backups/retention", s.handleBackupRetention)
	m.HandleFunc("POST /api/backups/cancel", s.handleBackupCancel)
	m.HandleFunc("GET /api/backups/{id}/preview", s.handleBackupPreview)
	m.HandleFunc("POST /api/backups/{id}/label", s.handleBackupLabel)
	m.HandleFunc("POST /api/backups/{id}/restore", s.handleBackupRestore)
	m.HandleFunc("DELETE /api/backups/{id}", s.handleBackupDelete)

	// Terrain generation.
	m.HandleFunc("GET /api/generation", s.handleGenerationStatus)
	m.HandleFunc("GET /api/generation/jobs", s.handleGenerationJobs)
	m.HandleFunc("POST /api/generation/jobs", s.handleGenerationStart)
	m.HandleFunc("POST /api/generation/estimate", s.handleGenerationEstimate)
	m.HandleFunc("POST /api/generation/plugin/install", s.handleGenerationPluginInstall)
	m.HandleFunc("GET /api/generation/plugin", s.handleGenerationPlugin)
	m.HandleFunc("POST /api/generation/jobs/{id}/pause", s.handleGenerationPause)
	m.HandleFunc("POST /api/generation/jobs/{id}/resume", s.handleGenerationResume)
	m.HandleFunc("POST /api/generation/jobs/{id}/cancel", s.handleGenerationCancel)

	// Static UI. Registered last so /api paths win.
	m.HandleFunc("/", s.handleStatic)
}

// ------------------------------------------------------------- middleware ----

func (s *Server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/events" {
			level := slog.LevelDebug
			if rec.status >= 500 {
				level = slog.LevelError
			} else if rec.status >= 400 {
				level = slog.LevelWarn
			}
			s.log.Log(r.Context(), level, "request",
				"method", r.Method, "path", r.URL.Path, "status", rec.status,
				"duration_ms", time.Since(start).Milliseconds())
		}
	})
}

// withSecurity enforces the Ingress and CSRF rules.
func (s *Server) withSecurity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")

		if isStateChanging(r.Method) {
			// Ingress terminates authentication; requests arriving any other way
			// are read-only unless the operator explicitly allowed more.
			if !viaIngress(r) && !s.deps.Options.AllowDirectAccess {
				s.fail(w, http.StatusForbidden, errors.New(
					"state-changing requests must arrive through Home Assistant Ingress (enable allow_direct_access to override)"))
				return
			}
			if r.Header.Get(requestHeader) != requestHeaderValue {
				s.fail(w, http.StatusForbidden, fmt.Errorf(
					"missing %s header; requests must come from the add-on UI or an explicit API client", requestHeader))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func isStateChanging(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func viaIngress(r *http.Request) bool {
	return r.Header.Get("X-Ingress-Path") != "" || r.Header.Get("X-Hassio-Key") != ""
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Flush lets SSE pass through the wrapper.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// ---------------------------------------------------------------- helpers ----

func (s *Server) actor(r *http.Request) string {
	if user := r.Header.Get("X-Remote-User-Display-Name"); user != "" {
		return "ha:" + user
	}
	if user := r.Header.Get("X-Remote-User-Name"); user != "" {
		return "ha:" + user
	}
	if viaIngress(r) {
		return "ingress"
	}
	return "api"
}

func (s *Server) ok(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if payload == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		s.log.Warn("could not write response", "error", err)
	}
}

// fail maps domain errors onto status codes so the UI can react sensibly.
func (s *Server) fail(w http.ResponseWriter, status int, err error) {
	if status == 0 {
		status = statusForError(err)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":  store.Redact(err.Error()),
		"status": status,
	})
}

func statusForError(err error) int {
	var confirmErr commands.ErrConfirmation
	switch {
	case errors.As(err, &confirmErr):
		return http.StatusPreconditionRequired
	case errors.Is(err, supervisor.ErrBusy), errors.Is(err, backups.ErrBusy),
		errors.Is(err, generation.ErrJobRunning), errors.Is(err, supervisor.ErrAlreadyRunning),
		errors.Is(err, worlds.ErrExists), errors.Is(err, worlds.ErrActiveRunning):
		return http.StatusConflict
	case errors.Is(err, worlds.ErrNotFound), errors.Is(err, backups.ErrNotFound),
		errors.Is(err, presets.ErrNotFound), errors.Is(err, generation.ErrNoActiveJob),
		errors.Is(err, mcconfig.ErrUnknownFile):
		return http.StatusNotFound
	case errors.Is(err, supervisor.ErrNotRunning), errors.Is(err, generation.ErrServerStopped),
		errors.Is(err, supervisor.ErrEULANotAccepted), errors.Is(err, supervisor.ErrJarMissing),
		errors.Is(err, generation.ErrNoPlugin), errors.Is(err, generation.ErrLowDisk),
		errors.Is(err, backups.ErrResticMissing):
		return http.StatusConflict
	case errors.Is(err, appcfg.ErrUnsafePath), errors.Is(err, worlds.ErrUnsafeArchive),
		errors.Is(err, worlds.ErrNoWorldData), errors.Is(err, worlds.ErrInvalidWorld),
		errors.Is(err, mcconfig.ErrTooLarge):
		return http.StatusBadRequest
	default:
		return http.StatusBadRequest
	}
}

func (s *Server) decode(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		s.fail(w, http.StatusBadRequest, fmt.Errorf("invalid request body: %w", err))
		return false
	}
	return true
}

// decodeOptional accepts an empty body.
func (s *Server) decodeOptional(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		if errors.Is(err, io.EOF) {
			return true
		}
		s.fail(w, http.StatusBadRequest, fmt.Errorf("invalid request body: %w", err))
		return false
	}
	return true
}

func intParam(r *http.Request, key string, fallback int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func boolParam(r *http.Request, key string) bool {
	v := strings.ToLower(r.URL.Query().Get(key))
	return v == "1" || v == "true" || v == "yes"
}

// ------------------------------------------------------------------ static ----

// handleStatic serves the web UI. Paths are validated against the frontend
// directory, so no request can read outside it.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.fail(w, http.StatusNotFound, errors.New("unknown API endpoint"))
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/")
	if rel == "" {
		rel = "index.html"
	}
	full, err := appcfg.Confine(s.deps.FrontendDir, rel)
	if err != nil {
		s.fail(w, http.StatusBadRequest, err)
		return
	}
	if st, err := os.Stat(full); err != nil || st.IsDir() {
		// Single-page fallback: unknown paths render the app shell.
		full = filepath.Join(s.deps.FrontendDir, "index.html")
	}
	if strings.HasSuffix(full, ".html") {
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "max-age=300")
	}
	// ServeContent rather than ServeFile: ServeFile redirects requests for
	// index.html to "./", which is noise behind an Ingress proxy.
	file, err := os.Open(full)
	if err != nil {
		s.fail(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		s.fail(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	http.ServeContent(w, r, filepath.Base(full), info.ModTime(), file)
}
