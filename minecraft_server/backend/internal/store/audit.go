package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// AuditEntry records who did what to which object and how it ended. Every
// destructive action writes one.
type AuditEntry struct {
	ID     int64     `json:"id"`
	Time   time.Time `json:"time"`
	Actor  string    `json:"actor"`
	Action string    `json:"action"`
	Target string    `json:"target"`
	Detail string    `json:"detail"`
	Result string    `json:"result"`
}

// Audit writes to the database and appends a human-readable line to
// /data/audit/audit.log. The text file is the recovery aid: it can be read with
// nothing but the Home Assistant file editor when the controller will not start.
func (s *Store) Audit(e AuditEntry) error {
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	if e.Result == "" {
		e.Result = "ok"
	}
	if e.Actor == "" {
		e.Actor = "system"
	}
	e.Detail = Redact(e.Detail)
	res, err := s.db.Exec(`INSERT INTO audit(ts,actor,action,target,detail,result) VALUES(?,?,?,?,?,?)`,
		e.Time.Format(time.RFC3339Nano), e.Actor, e.Action, e.Target, e.Detail, e.Result)
	if err != nil {
		return err
	}
	if id, err := res.LastInsertId(); err == nil {
		e.ID = id
	}
	return s.appendAuditLine(e)
}

func (s *Store) appendAuditLine(e AuditEntry) error {
	if s.auditPath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.auditPath), 0o755); err != nil {
		return err
	}
	line := fmt.Sprintf("%s\t%s\t%s\t%s\t%s\t%s\n",
		e.Time.Format(time.RFC3339), e.Result, e.Actor, e.Action,
		orDash(e.Target), orDash(strings.ReplaceAll(e.Detail, "\n", " ")))
	f, err := os.OpenFile(s.auditPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line)
	return err
}

func orDash(v string) string {
	if v == "" {
		return "-"
	}
	return v
}

func (s *Store) RecentAudit(limit int, actionPrefix string) ([]AuditEntry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	query := `SELECT id,ts,actor,action,target,detail,result FROM audit`
	args := []any{}
	if actionPrefix != "" {
		query += ` WHERE action LIKE ?`
		args = append(args, actionPrefix+"%")
	}
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		var ts string
		if err := rows.Scan(&e.ID, &ts, &e.Actor, &e.Action, &e.Target, &e.Detail, &e.Result); err != nil {
			return nil, err
		}
		e.Time = parseTime(ts)
		out = append(out, e)
	}
	return out, rows.Err()
}

// secretHints are substrings that mark a value as sensitive. Anything that looks
// like a password, token or restic repository key is replaced before it can
// reach the audit log, the console history or an API response.
var secretHints = []string{"password", "passwd", "token", "secret", "api_key", "apikey", "rcon.password"}

// Redact masks obvious secrets in free-form text of the shape key=value or
// "key": "value".
func Redact(text string) string {
	if text == "" {
		return text
	}
	lower := strings.ToLower(text)
	for _, hint := range secretHints {
		idx := 0
		for {
			pos := strings.Index(lower[idx:], hint)
			if pos < 0 {
				break
			}
			start := idx + pos + len(hint)
			// Find the separator that follows the hint.
			sep := start
			for sep < len(text) && (text[sep] == ' ' || text[sep] == '"' || text[sep] == ':' || text[sep] == '=') {
				sep++
			}
			end := sep
			for end < len(text) && text[end] != ' ' && text[end] != '"' && text[end] != ',' && text[end] != '\n' {
				end++
			}
			if end > sep {
				text = text[:sep] + "***" + text[end:]
				lower = strings.ToLower(text)
			}
			idx = start
			if idx >= len(lower) {
				break
			}
		}
	}
	return text
}
