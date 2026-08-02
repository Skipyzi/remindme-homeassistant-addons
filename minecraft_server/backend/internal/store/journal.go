package store

import (
	"encoding/json"
	"time"
)

// Journal operation names. An open journal row after startup means the
// controller died in the middle of that operation and reconciliation must clean
// up after it.
const (
	OpBackup        = "backup"
	OpRestore       = "restore"
	OpWorldSwitch   = "world_switch"
	OpWorldImport   = "world_import"
	OpWorldDelete   = "world_delete"
	OpGeneration    = "generation"
	OpUpdate        = "server_update"
	OpConfigWrite   = "config_write"
	OpFlavourSwitch = "flavour_switch"
)

const (
	JournalOpen   = "open"
	JournalDone   = "done"
	JournalFailed = "failed"
)

type JournalEntry struct {
	ID        int64          `json:"id"`
	Op        string         `json:"op"`
	Phase     string         `json:"phase"`
	Payload   map[string]any `json:"payload"`
	Status    string         `json:"status"`
	Detail    string         `json:"detail"`
	StartedAt time.Time      `json:"started_at"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// JournalBegin records the intent to perform a multi-step operation. The row is
// committed before the first filesystem change happens.
func (s *Store) JournalBegin(op, phase string, payload map[string]any) (int64, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	now := nowStr()
	res, err := s.db.Exec(`INSERT INTO journal(op,phase,payload,status,started_at,updated_at)
		VALUES(?,?,?,?,?,?)`, op, phase, string(raw), JournalOpen, now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// JournalPhase advances an operation. Payload keys are merged, not replaced, so
// each phase can add the information recovery needs (staging paths, aside
// directories, snapshot ids).
func (s *Store) JournalPhase(id int64, phase string, payload map[string]any) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var raw string
	if err := tx.QueryRow(`SELECT payload FROM journal WHERE id=?`, id).Scan(&raw); err != nil {
		return err
	}
	merged := map[string]any{}
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &merged)
	}
	for k, v := range payload {
		merged[k] = v
	}
	next, err := json.Marshal(merged)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE journal SET phase=?, payload=?, updated_at=? WHERE id=?`,
		phase, string(next), nowStr(), id); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) JournalEnd(id int64, status, detail string) error {
	_, err := s.db.Exec(`UPDATE journal SET status=?, detail=?, updated_at=? WHERE id=?`,
		status, Redact(detail), nowStr(), id)
	return err
}

// OpenJournals lists unfinished operations, oldest first.
func (s *Store) OpenJournals() ([]JournalEntry, error) {
	rows, err := s.db.Query(`SELECT id,op,phase,payload,status,detail,started_at,updated_at
		FROM journal WHERE status=? ORDER BY id ASC`, JournalOpen)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JournalEntry
	for rows.Next() {
		e, err := scanJournal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// RecentJournals lists the most recent operations regardless of status; the UI
// shows this as the recovery journal.
func (s *Store) RecentJournals(limit int) ([]JournalEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT id,op,phase,payload,status,detail,started_at,updated_at
		FROM journal ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JournalEntry
	for rows.Next() {
		e, err := scanJournal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanJournal(rows rowScanner) (JournalEntry, error) {
	var e JournalEntry
	var payload, started, updated string
	if err := rows.Scan(&e.ID, &e.Op, &e.Phase, &payload, &e.Status, &e.Detail, &started, &updated); err != nil {
		return e, err
	}
	e.Payload = map[string]any{}
	if payload != "" {
		_ = json.Unmarshal([]byte(payload), &e.Payload)
	}
	e.StartedAt = parseTime(started)
	e.UpdatedAt = parseTime(updated)
	return e, nil
}

// PayloadString reads a string field from a journal payload.
func (e JournalEntry) PayloadString(key string) string {
	if v, ok := e.Payload[key].(string); ok {
		return v
	}
	return ""
}

func (e JournalEntry) PayloadBool(key string) bool {
	if v, ok := e.Payload[key].(bool); ok {
		return v
	}
	return false
}
