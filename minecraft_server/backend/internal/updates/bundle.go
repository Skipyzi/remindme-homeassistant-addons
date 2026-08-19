package updates

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/skipyzi/remindme-homeassistant-addons/minecraft_server/backend/internal/appcfg"
)

// A server bundle is a zip with the launcher JAR at its root plus the
// directories it owns. Installing one differs from swapping a single JAR: the
// bundle's own trees are replaced wholesale, while everything the user owns in
// the runtime directory - server.properties, the world link, logs, extra mods -
// is never touched.
//
// bundleOwned are the paths the bundle may replace. mods/ is deliberately
// merged instead of replaced: the bundle ships its base mods (halplibe), and
// deleting the directory would take the user's own mods with it.
var bundleOwned = []string{"libraries", ".fabric"}

const (
	maxBundleBytes      = 400 << 20
	maxBundleFileBytes  = 200 << 20
	maxBundleEntryCount = 20000
)

// installBundle unpacks a verified bundle zip into the runtime directory.
//
// Guards mirror the world importer: every entry path is confined below the
// runtime directory, symlink entries are rejected, and the total decompressed
// size is capped, so a hostile zip cannot write outside the add-on's data or
// fill the disk.
func installBundle(data []byte, runtimeDir, launcherName string) error {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("the bundle is not a readable zip: %w", err)
	}
	if len(reader.File) > maxBundleEntryCount {
		return fmt.Errorf("the bundle has %d entries, refusing more than %d", len(reader.File), maxBundleEntryCount)
	}

	launcherSeen := false
	var total int64
	for _, entry := range reader.File {
		if entry.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("the bundle contains a symlink (%s), refusing it", entry.Name)
		}
		if _, err := appcfg.Confine(runtimeDir, entry.Name); err != nil {
			return fmt.Errorf("the bundle tries to write outside the server directory (%s)", entry.Name)
		}
		total += int64(entry.UncompressedSize64)
		if total > maxBundleBytes {
			return fmt.Errorf("the bundle decompresses past the %d MB limit", maxBundleBytes>>20)
		}
		if filepath.ToSlash(entry.Name) == launcherName {
			launcherSeen = true
		}
	}
	if !launcherSeen {
		return fmt.Errorf("the bundle has no %s at its root; this does not look like a server bundle", launcherName)
	}

	// The bundle-owned trees are replaced, not merged: leftover libraries from a
	// previous version are exactly the kind of drift that produces unexplainable
	// class errors.
	for _, owned := range bundleOwned {
		if err := os.RemoveAll(filepath.Join(runtimeDir, owned)); err != nil {
			return err
		}
	}

	for _, entry := range reader.File {
		target, err := appcfg.Confine(runtimeDir, entry.Name)
		if err != nil {
			return err
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if entry.UncompressedSize64 > maxBundleFileBytes {
			return fmt.Errorf("%s decompresses past the per-file limit", entry.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		src, err := entry.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			src.Close()
			return err
		}
		_, err = io.Copy(out, io.LimitReader(src, maxBundleFileBytes+1))
		src.Close()
		if closeErr := out.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// bundlePaths lists what a bundle wrote at its top level, for the audit log.
func bundleSummary(data []byte) string {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	tops := map[string]bool{}
	for _, entry := range reader.File {
		name := filepath.ToSlash(entry.Name)
		if i := strings.IndexByte(name, '/'); i > 0 {
			name = name[:i] + "/"
		}
		tops[name] = true
	}
	out := make([]string, 0, len(tops))
	for name := range tops {
		out = append(out, name)
	}
	sort.Strings(out)
	return fmt.Sprintf("%d entries: %s", len(reader.File), strings.Join(out, " "))
}
