// Package store owns the SQLite state database, the audit log and the recovery
// journal. Everything that must survive a power cut goes through here.
package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver: no cgo, cross-compiles to arm64
)

const schemaVersion = 1

type Store struct {
	db        *sql.DB
	auditPath string
	log       *slog.Logger
	closed    atomic.Bool
}

// Open opens (or repairs) the state database. A database that fails its
// integrity check is moved aside and recreated: losing labels and history is bad,
// but refusing to start the add-on is worse, and the worlds and backups
// themselves live on the filesystem and in the restic repository.
func Open(dbPath, auditPath string, log *slog.Logger) (*Store, error) {
	if log == nil {
		log = slog.Default()
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	s, err := openAt(dbPath, auditPath, log)
	if err == nil {
		return s, nil
	}
	log.Error("state database unusable, recreating", "error", err)
	corrupt := fmt.Sprintf("%s.corrupt-%d", dbPath, time.Now().Unix())
	if renameErr := os.Rename(dbPath, corrupt); renameErr != nil && !os.IsNotExist(renameErr) {
		return nil, fmt.Errorf("move corrupted database aside: %w (original error: %v)", renameErr, err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(dbPath + suffix)
	}
	s, err2 := openAt(dbPath, auditPath, log)
	if err2 != nil {
		return nil, err2
	}
	_ = s.Audit(AuditEntry{
		Actor: "controller", Action: "database.recreated", Target: filepath.Base(dbPath),
		Detail: "previous database failed its integrity check and was moved to " + filepath.Base(corrupt),
		Result: "ok",
	})
	return s, nil
}

func openAt(dbPath, auditPath string, log *slog.Logger) (*Store, error) {
	dsn := "file:" + filepath.ToSlash(dbPath) + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite plus a single writer connection avoids "database is locked" entirely.
	db.SetMaxOpenConns(1)
	db.SetConnMaxLifetime(0)

	var result string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&result); err != nil {
		db.Close()
		return nil, fmt.Errorf("integrity check: %w", err)
	}
	if result != "ok" {
		db.Close()
		return nil, fmt.Errorf("integrity check reported %q", result)
	}
	s := &Store{db: db, auditPath: auditPath, log: log}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	s.closed.Store(true)
	return s.db.Close()
}

// IsClosed lets background workers skip work after shutdown instead of logging
// "database is closed" errors.
func (s *Store) IsClosed() bool { return s.closed.Load() }

// DB exposes the handle for tests only.
func (s *Store) DB() *sql.DB { return s.db }

func (s *Store) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts TEXT NOT NULL,
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			target TEXT NOT NULL DEFAULT '',
			detail TEXT NOT NULL DEFAULT '',
			result TEXT NOT NULL DEFAULT 'ok'
		)`,
		`CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC)`,
		`CREATE TABLE IF NOT EXISTS journal (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			op TEXT NOT NULL,
			phase TEXT NOT NULL,
			payload TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL DEFAULT 'open',
			detail TEXT NOT NULL DEFAULT '',
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS journal_status ON journal(status)`,
		`CREATE TABLE IF NOT EXISTS sizes (
			path TEXT PRIMARY KEY,
			bytes INTEGER NOT NULL,
			files INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS backups (
			id TEXT PRIMARY KEY,
			snapshot_id TEXT NOT NULL DEFAULT '',
			world_id TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL DEFAULT 'manual',
			label TEXT NOT NULL DEFAULT '',
			notes TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'running',
			consistency TEXT NOT NULL DEFAULT 'unknown',
			size_bytes INTEGER NOT NULL DEFAULT 0,
			added_bytes INTEGER NOT NULL DEFAULT 0,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			verified INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			finished_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS backups_created ON backups(created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS gen_jobs (
			id TEXT PRIMARY KEY,
			world_id TEXT NOT NULL,
			profile TEXT NOT NULL,
			status TEXT NOT NULL,
			params TEXT NOT NULL DEFAULT '{}',
			progress REAL NOT NULL DEFAULT 0,
			dimension_index INTEGER NOT NULL DEFAULT 0,
			chunks_done INTEGER NOT NULL DEFAULT 0,
			chunks_total INTEGER NOT NULL DEFAULT 0,
			rate REAL NOT NULL DEFAULT 0,
			elapsed_ms INTEGER NOT NULL DEFAULT 0,
			pause_reason TEXT NOT NULL DEFAULT '',
			detail TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS gen_jobs_status ON gen_jobs(status)`,
		`CREATE TABLE IF NOT EXISTS chunk_samples (
			world_id TEXT NOT NULL,
			dimension TEXT NOT NULL,
			bytes_per_chunk REAL NOT NULL,
			chunks_measured INTEGER NOT NULL,
			measured_at TEXT NOT NULL,
			PRIMARY KEY (world_id, dimension)
		)`,
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	if _, err := tx.Exec(`INSERT INTO meta(key,value) VALUES('schema_version',?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, schemaVersion); err != nil {
		return err
	}
	return tx.Commit()
}

// ---------------------------------------------------------------- key/value --

func (s *Store) SetKV(key string, value string) error {
	_, err := s.db.Exec(`INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		key, value, nowStr())
	return err
}

func (s *Store) GetKV(key string) (string, bool, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM kv WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

func (s *Store) SetJSON(key string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.SetKV(key, string(raw))
}

// GetJSON decodes a stored JSON value. Missing keys leave out untouched.
func (s *Store) GetJSON(key string, out any) (bool, error) {
	raw, ok, err := s.GetKV(key)
	if err != nil || !ok {
		return false, err
	}
	if err := json.Unmarshal([]byte(raw), out); err != nil {
		return false, fmt.Errorf("decode %s: %w", key, err)
	}
	return true, nil
}

func (s *Store) IncrKV(key string, delta int64) (int64, error) {
	cur, _, err := s.GetKV(key)
	if err != nil {
		return 0, err
	}
	var n int64
	if cur != "" {
		_, _ = fmt.Sscanf(cur, "%d", &n)
	}
	n += delta
	return n, s.SetKV(key, fmt.Sprint(n))
}

func nowStr() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func parseTime(v string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return time.Time{}
	}
	return t
}
