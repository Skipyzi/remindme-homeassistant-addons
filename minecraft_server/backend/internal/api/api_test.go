package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/backups"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/commands"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/generation"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/worlds"
)

func newServer(t *testing.T, frontend string, allowDirect bool) *Server {
	t.Helper()
	return New(Deps{
		Version:     "test",
		Options:     appcfg.Options{AllowDirectAccess: allowDirect},
		FrontendDir: frontend,
	})
}

func TestStateChangingRequestsRequireIngressAndTheCustomHeader(t *testing.T) {
	server := newServer(t, t.TempDir(), false)
	reached := false
	handler := server.withSecurity(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))

	cases := []struct {
		name       string
		method     string
		headers    map[string]string
		wantStatus int
		wantReach  bool
	}{
		{"read without ingress is allowed", http.MethodGet, nil, http.StatusOK, true},
		{"write without ingress is refused", http.MethodPost, nil, http.StatusForbidden, false},
		{"write through ingress without the header is refused", http.MethodPost,
			map[string]string{"X-Ingress-Path": "/api/hassio_ingress/abc"}, http.StatusForbidden, false},
		{"write through ingress with the header is allowed", http.MethodPost,
			map[string]string{"X-Ingress-Path": "/api/hassio_ingress/abc", requestHeader: requestHeaderValue},
			http.StatusOK, true},
		{"delete is treated as a write", http.MethodDelete, nil, http.StatusForbidden, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reached = false
			req := httptest.NewRequest(tc.method, "/api/server/start", nil)
			for key, value := range tc.headers {
				req.Header.Set(key, value)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status %d, want %d (%s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if reached != tc.wantReach {
				t.Fatalf("handler reached=%v, want %v", reached, tc.wantReach)
			}
		})
	}
}

func TestAllowDirectAccessOptionOpensWritesWithTheHeader(t *testing.T) {
	server := newServer(t, t.TempDir(), true)
	handler := server.withSecurity(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/server/start", nil)
	req.Header.Set(requestHeader, requestHeaderValue)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected the request to be allowed, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestActorIdentifiesTheHomeAssistantUser(t *testing.T) {
	server := newServer(t, t.TempDir(), false)
	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	if got := server.actor(req); got != "api" {
		t.Errorf("expected api, got %q", got)
	}
	req.Header.Set("X-Ingress-Path", "/x")
	if got := server.actor(req); got != "ingress" {
		t.Errorf("expected ingress, got %q", got)
	}
	req.Header.Set("X-Remote-User-Display-Name", "Gabor")
	if got := server.actor(req); got != "ha:Gabor" {
		t.Errorf("expected the Home Assistant user, got %q", got)
	}
}

// statusAnyRedirect stands for "any 3xx" in the table below.
const statusAnyRedirect = -1

func TestStaticFilesAreServedAndConfined(t *testing.T) {
	frontend := t.TempDir()
	if err := os.WriteFile(filepath.Join(frontend, "index.html"), []byte("<h1>app</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(frontend, "styles.css"), []byte("body{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(filepath.Dir(frontend), "secret.txt")
	if err := os.WriteFile(secret, []byte("top secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := newServer(t, frontend, false)
	handler := server.Handler()

	cases := []struct {
		path     string
		wantCode int
		wantBody string
	}{
		{"/", http.StatusOK, "<h1>app</h1>"},
		{"/index.html", http.StatusOK, "<h1>app</h1>"},
		{"/styles.css", http.StatusOK, "body{}"},
		// Unknown paths fall back to the app shell so deep links work.
		{"/worlds", http.StatusOK, "<h1>app</h1>"},
		// Anything that tries to leave the frontend directory is redirected by the
		// router, refused, or falls back to the shell - never served.
		// The redirect status differs between Go's path handling on Linux and on
		// Windows; what matters is that it redirects rather than serving the file.
		{"/../secret.txt", statusAnyRedirect, ""},
		{"/%2e%2e/secret.txt", http.StatusBadRequest, ""},
		{"/subdir/../secret.txt", statusAnyRedirect, ""},
		{"/api/does-not-exist", http.StatusNotFound, ""},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			switch {
			case tc.wantCode == statusAnyRedirect:
				if rec.Code < 300 || rec.Code > 399 {
					t.Fatalf("status %d, want a redirect (%s)", rec.Code, rec.Body.String())
				}
			case rec.Code != tc.wantCode:
				t.Fatalf("status %d, want %d (%s)", rec.Code, tc.wantCode, rec.Body.String())
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Fatalf("body %q, want %q", rec.Body.String(), tc.wantBody)
			}
			if rec.Body.String() == "top secret" {
				t.Fatal("a file outside the frontend directory was served")
			}
		})
	}
}

func TestIngressPathsWithAPrefixStillResolve(t *testing.T) {
	// Ingress rewrites the path before the request reaches the add-on, so what
	// arrives here is already relative to the app root. This test documents that
	// the router does not depend on the Ingress prefix in any way.
	frontend := t.TempDir()
	if err := os.WriteFile(filepath.Join(frontend, "index.html"), []byte("shell"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := newServer(t, frontend, false)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Ingress-Path", "/api/hassio_ingress/tokenvalue")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "shell" {
		t.Fatalf("unexpected response %d %q", rec.Code, rec.Body.String())
	}
}

func TestStatusForErrorMapsDomainErrors(t *testing.T) {
	cases := map[error]int{
		commands.ErrConfirmation{Expected: "DELETE", Action: "x"}: http.StatusPreconditionRequired,
		supervisor.ErrBusy:            http.StatusConflict,
		supervisor.ErrAlreadyRunning:  http.StatusConflict,
		supervisor.ErrNotRunning:      http.StatusConflict,
		supervisor.ErrEULANotAccepted: http.StatusConflict,
		generation.ErrNoPlugin:        http.StatusConflict,
		generation.ErrLowDisk:         http.StatusConflict,
		worlds.ErrNotFound:            http.StatusNotFound,
		backups.ErrNotFound:           http.StatusNotFound,
		worlds.ErrExists:              http.StatusConflict,
		worlds.ErrUnsafeArchive:       http.StatusBadRequest,
		appcfg.ErrUnsafePath:          http.StatusBadRequest,
		errors.New("something else"):  http.StatusBadRequest,
	}
	for err, want := range cases {
		if got := statusForError(err); got != want {
			t.Errorf("%v: got %d, want %d", err, got, want)
		}
	}
	// Wrapped errors must map the same way.
	wrapped := errors.Join(errors.New("context"), worlds.ErrNotFound)
	if got := statusForError(wrapped); got != http.StatusNotFound {
		t.Errorf("wrapped not-found mapped to %d", got)
	}
}

func TestFailRedactsSecretsInErrorMessages(t *testing.T) {
	server := newServer(t, t.TempDir(), false)
	rec := httptest.NewRecorder()
	server.fail(rec, http.StatusBadRequest, errors.New(`could not connect: password=hunter2 host=broker`))
	body := rec.Body.String()
	if contains(body, "hunter2") {
		t.Fatalf("the response leaked a secret: %s", body)
	}
	if !contains(body, "***") {
		t.Fatalf("expected the secret to be masked: %s", body)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (len(needle) == 0 ||
		func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		}())
}
