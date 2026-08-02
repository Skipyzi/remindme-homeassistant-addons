// Package bridge receives telemetry from the mcbridge Paper plugin.
//
// Telemetry that cannot be scraped from the console reliably - TPS, MSPT, JVM
// heap, loaded chunks, entity counts - is pushed by a small plugin over a Unix
// domain socket inside /data. The plugin dials the controller, so no port is
// opened and nothing is reachable from the network. The first line of every
// connection must carry the shared token stored with 0600 permissions.
package bridge

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
)

// Telemetry is the payload the plugin sends, roughly once per second.
type Telemetry struct {
	OnlinePlayers int              `json:"online_players"`
	MaxPlayers    int              `json:"max_players"`
	Players       []string         `json:"players"`
	TPS           []float64        `json:"tps"`
	MSPT          float64          `json:"mspt"`
	LoadedChunks  int64            `json:"loaded_chunks"`
	Entities      int64            `json:"entities"`
	HeapUsedMB    int64            `json:"heap_used_mb"`
	HeapMaxMB     int64            `json:"heap_max_mb"`
	Worlds        map[string]World `json:"worlds"`
	ServerVersion string           `json:"server_version"`
	PluginVersion string           `json:"plugin_version"`
	ReceivedAt    time.Time        `json:"received_at"`
}

type World struct {
	LoadedChunks int64 `json:"loaded_chunks"`
	Entities     int64 `json:"entities"`
}

// TPS1m returns the one-minute average, or 0 when unknown.
func (t Telemetry) TPS1m() float64 {
	if len(t.TPS) == 0 {
		return 0
	}
	return t.TPS[0]
}

// Fresh reports whether the telemetry is recent enough to display.
func (t Telemetry) Fresh(maxAge time.Duration) bool {
	return !t.ReceivedAt.IsZero() && time.Since(t.ReceivedAt) <= maxAge
}

type Server struct {
	socketPath string
	tokenPath  string
	bus        *events.Bus
	log        *slog.Logger

	mu       sync.RWMutex
	latest   Telemetry
	token    string
	listener net.Listener
	conns    map[net.Conn]struct{}
}

func New(socketPath, tokenPath string, bus *events.Bus, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{
		socketPath: socketPath,
		tokenPath:  tokenPath,
		bus:        bus,
		log:        log.With("component", "bridge"),
		conns:      map[net.Conn]struct{}{},
	}
}

// EnsureToken creates the shared secret if it does not exist yet.
func (s *Server) EnsureToken() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if raw, err := os.ReadFile(s.tokenPath); err == nil && len(raw) >= 32 {
		s.token = string(trimSpace(raw))
		return s.token, nil
	}
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(s.tokenPath), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(s.tokenPath, []byte(token+"\n"), 0o600); err != nil {
		return "", err
	}
	s.token = token
	return token, nil
}

// Start begins listening. A stale socket file from a previous run is removed
// first: an add-on restart always invalidates it.
func (s *Server) Start() error {
	if _, err := s.EnsureToken(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.socketPath), 0o700); err != nil {
		return err
	}
	_ = os.Remove(s.socketPath)
	ln, err := net.Listen("unix", s.socketPath)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", s.socketPath, err)
	}
	if err := os.Chmod(s.socketPath, 0o600); err != nil {
		s.log.Warn("could not tighten socket permissions", "error", err)
	}
	s.mu.Lock()
	s.listener = ln
	s.mu.Unlock()
	go s.acceptLoop(ln)
	return nil
}

func (s *Server) Close() error {
	s.mu.Lock()
	ln := s.listener
	conns := make([]net.Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.listener = nil
	s.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
	if ln != nil {
		_ = ln.Close()
	}
	_ = os.Remove(s.socketPath)
	return nil
}

func (s *Server) acceptLoop(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			s.log.Warn("accept failed", "error", err)
			time.Sleep(time.Second)
			continue
		}
		s.mu.Lock()
		s.conns[conn] = struct{}{}
		s.mu.Unlock()
		go s.handle(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	defer func() {
		s.mu.Lock()
		delete(s.conns, conn)
		s.mu.Unlock()
		_ = conn.Close()
	}()

	reader := bufio.NewReaderSize(conn, 64*1024)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))

	var hello struct {
		Token         string `json:"token"`
		PluginVersion string `json:"plugin_version"`
		ServerVersion string `json:"server_version"`
	}
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return
	}
	if err := json.Unmarshal(line, &hello); err != nil {
		s.log.Warn("bridge handshake was not valid JSON")
		return
	}
	s.mu.RLock()
	expected := s.token
	s.mu.RUnlock()
	if expected == "" || !constantTimeEqual(hello.Token, expected) {
		s.log.Warn("bridge handshake rejected: bad token")
		_, _ = conn.Write([]byte(`{"ok":false,"error":"unauthorized"}` + "\n"))
		return
	}
	if _, err := conn.Write([]byte(`{"ok":true}` + "\n")); err != nil {
		return
	}
	s.log.Info("management bridge connected", "plugin_version", hello.PluginVersion, "server_version", hello.ServerVersion)

	for {
		// A running server sends telemetry every second; 30 s of silence means
		// the plugin or the server is gone.
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		raw, err := reader.ReadBytes('\n')
		if err != nil {
			s.log.Info("management bridge disconnected", "reason", err)
			s.markStale()
			return
		}
		var t Telemetry
		if err := json.Unmarshal(raw, &t); err != nil {
			continue
		}
		t.ReceivedAt = time.Now()
		if t.PluginVersion == "" {
			t.PluginVersion = hello.PluginVersion
		}
		if t.ServerVersion == "" {
			t.ServerVersion = hello.ServerVersion
		}
		s.mu.Lock()
		s.latest = t
		s.mu.Unlock()
	}
}

// markStale clears the cached telemetry so the dashboard stops showing values
// that no longer come from a live server.
func (s *Server) markStale() {
	s.mu.Lock()
	s.latest = Telemetry{}
	s.mu.Unlock()
	s.bus.Publish(events.TypeStatsUpdate, map[string]any{"bridge": "disconnected"})
}

// Latest returns the most recent telemetry and whether it is fresh.
func (s *Server) Latest() (Telemetry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.latest, s.latest.Fresh(15*time.Second)
}

func (s *Server) Connected() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.conns) > 0
}
