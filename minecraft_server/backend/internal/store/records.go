package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// ------------------------------------------------------------- cached sizes --

// SizeRecord is a cached directory size. Walking a multi-gigabyte world on every
// dashboard refresh would be pointless I/O, so sizes are refreshed in the
// background and after filesystem operations.
type SizeRecord struct {
	Path      string    `json:"path"`
	Bytes     int64     `json:"bytes"`
	Files     int64     `json:"files"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (s *Store) PutSize(path string, bytes, files int64) error {
	_, err := s.db.Exec(`INSERT INTO sizes(path,bytes,files,updated_at) VALUES(?,?,?,?)
		ON CONFLICT(path) DO UPDATE SET bytes=excluded.bytes, files=excluded.files, updated_at=excluded.updated_at`,
		path, bytes, files, nowStr())
	return err
}

func (s *Store) GetSize(path string) (SizeRecord, bool, error) {
	var rec SizeRecord
	var updated string
	err := s.db.QueryRow(`SELECT path,bytes,files,updated_at FROM sizes WHERE path=?`, path).
		Scan(&rec.Path, &rec.Bytes, &rec.Files, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return rec, false, nil
	}
	if err != nil {
		return rec, false, err
	}
	rec.UpdatedAt = parseTime(updated)
	return rec, true, nil
}

func (s *Store) DeleteSize(path string) error {
	_, err := s.db.Exec(`DELETE FROM sizes WHERE path=?`, path)
	return err
}

// ------------------------------------------------------------------ backups --

const (
	BackupRunning   = "running"
	BackupComplete  = "complete"
	BackupFailed    = "failed"
	BackupCancelled = "cancelled"
)

// BackupRecord is the controller's view of a restic snapshot: the labels, notes,
// timings and consistency information restic itself does not track.
type BackupRecord struct {
	ID          string `json:"id"`
	SnapshotID  string `json:"snapshot_id"`
	WorldID     string `json:"world_id"`
	Kind        string `json:"kind"`
	Label       string `json:"label"`
	Notes       string `json:"notes"`
	Status      string `json:"status"`
	Consistency string `json:"consistency"`
	// Flavour is the server flavour the world was written by. A restore into
	// another flavour is refused: the world formats are not interchangeable.
	Flavour    string    `json:"flavour"`
	SizeBytes  int64     `json:"size_bytes"`
	AddedBytes int64     `json:"added_bytes"`
	DurationMs int64     `json:"duration_ms"`
	Verified   bool      `json:"verified"`
	CreatedAt  time.Time `json:"created_at"`
	FinishedAt time.Time `json:"finished_at"`
}

func (s *Store) PutBackup(b BackupRecord) error {
	if b.CreatedAt.IsZero() {
		b.CreatedAt = time.Now().UTC()
	}
	finished := ""
	if !b.FinishedAt.IsZero() {
		finished = b.FinishedAt.UTC().Format(time.RFC3339Nano)
	}
	verified := 0
	if b.Verified {
		verified = 1
	}
	_, err := s.db.Exec(`INSERT INTO backups
		(id,snapshot_id,world_id,kind,label,notes,status,consistency,size_bytes,added_bytes,duration_ms,verified,created_at,finished_at,flavour)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			snapshot_id=excluded.snapshot_id, world_id=excluded.world_id, kind=excluded.kind,
			label=excluded.label, notes=excluded.notes, status=excluded.status,
			consistency=excluded.consistency, size_bytes=excluded.size_bytes,
			added_bytes=excluded.added_bytes, duration_ms=excluded.duration_ms,
			verified=excluded.verified, finished_at=excluded.finished_at, flavour=excluded.flavour`,
		b.ID, b.SnapshotID, b.WorldID, b.Kind, b.Label, b.Notes, b.Status, b.Consistency,
		b.SizeBytes, b.AddedBytes, b.DurationMs, verified,
		b.CreatedAt.UTC().Format(time.RFC3339Nano), finished, flavourOr(b.Flavour))
	return err
}

func (s *Store) ListBackups(limit int) ([]BackupRecord, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT id,snapshot_id,world_id,kind,label,notes,status,consistency,
		size_bytes,added_bytes,duration_ms,verified,created_at,finished_at,flavour
		FROM backups ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BackupRecord
	for rows.Next() {
		b, err := scanBackup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) GetBackup(id string) (BackupRecord, bool, error) {
	row := s.db.QueryRow(`SELECT id,snapshot_id,world_id,kind,label,notes,status,consistency,
		size_bytes,added_bytes,duration_ms,verified,created_at,finished_at,flavour
		FROM backups WHERE id=? OR snapshot_id=?`, id, id)
	b, err := scanBackup(row)
	if errors.Is(err, sql.ErrNoRows) {
		return b, false, nil
	}
	if err != nil {
		return b, false, err
	}
	return b, true, nil
}

func (s *Store) DeleteBackup(id string) error {
	_, err := s.db.Exec(`DELETE FROM backups WHERE id=? OR snapshot_id=?`, id, id)
	return err
}

// LastSuccessfulBackup is shown on the dashboard and published to Home Assistant.
func (s *Store) LastSuccessfulBackup() (BackupRecord, bool, error) {
	row := s.db.QueryRow(`SELECT id,snapshot_id,world_id,kind,label,notes,status,consistency,
		size_bytes,added_bytes,duration_ms,verified,created_at,finished_at,flavour
		FROM backups WHERE status=? ORDER BY created_at DESC LIMIT 1`, BackupComplete)
	b, err := scanBackup(row)
	if errors.Is(err, sql.ErrNoRows) {
		return b, false, nil
	}
	if err != nil {
		return b, false, err
	}
	return b, true, nil
}

// flavourOr defaults a missing flavour to the one that existed before the
// setting did.
func flavourOr(v string) string {
	if v == "" {
		return "paper"
	}
	return v
}

func scanBackup(row rowScanner) (BackupRecord, error) {
	var b BackupRecord
	var verified int
	var created, finished string
	if err := row.Scan(&b.ID, &b.SnapshotID, &b.WorldID, &b.Kind, &b.Label, &b.Notes, &b.Status,
		&b.Consistency, &b.SizeBytes, &b.AddedBytes, &b.DurationMs, &verified, &created, &finished,
		&b.Flavour); err != nil {
		return b, err
	}
	b.Verified = verified == 1
	b.CreatedAt = parseTime(created)
	b.FinishedAt = parseTime(finished)
	return b, nil
}

// ---------------------------------------------------------- generation jobs --

const (
	JobQueued    = "queued"
	JobRunning   = "running"
	JobPaused    = "paused"
	JobCompleted = "completed"
	JobCancelled = "cancelled"
	JobFailed    = "failed"
)

// JobRecord persists a terrain generation job so it survives add-on restarts.
type JobRecord struct {
	ID             string          `json:"id"`
	WorldID        string          `json:"world_id"`
	Profile        string          `json:"profile"`
	Status         string          `json:"status"`
	Params         json.RawMessage `json:"params"`
	Progress       float64         `json:"progress"`
	DimensionIndex int             `json:"dimension_index"`
	ChunksDone     int64           `json:"chunks_done"`
	ChunksTotal    int64           `json:"chunks_total"`
	Rate           float64         `json:"rate"`
	ElapsedMs      int64           `json:"elapsed_ms"`
	PauseReason    string          `json:"pause_reason"`
	Detail         string          `json:"detail"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

func (s *Store) PutJob(j JobRecord) error {
	if j.CreatedAt.IsZero() {
		j.CreatedAt = time.Now().UTC()
	}
	if len(j.Params) == 0 {
		j.Params = json.RawMessage(`{}`)
	}
	_, err := s.db.Exec(`INSERT INTO gen_jobs
		(id,world_id,profile,status,params,progress,dimension_index,chunks_done,chunks_total,rate,elapsed_ms,pause_reason,detail,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			world_id=excluded.world_id, profile=excluded.profile, status=excluded.status,
			params=excluded.params, progress=excluded.progress, dimension_index=excluded.dimension_index,
			chunks_done=excluded.chunks_done, chunks_total=excluded.chunks_total, rate=excluded.rate,
			elapsed_ms=excluded.elapsed_ms, pause_reason=excluded.pause_reason,
			detail=excluded.detail, updated_at=excluded.updated_at`,
		j.ID, j.WorldID, j.Profile, j.Status, string(j.Params), j.Progress, j.DimensionIndex,
		j.ChunksDone, j.ChunksTotal, j.Rate, j.ElapsedMs, j.PauseReason, j.Detail,
		j.CreatedAt.UTC().Format(time.RFC3339Nano), nowStr())
	return err
}

func (s *Store) ListJobs(limit int) ([]JobRecord, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT id,world_id,profile,status,params,progress,dimension_index,
		chunks_done,chunks_total,rate,elapsed_ms,pause_reason,detail,created_at,updated_at
		FROM gen_jobs ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JobRecord
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

func (s *Store) GetJob(id string) (JobRecord, bool, error) {
	row := s.db.QueryRow(`SELECT id,world_id,profile,status,params,progress,dimension_index,
		chunks_done,chunks_total,rate,elapsed_ms,pause_reason,detail,created_at,updated_at
		FROM gen_jobs WHERE id=?`, id)
	j, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return j, false, nil
	}
	if err != nil {
		return j, false, err
	}
	return j, true, nil
}

// ActiveJob returns the single running or paused job, if any. The controller
// deliberately allows only one at a time on a Raspberry Pi.
func (s *Store) ActiveJob() (JobRecord, bool, error) {
	row := s.db.QueryRow(`SELECT id,world_id,profile,status,params,progress,dimension_index,
		chunks_done,chunks_total,rate,elapsed_ms,pause_reason,detail,created_at,updated_at
		FROM gen_jobs WHERE status IN (?,?,?) ORDER BY created_at ASC LIMIT 1`,
		JobRunning, JobPaused, JobQueued)
	j, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return j, false, nil
	}
	if err != nil {
		return j, false, err
	}
	return j, true, nil
}

func scanJob(row rowScanner) (JobRecord, error) {
	var j JobRecord
	var params, created, updated string
	if err := row.Scan(&j.ID, &j.WorldID, &j.Profile, &j.Status, &params, &j.Progress,
		&j.DimensionIndex, &j.ChunksDone, &j.ChunksTotal, &j.Rate, &j.ElapsedMs,
		&j.PauseReason, &j.Detail, &created, &updated); err != nil {
		return j, err
	}
	j.Params = json.RawMessage(params)
	j.CreatedAt = parseTime(created)
	j.UpdatedAt = parseTime(updated)
	return j, nil
}

// ------------------------------------------------------------ chunk samples --

// ChunkSample is a measured bytes-per-chunk figure. Storage estimates are based
// on these measurements rather than a fixed constant, because terrain size varies
// enormously between dimensions and world types.
type ChunkSample struct {
	WorldID        string    `json:"world_id"`
	Dimension      string    `json:"dimension"`
	BytesPerChunk  float64   `json:"bytes_per_chunk"`
	ChunksMeasured int64     `json:"chunks_measured"`
	MeasuredAt     time.Time `json:"measured_at"`
}

func (s *Store) PutChunkSample(c ChunkSample) error {
	_, err := s.db.Exec(`INSERT INTO chunk_samples(world_id,dimension,bytes_per_chunk,chunks_measured,measured_at)
		VALUES(?,?,?,?,?)
		ON CONFLICT(world_id,dimension) DO UPDATE SET
			bytes_per_chunk=excluded.bytes_per_chunk,
			chunks_measured=excluded.chunks_measured,
			measured_at=excluded.measured_at`,
		c.WorldID, c.Dimension, c.BytesPerChunk, c.ChunksMeasured, nowStr())
	return err
}

func (s *Store) GetChunkSample(worldID, dimension string) (ChunkSample, bool, error) {
	var c ChunkSample
	var measured string
	err := s.db.QueryRow(`SELECT world_id,dimension,bytes_per_chunk,chunks_measured,measured_at
		FROM chunk_samples WHERE world_id=? AND dimension=?`, worldID, dimension).
		Scan(&c.WorldID, &c.Dimension, &c.BytesPerChunk, &c.ChunksMeasured, &measured)
	if errors.Is(err, sql.ErrNoRows) {
		return c, false, nil
	}
	if err != nil {
		return c, false, err
	}
	c.MeasuredAt = parseTime(measured)
	return c, true, nil
}
