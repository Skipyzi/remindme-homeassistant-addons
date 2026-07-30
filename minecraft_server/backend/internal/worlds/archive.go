package worlds

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/atomicfs"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/events"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/store"
	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/supervisor"
)

// Import limits. A Minecraft world is many small files, so the file count matters
// as much as the byte count; both bound how much damage a hostile archive can do.
const (
	maxImportEntries    = 400_000
	maxImportBytes      = int64(64) << 30 // 64 GiB uncompressed
	maxImportRatio      = 200             // uncompressed/compressed guard against zip bombs
	maxImportPathLength = 512
	maxImportDepth      = 24
)

var (
	ErrUnsafeArchive = errors.New("archive rejected as unsafe")
	ErrNoWorldData   = errors.New("archive does not contain a Minecraft world (no level.dat found)")
)

// ImportResult describes what was imported.
type ImportResult struct {
	WorldID    string   `json:"world_id"`
	Dimensions []string `json:"dimensions"`
	Files      int      `json:"files"`
	Bytes      int64    `json:"bytes"`
	Warnings   []string `json:"warnings"`
}

// ImportZip extracts an uploaded archive into a new world.
//
// Everything is extracted into a staging directory first and only moved into
// place once the layout has been validated, so a rejected archive cannot leave a
// partially imported world behind.
func (m *Manager) ImportZip(src string, name, actor string) (ImportResult, error) {
	result := ImportResult{}
	id := normalizeID(name)
	dst, err := m.dir(id)
	if err != nil {
		return result, err
	}
	if _, err := os.Stat(dst); err == nil {
		return result, fmt.Errorf("%w: %s", ErrExists, id)
	}

	reader, err := zip.OpenReader(src)
	if err != nil {
		return result, fmt.Errorf("not a readable ZIP archive: %w", err)
	}
	defer reader.Close()

	if len(reader.File) > maxImportEntries {
		return result, fmt.Errorf("%w: %d entries exceeds the limit of %d",
			ErrUnsafeArchive, len(reader.File), maxImportEntries)
	}

	staging := filepath.Join(m.deps.Paths.Staging(), fmt.Sprintf("import-%s-%d", id, time.Now().UnixNano()))
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return result, err
	}
	defer os.RemoveAll(staging)

	journalID, _ := m.deps.Store.JournalBegin(store.OpWorldImport, "extract", map[string]any{
		"world": id, "staging": staging, "actor": actor,
	})

	var total int64
	for _, entry := range reader.File {
		clean, err := safeArchivePath(entry.Name)
		if err != nil {
			_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
			return result, err
		}
		if clean == "" {
			continue
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(filepath.Join(staging, clean), 0o755); err != nil {
				_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
				return result, err
			}
			continue
		}
		mode := entry.Mode()
		if mode&fs.ModeSymlink != 0 {
			err := fmt.Errorf("%w: %s is a symbolic link", ErrUnsafeArchive, entry.Name)
			_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
			return result, err
		}
		if !mode.IsRegular() {
			err := fmt.Errorf("%w: %s is not a regular file", ErrUnsafeArchive, entry.Name)
			_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
			return result, err
		}
		// Reject entries that claim to expand far beyond their compressed size.
		if entry.CompressedSize64 > 1024 && entry.UncompressedSize64/entry.CompressedSize64 > maxImportRatio {
			err := fmt.Errorf("%w: %s has an implausible compression ratio", ErrUnsafeArchive, entry.Name)
			_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
			return result, err
		}
		written, err := extractFile(entry, filepath.Join(staging, clean), maxImportBytes-total)
		if err != nil {
			_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
			return result, err
		}
		total += written
		result.Files++
		if total > maxImportBytes {
			err := fmt.Errorf("%w: uncompressed size exceeds %d bytes", ErrUnsafeArchive, maxImportBytes)
			_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
			return result, err
		}
	}
	result.Bytes = total

	// Nothing extracted may be a link even if the archive claimed otherwise.
	if err := atomicfs.NoSymlinks(staging); err != nil {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return result, fmt.Errorf("%w: %v", ErrUnsafeArchive, err)
	}

	normalized := filepath.Join(staging, ".normalized")
	dims, warnings, err := normalizeLayout(staging, normalized)
	if err != nil {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return result, err
	}
	result.Dimensions = dims
	result.Warnings = warnings

	_ = m.deps.Store.JournalPhase(journalID, "install", map[string]any{"target": dst})
	if err := atomicfs.MoveDir(normalized, dst); err != nil {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return result, err
	}

	meta := Meta{
		ID: id, Name: name, Source: "imported", CreatedAt: time.Now().UTC(),
		GenerationStatus: "partial",
		Notes:            fmt.Sprintf("Imported from %s", filepath.Base(src)),
	}
	if err := m.writeMeta(meta); err != nil {
		_ = m.deps.Store.JournalEnd(journalID, store.JournalFailed, err.Error())
		return result, err
	}
	_ = m.deps.Store.JournalEnd(journalID, store.JournalDone, "")

	result.WorldID = id
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "world.import", Target: id,
		Detail: fmt.Sprintf("files=%d bytes=%d dimensions=%s", result.Files, result.Bytes, strings.Join(dims, ","))})
	m.deps.Bus.Publish(events.TypeWorldsChanged, map[string]any{"imported": id})
	m.invalidate(id)
	return result, nil
}

// safeArchivePath validates one archive entry name and returns a clean relative
// path. This is the ZIP-slip defence: absolute paths, drive letters, traversal
// segments, overlong names and deep nesting are all refused rather than sanitized,
// because a world archive never legitimately contains them.
func safeArchivePath(name string) (string, error) {
	if name == "" {
		return "", nil
	}
	if strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("%w: entry name contains a NUL byte", ErrUnsafeArchive)
	}
	if len(name) > maxImportPathLength {
		return "", fmt.Errorf("%w: entry name is too long", ErrUnsafeArchive)
	}
	unified := strings.ReplaceAll(name, "\\", "/")
	if strings.HasPrefix(unified, "/") {
		return "", fmt.Errorf("%w: %s is an absolute path", ErrUnsafeArchive, name)
	}
	if len(unified) > 1 && unified[1] == ':' {
		return "", fmt.Errorf("%w: %s contains a drive letter", ErrUnsafeArchive, name)
	}
	cleaned := path.Clean(unified)
	if cleaned == "." || cleaned == "/" {
		return "", nil
	}
	segments := strings.Split(cleaned, "/")
	if len(segments) > maxImportDepth {
		return "", fmt.Errorf("%w: %s is nested too deeply", ErrUnsafeArchive, name)
	}
	for _, seg := range segments {
		if seg == ".." {
			return "", fmt.Errorf("%w: %s escapes the archive root", ErrUnsafeArchive, name)
		}
		if seg == "" {
			return "", fmt.Errorf("%w: %s has an empty path segment", ErrUnsafeArchive, name)
		}
	}
	return filepath.FromSlash(cleaned), nil
}

func extractFile(entry *zip.File, dst string, remaining int64) (int64, error) {
	if remaining <= 0 {
		return 0, fmt.Errorf("%w: archive is larger than the import limit", ErrUnsafeArchive)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return 0, err
	}
	rc, err := entry.Open()
	if err != nil {
		return 0, err
	}
	defer rc.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, err
	}
	defer out.Close()

	// LimitReader enforces the budget even when the archive lies about sizes in
	// its central directory.
	written, err := io.Copy(out, io.LimitReader(rc, remaining+1))
	if err != nil {
		return written, err
	}
	if written > remaining {
		return written, fmt.Errorf("%w: archive is larger than the import limit", ErrUnsafeArchive)
	}
	return written, nil
}

// normalizeLayout finds the world data in an extracted archive and arranges it as
// world / world_nether / world_the_end. Archives come in several shapes: a single
// world folder, a server directory containing all three, or the contents of a
// world folder at the top level.
func normalizeLayout(root, target string) ([]string, []string, error) {
	if err := os.MkdirAll(target, 0o755); err != nil {
		return nil, nil, err
	}
	var warnings []string

	levelDirs, err := findLevelDirs(root, target)
	if err != nil {
		return nil, nil, err
	}
	if len(levelDirs) == 0 {
		return nil, nil, ErrNoWorldData
	}

	assigned := map[string]string{}
	for _, dir := range levelDirs {
		base := strings.ToLower(filepath.Base(dir))
		switch {
		case strings.Contains(base, "nether") || hasDimensionDir(dir, "DIM-1"):
			if _, taken := assigned["world_nether"]; !taken {
				assigned["world_nether"] = dir
				continue
			}
		case strings.Contains(base, "the_end"), strings.Contains(base, "end"), hasDimensionDir(dir, "DIM1"):
			if _, taken := assigned["world_the_end"]; !taken {
				assigned["world_the_end"] = dir
				continue
			}
		}
		if _, taken := assigned["world"]; !taken {
			assigned["world"] = dir
			continue
		}
		warnings = append(warnings, fmt.Sprintf("ignored extra world directory %q", filepath.Base(dir)))
	}
	if _, ok := assigned["world"]; !ok {
		// Only the Nether or the End were found; treat the first as the Overworld
		// so the user still gets their data, and say so.
		for key, dir := range assigned {
			assigned["world"] = dir
			delete(assigned, key)
			warnings = append(warnings, "no Overworld found; imported "+key+" as the Overworld")
			break
		}
	}

	dims := make([]string, 0, len(assigned))
	for _, dim := range Dimensions {
		src, ok := assigned[dim]
		if !ok {
			continue
		}
		if err := atomicfs.MoveDir(src, filepath.Join(target, dim)); err != nil {
			return nil, warnings, err
		}
		dims = append(dims, dim)
	}
	if len(dims) < len(Dimensions) {
		warnings = append(warnings,
			"the archive did not contain every dimension; Minecraft will generate the missing ones")
	}
	return dims, warnings, nil
}

func findLevelDirs(root, skip string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			if p == skip {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if name == "level.dat" || name == "level.dat_old" {
			dir := filepath.Dir(p)
			for _, existing := range out {
				if existing == dir {
					return nil
				}
			}
			out = append(out, dir)
		}
		return nil
	})
	return out, err
}

func hasDimensionDir(dir, name string) bool {
	st, err := os.Stat(filepath.Join(dir, name))
	return err == nil && st.IsDir()
}

// ExportZip streams a world set as a ZIP archive.
//
// Exporting the active world while Minecraft is running is allowed but flagged:
// region files may be written during the copy, so the export is a "crash
// consistent" snapshot, not a clean one. Backups exist for the clean case.
func (m *Manager) ExportZip(id string, w io.Writer, actor string) error {
	dir, err := m.dir(id)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if m.isActive(id) && m.deps.Supervisor.State() == supervisor.StateRunning {
		m.deps.Bus.Warn("worlds",
			"exporting the active world while the server runs produces a crash-consistent copy; stop the server or use a backup for a clean copy")
	}

	zw := zip.NewWriter(w)
	defer zw.Close()

	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		name := filepath.ToSlash(rel)
		if d.IsDir() {
			_, err := zw.Create(name + "/")
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = name
		header.Method = zip.Deflate
		writer, err := zw.CreateHeader(header)
		if err != nil {
			return err
		}
		file, err := os.Open(p)
		if err != nil {
			// A region file that Minecraft removed mid-export is not fatal.
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		defer file.Close()
		_, err = io.Copy(writer, file)
		return err
	})
	if err != nil {
		return err
	}
	_ = m.deps.Store.Audit(store.AuditEntry{Actor: actor, Action: "world.export", Target: id})
	return zw.Close()
}
