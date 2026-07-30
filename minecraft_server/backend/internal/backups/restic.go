// Package backups implements incremental, deduplicated world backups on top of
// restic, plus the save-off/flush/snapshot pipeline that makes a live backup
// consistent without keeping saving disabled for more than a moment.
package backups

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
)

// Restic wraps the restic binary. Every call is an argv array: no shell, so no
// amount of odd characters in a label or a path can turn into a command.
type Restic struct {
	Bin          string
	Repo         string
	PasswordFile string
	CacheDir     string
	Log          *slog.Logger
	// ExtraEnv adds variables to the subprocess environment. Production leaves it
	// empty: restic is given only the repository, the password file and a cache
	// directory. Tests use it to steer the fake binary.
	ExtraEnv []string
}

var ErrResticMissing = errors.New("restic is not installed in this container")

func (r *Restic) env() []string {
	env := []string{
		"RESTIC_REPOSITORY=" + r.Repo,
		"RESTIC_PASSWORD_FILE=" + r.PasswordFile,
		"RESTIC_CACHE_DIR=" + r.CacheDir,
		"HOME=" + os.TempDir(),
		"RESTIC_PROGRESS_FPS=0.2",
	}
	for _, key := range []string{"PATH", "TZ", "TMPDIR"} {
		if v := os.Getenv(key); v != "" {
			env = append(env, key+"="+v)
		}
	}
	return append(env, r.ExtraEnv...)
}

func (r *Restic) logger() *slog.Logger {
	if r.Log == nil {
		return slog.Default()
	}
	return r.Log
}

// EnsurePassword creates the repository key on first use. The file is 0600 and is
// the only copy: losing it makes the repository unreadable, which the
// documentation states plainly.
func (r *Restic) EnsurePassword() error {
	if st, err := os.Stat(r.PasswordFile); err == nil && st.Size() > 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(r.PasswordFile), 0o700); err != nil {
		return err
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	secret := base64.RawURLEncoding.EncodeToString(buf)
	if err := atomicfs.WriteFile(r.PasswordFile, []byte(secret+"\n"), 0o600); err != nil {
		return err
	}
	return os.Chmod(r.PasswordFile, 0o600)
}

// Available reports whether the restic binary can be executed.
func (r *Restic) Available(ctx context.Context) (string, error) {
	out, err := r.run(ctx, nil, "version")
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrResticMissing, err)
	}
	return strings.TrimSpace(firstLine(out)), nil
}

// EnsureRepo initialises the repository if it does not exist yet.
func (r *Restic) EnsureRepo(ctx context.Context) error {
	if err := r.EnsurePassword(); err != nil {
		return err
	}
	if err := os.MkdirAll(r.Repo, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(r.CacheDir, 0o700); err != nil {
		return err
	}
	if _, err := r.run(ctx, nil, "cat", "config"); err == nil {
		return nil
	}
	if _, err := r.run(ctx, nil, "init"); err != nil {
		return fmt.Errorf("initialise backup repository: %w", err)
	}
	r.logger().Info("initialised restic repository", "repo", r.Repo)
	return nil
}

// Progress is reported while restic works.
type Progress struct {
	Phase        string  `json:"phase"`
	PercentDone  float64 `json:"percent_done"`
	BytesDone    int64   `json:"bytes_done"`
	TotalBytes   int64   `json:"total_bytes"`
	FilesDone    int64   `json:"files_done"`
	CurrentFiles string  `json:"current_files,omitempty"`
}

// Summary is restic's own report at the end of a backup.
type Summary struct {
	SnapshotID      string  `json:"snapshot_id"`
	FilesNew        int64   `json:"files_new"`
	FilesChanged    int64   `json:"files_changed"`
	FilesUnmodified int64   `json:"files_unmodified"`
	DataAdded       int64   `json:"data_added"`
	TotalBytes      int64   `json:"total_bytes_processed"`
	TotalFiles      int64   `json:"total_files_processed"`
	Duration        float64 `json:"total_duration"`
}

// Backup snapshots dir. tags are attached so snapshots can be filtered per world
// and per kind later.
func (r *Restic) Backup(ctx context.Context, dir string, tags []string, onProgress func(Progress)) (Summary, error) {
	args := []string{"backup", "--json", "--no-scan", dir}
	for _, tag := range tags {
		args = append(args, "--tag", tag)
	}
	var summary Summary
	err := r.stream(ctx, args, func(raw []byte) {
		var msg struct {
			MessageType  string   `json:"message_type"`
			PercentDone  float64  `json:"percent_done"`
			BytesDone    int64    `json:"bytes_done"`
			TotalBytes   int64    `json:"total_bytes"`
			FilesDone    int64    `json:"files_done"`
			CurrentFiles []string `json:"current_files"`
			Summary
		}
		if err := json.Unmarshal(raw, &msg); err != nil {
			return
		}
		switch msg.MessageType {
		case "status":
			if onProgress != nil {
				onProgress(Progress{
					Phase:        "backup",
					PercentDone:  msg.PercentDone * 100,
					BytesDone:    msg.BytesDone,
					TotalBytes:   msg.TotalBytes,
					FilesDone:    msg.FilesDone,
					CurrentFiles: strings.Join(msg.CurrentFiles, ", "),
				})
			}
		case "summary":
			summary = msg.Summary
		}
	})
	if err != nil {
		return summary, err
	}
	if summary.SnapshotID == "" {
		return summary, errors.New("restic did not report a snapshot id")
	}
	return summary, nil
}

// Snapshot is one entry from `restic snapshots --json`.
type Snapshot struct {
	ID       string    `json:"id"`
	ShortID  string    `json:"short_id"`
	Time     time.Time `json:"time"`
	Paths    []string  `json:"paths"`
	Tags     []string  `json:"tags"`
	Hostname string    `json:"hostname"`
}

func (r *Restic) Snapshots(ctx context.Context, tags []string) ([]Snapshot, error) {
	args := []string{"snapshots", "--json"}
	for _, tag := range tags {
		args = append(args, "--tag", tag)
	}
	out, err := r.run(ctx, nil, args...)
	if err != nil {
		return nil, err
	}
	var snapshots []Snapshot
	if err := json.Unmarshal([]byte(out), &snapshots); err != nil {
		return nil, fmt.Errorf("parse snapshot list: %w", err)
	}
	return snapshots, nil
}

// Restore extracts a snapshot into target.
func (r *Restic) Restore(ctx context.Context, snapshotID, target string, onProgress func(Progress)) error {
	args := []string{"restore", snapshotID, "--target", target, "--json"}
	return r.stream(ctx, args, func(raw []byte) {
		var msg struct {
			MessageType  string  `json:"message_type"`
			PercentDone  float64 `json:"percent_done"`
			BytesRestored int64  `json:"bytes_restored"`
			TotalBytes   int64   `json:"total_bytes"`
			FilesRestored int64  `json:"files_restored"`
		}
		if err := json.Unmarshal(raw, &msg); err != nil {
			return
		}
		if msg.MessageType == "status" && onProgress != nil {
			onProgress(Progress{
				Phase:       "restore",
				PercentDone: msg.PercentDone * 100,
				BytesDone:   msg.BytesRestored,
				TotalBytes:  msg.TotalBytes,
				FilesDone:   msg.FilesRestored,
			})
		}
	})
}

// Forget applies a retention policy and prunes unreferenced data.
func (r *Restic) Forget(ctx context.Context, keepLast, keepDaily, keepWeekly, keepMonthly int, prune bool) (string, error) {
	args := []string{"forget"}
	if keepLast > 0 {
		args = append(args, "--keep-last", itoa(keepLast))
	}
	if keepDaily > 0 {
		args = append(args, "--keep-daily", itoa(keepDaily))
	}
	if keepWeekly > 0 {
		args = append(args, "--keep-weekly", itoa(keepWeekly))
	}
	if keepMonthly > 0 {
		args = append(args, "--keep-monthly", itoa(keepMonthly))
	}
	if prune {
		args = append(args, "--prune")
	}
	return r.run(ctx, nil, args...)
}

// ForgetSnapshot deletes a single snapshot.
func (r *Restic) ForgetSnapshot(ctx context.Context, snapshotID string, prune bool) error {
	args := []string{"forget", snapshotID}
	if prune {
		args = append(args, "--prune")
	}
	_, err := r.run(ctx, nil, args...)
	return err
}

// Check verifies repository structure. readDataSubset (for example "5%") also
// re-reads part of the actual data, which is slow on a Pi and therefore opt-in.
func (r *Restic) Check(ctx context.Context, readDataSubset string) (string, error) {
	args := []string{"check"}
	if readDataSubset != "" {
		args = append(args, "--read-data-subset", readDataSubset)
	}
	return r.run(ctx, nil, args...)
}

// RepoStats is the size of the deduplicated repository.
type RepoStats struct {
	TotalSize      int64 `json:"total_size"`
	TotalFileCount int64 `json:"total_file_count"`
	SnapshotCount  int   `json:"snapshots_count"`
}

func (r *Restic) Stats(ctx context.Context, mode string) (RepoStats, error) {
	if mode == "" {
		mode = "raw-data"
	}
	out, err := r.run(ctx, nil, "stats", "--json", "--mode", mode)
	if err != nil {
		return RepoStats{}, err
	}
	var stats RepoStats
	if err := json.Unmarshal([]byte(out), &stats); err != nil {
		return RepoStats{}, err
	}
	return stats, nil
}

// ListFiles returns the top-level entries of a snapshot, used for the restore
// preview.
func (r *Restic) ListFiles(ctx context.Context, snapshotID string, limit int) ([]FileEntry, error) {
	var out []FileEntry
	err := r.stream(ctx, []string{"ls", "--json", snapshotID}, func(raw []byte) {
		if len(out) >= limit {
			return
		}
		var entry FileEntry
		if err := json.Unmarshal(raw, &entry); err != nil {
			return
		}
		if entry.StructType != "node" {
			return
		}
		out = append(out, entry)
	})
	return out, err
}

type FileEntry struct {
	StructType string    `json:"struct_type"`
	Name       string    `json:"name"`
	Type       string    `json:"type"`
	Path       string    `json:"path"`
	Size       int64     `json:"size"`
	MTime      time.Time `json:"mtime"`
}

// ---------------------------------------------------------------- plumbing ----

func (r *Restic) bin() string {
	if r.Bin != "" {
		return r.Bin
	}
	return "restic"
}

func (r *Restic) run(ctx context.Context, stdin io.Reader, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, r.bin(), args...) // #nosec G204 - fixed verbs plus validated paths
	cmd.Env = r.env()
	cmd.Stdin = stdin
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return stdout.String(), fmt.Errorf("restic %s: %w: %s",
			strings.Join(args, " "), err, strings.TrimSpace(lastLines(stderr.String(), 3)))
	}
	return stdout.String(), nil
}

// stream runs restic and feeds each stdout line to fn. restic's --json output is
// newline delimited, so progress can be reported while the command runs.
func (r *Restic) stream(ctx context.Context, args []string, fn func([]byte)) error {
	cmd := exec.CommandContext(ctx, r.bin(), args...) // #nosec G204 - fixed verbs plus validated paths
	cmd.Env = r.env()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		fn(line)
	}
	waitErr := cmd.Wait()
	if waitErr != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("restic %s cancelled: %w", args[0], ctx.Err())
		}
		return fmt.Errorf("restic %s: %w: %s", args[0], waitErr, strings.TrimSpace(lastLines(stderr.String(), 3)))
	}
	return nil
}

func firstLine(s string) string {
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		return s[:idx]
	}
	return s
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "; ")
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }
