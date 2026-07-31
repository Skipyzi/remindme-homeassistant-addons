// Command fakerestic emulates the parts of restic the backup manager uses, with
// real deduplication accounting so the incremental-backup test measures something
// meaningful.
//
// The "repository" is a directory holding a copy of each snapshot plus an index of
// (path, size, modification time) triples. Bytes are only counted as added when a
// file is not already in the index, which is exactly the property the controller
// promises: unchanged region files cost nothing.
//
// FAKERESTIC_FAIL selects a failure mode: "backup", "restore", "check", "cat".
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		fail("no command")
	}
	repo := os.Getenv("RESTIC_REPOSITORY")
	if repo == "" && args[0] != "version" {
		fail("RESTIC_REPOSITORY is not set")
	}
	if os.Getenv("RESTIC_PASSWORD_FILE") == "" && args[0] != "version" {
		fail("RESTIC_PASSWORD_FILE is not set")
	}

	switch args[0] {
	case "version":
		fmt.Println("restic 0.17.3 compiled with go1.23 on linux/arm64 (fake)")
	case "init":
		must(os.MkdirAll(filepath.Join(repo, "snapshots"), 0o700))
		must(os.WriteFile(filepath.Join(repo, "config"), []byte("{\"version\":2}\n"), 0o600))
	case "cat":
		// "cat" stands in for a repository that exists but cannot be opened, which
		// is the case EnsureRepo must not treat as "not initialised yet".
		if os.Getenv("FAKERESTIC_FAIL") == "cat" {
			fail("config or key is damaged: ciphertext verification failed")
		}
		if _, err := os.Stat(filepath.Join(repo, "config")); err != nil {
			fail("repository does not exist")
		}
		fmt.Println("{\"version\":2}")
	case "backup":
		backup(repo, args[1:])
	case "snapshots":
		listSnapshots(repo)
	case "ls":
		listFiles(repo, args[1:])
	case "restore":
		restore(repo, args[1:])
	case "forget":
		forget(repo, args[1:])
	case "check":
		if os.Getenv("FAKERESTIC_FAIL") == "check" {
			fail("repository check failed (simulated)")
		}
		fmt.Println("no errors were found")
	case "stats":
		stats(repo)
	default:
		fail("unsupported command " + args[0])
	}
}

type snapshotMeta struct {
	ID       string    `json:"id"`
	ShortID  string    `json:"short_id"`
	Time     time.Time `json:"time"`
	Paths    []string  `json:"paths"`
	Tags     []string  `json:"tags"`
	Hostname string    `json:"hostname"`
}

func backup(repo string, args []string) {
	if os.Getenv("FAKERESTIC_FAIL") == "backup" {
		fail("backup failed (simulated)")
	}
	var target string
	var tags []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json", "--no-scan":
		case "--tag":
			if i+1 < len(args) {
				tags = append(tags, args[i+1])
				i++
			}
		default:
			if !strings.HasPrefix(args[i], "--") {
				target = args[i]
			}
		}
	}
	if target == "" {
		fail("no backup target")
	}

	indexPath := filepath.Join(repo, "index.json")
	index := map[string]int64{}
	if raw, err := os.ReadFile(indexPath); err == nil {
		_ = json.Unmarshal(raw, &index)
	}

	id := newID(target + time.Now().String())
	snapDir := filepath.Join(repo, "snapshots", id)
	var total, added int64
	var files int64

	err := filepath.WalkDir(target, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(target, path)
		if err != nil {
			return err
		}
		dst := filepath.Join(snapDir, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		files++
		key := fmt.Sprintf("%s|%d|%d", rel, info.Size(), info.ModTime().UnixNano())
		if _, seen := index[key]; !seen {
			added += info.Size()
			index[key] = info.Size()
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return copyFile(path, dst)
	})
	must(err)

	raw, err := json.Marshal(index)
	must(err)
	must(os.WriteFile(indexPath, raw, 0o600))

	meta := snapshotMeta{
		ID: id, ShortID: id[:8], Time: time.Now(), Paths: []string{target},
		Tags: tags, Hostname: "fake",
	}
	metaRaw, err := json.Marshal(meta)
	must(err)
	must(os.WriteFile(filepath.Join(repo, "snapshots", id+".json"), metaRaw, 0o600))

	emit(map[string]any{
		"message_type": "status", "percent_done": 0.5,
		"bytes_done": total / 2, "total_bytes": total, "files_done": files / 2,
	})
	emit(map[string]any{
		"message_type": "summary", "snapshot_id": id,
		"files_new": files, "files_changed": 0, "files_unmodified": 0,
		"data_added": added, "total_bytes_processed": total, "total_files_processed": files,
		"total_duration": 0.42,
	})
}

func listSnapshots(repo string) {
	snapshots := readSnapshots(repo)
	raw, err := json.Marshal(snapshots)
	must(err)
	fmt.Println(string(raw))
}

func readSnapshots(repo string) []snapshotMeta {
	entries, err := os.ReadDir(filepath.Join(repo, "snapshots"))
	if err != nil {
		return []snapshotMeta{}
	}
	out := []snapshotMeta{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(repo, "snapshots", e.Name()))
		if err != nil {
			continue
		}
		var meta snapshotMeta
		if json.Unmarshal(raw, &meta) == nil {
			out = append(out, meta)
		}
	}
	return out
}

func listFiles(repo string, args []string) {
	if len(args) == 0 {
		fail("no snapshot id")
	}
	id := firstNonFlag(args)
	dir := filepath.Join(repo, "snapshots", id)
	if _, err := os.Stat(dir); err != nil {
		fail("snapshot not found")
	}
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		if rel == "." {
			return nil
		}
		kind := "file"
		var size int64
		if d.IsDir() {
			kind = "dir"
		} else if info, err := d.Info(); err == nil {
			size = info.Size()
		}
		emit(map[string]any{
			"struct_type": "node", "name": d.Name(), "type": kind,
			"path": "/" + filepath.ToSlash(rel), "size": size,
		})
		return nil
	})
}

func restore(repo string, args []string) {
	if os.Getenv("FAKERESTIC_FAIL") == "restore" {
		fail("restore failed (simulated)")
	}
	id := firstNonFlag(args)
	var target string
	for i := 0; i < len(args); i++ {
		if args[i] == "--target" && i+1 < len(args) {
			target = args[i+1]
		}
	}
	if target == "" {
		fail("no --target")
	}
	src := filepath.Join(repo, "snapshots", id)
	if _, err := os.Stat(src); err != nil {
		fail("snapshot not found")
	}
	// Real restic recreates the original absolute path below the target; the fake
	// does the same so the controller's "find the world set" logic is exercised.
	dst := filepath.Join(target, "data", "staging", "live", "restored")
	must(os.MkdirAll(dst, 0o755))
	must(copyTree(src, dst))
	emit(map[string]any{
		"message_type": "status", "percent_done": 1.0,
		"bytes_restored": 1024, "total_bytes": 1024, "files_restored": 1,
	})
}

func forget(repo string, args []string) {
	// Only "forget <id>" is meaningful for the tests; policy flags are accepted
	// and ignored.
	id := firstNonFlag(args)
	if id == "" {
		fmt.Println("applied retention policy")
		return
	}
	_ = os.RemoveAll(filepath.Join(repo, "snapshots", id))
	_ = os.Remove(filepath.Join(repo, "snapshots", id+".json"))
	fmt.Println("removed 1 snapshot")
}

func stats(repo string) {
	var total int64
	_ = filepath.WalkDir(filepath.Join(repo, "snapshots"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	emit(map[string]any{
		"total_size": total, "total_file_count": 1, "snapshots_count": len(readSnapshots(repo)),
	})
}

// ------------------------------------------------------------------ helpers --

func emit(payload map[string]any) {
	raw, err := json.Marshal(payload)
	must(err)
	fmt.Println(string(raw))
}

func firstNonFlag(args []string) string {
	skipNext := false
	for _, arg := range args {
		if skipNext {
			skipNext = false
			continue
		}
		if strings.HasPrefix(arg, "--") {
			if arg == "--target" || arg == "--tag" || arg == "--read-data-subset" {
				skipNext = true
			}
			continue
		}
		return arg
	}
	return ""
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return copyFile(path, target)
	})
}

func newID(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

func must(err error) {
	if err != nil {
		fail(err.Error())
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "fakerestic: "+message)
	os.Exit(1)
}
