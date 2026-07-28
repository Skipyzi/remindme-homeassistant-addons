// Package inventory discovers physical GGUF files within fixed add-on data roots.
package inventory

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Source string

const (
	SourceManaged     Source = "managed"
	SourceLegacyCache Source = "legacy_cache"
	DefaultMaxDepth          = 8
	DefaultMaxEntries        = 10_000
)

type Root struct {
	Path   string
	Source Source
}

type Item struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	Modified  time.Time `json:"modified"`
	Source    Source    `json:"source"`
	ValidGGUF bool      `json:"validGguf"`
	Path      string    `json:"-"`
}

type Warning struct {
	Source  Source `json:"source"`
	Message string `json:"message"`
}

type Result struct {
	Items    []Item    `json:"items"`
	Warnings []Warning `json:"warnings,omitempty"`
}

type Scanner struct {
	Roots      []Root
	MaxDepth   int
	MaxEntries int
}

var (
	ErrNotFound        = errors.New("inventory item not found")
	ErrScanUnavailable = errors.New("model storage inventory is unavailable")
	errEntryLimit      = errors.New("model storage inventory entry limit exceeded")
)

func (scanner Scanner) Scan() (Result, error) {
	maxDepth := scanner.MaxDepth
	if maxDepth <= 0 {
		maxDepth = DefaultMaxDepth
	}
	maxEntries := scanner.MaxEntries
	if maxEntries <= 0 {
		maxEntries = DefaultMaxEntries
	}

	result := Result{Items: make([]Item, 0)}
	inspectedRoots := 0
	for _, root := range scanner.Roots {
		itemStart := len(result.Items)
		canonical, err := filepath.EvalSymlinks(root.Path)
		if err != nil {
			result.Warnings = append(result.Warnings, rootWarning(root.Source))
			continue
		}
		canonical, err = filepath.Abs(canonical)
		if err != nil {
			result.Warnings = append(result.Warnings, rootWarning(root.Source))
			continue
		}
		info, err := os.Stat(canonical)
		if err != nil || !info.IsDir() {
			result.Warnings = append(result.Warnings, rootWarning(root.Source))
			continue
		}

		entries := 0
		err = filepath.WalkDir(canonical, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, err := filepath.Rel(canonical, path)
			if err != nil {
				return err
			}
			if relative == "." {
				return nil
			}
			entries++
			if entries > maxEntries {
				return errEntryLimit
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			depth := len(strings.Split(filepath.Clean(relative), string(filepath.Separator)))
			if depth > maxDepth {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".gguf") {
				return nil
			}
			fileInfo, err := entry.Info()
			if err != nil {
				return err
			}
			if !fileInfo.Mode().IsRegular() {
				return nil
			}
			result.Items = append(result.Items, Item{
				ID:        opaqueID(root.Source, relative),
				Name:      entry.Name(),
				Size:      fileInfo.Size(),
				Modified:  fileInfo.ModTime().UTC(),
				Source:    root.Source,
				ValidGGUF: validGGUF(path),
				Path:      path,
			})
			return nil
		})
		if err != nil {
			result.Items = result.Items[:itemStart]
			result.Warnings = append(result.Warnings, rootWarning(root.Source))
			continue
		}
		inspectedRoots++
	}
	if inspectedRoots == 0 {
		return Result{}, ErrScanUnavailable
	}
	sort.Slice(result.Items, func(left, right int) bool {
		if result.Items[left].Source != result.Items[right].Source {
			return result.Items[left].Source < result.Items[right].Source
		}
		leftName := strings.ToLower(result.Items[left].Name)
		rightName := strings.ToLower(result.Items[right].Name)
		if leftName != rightName {
			return leftName < rightName
		}
		return result.Items[left].ID < result.Items[right].ID
	})
	return result, nil
}

func (scanner Scanner) Resolve(id string) (Item, error) {
	result, err := scanner.Scan()
	if err != nil {
		return Item{}, err
	}
	for _, item := range result.Items {
		if item.ID != id {
			continue
		}
		if err := scanner.validateItem(item); err != nil {
			return Item{}, err
		}
		return item, nil
	}
	return Item{}, ErrNotFound
}

func (scanner Scanner) validateItem(item Item) error {
	for _, root := range scanner.Roots {
		if root.Source != item.Source {
			continue
		}
		canonicalRoot, err := filepath.EvalSymlinks(root.Path)
		if err != nil {
			continue
		}
		canonicalRoot, err = filepath.Abs(canonicalRoot)
		if err != nil {
			continue
		}
		absoluteItem, err := filepath.Abs(item.Path)
		if err != nil {
			continue
		}
		relative, err := filepath.Rel(canonicalRoot, absoluteItem)
		if err != nil || relative == ".." || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			continue
		}
		current := canonicalRoot
		valid := true
		for _, part := range strings.Split(relative, string(filepath.Separator)) {
			current = filepath.Join(current, part)
			info, err := os.Lstat(current)
			if err != nil || info.Mode()&os.ModeSymlink != 0 {
				valid = false
				break
			}
		}
		if !valid {
			return ErrNotFound
		}
		info, err := os.Lstat(absoluteItem)
		if err != nil || !info.Mode().IsRegular() {
			return ErrNotFound
		}
		return nil
	}
	return ErrNotFound
}

func opaqueID(source Source, relative string) string {
	sum := sha256.Sum256([]byte(string(source) + "\x00" + filepath.ToSlash(relative)))
	return hex.EncodeToString(sum[:16])
}

func validGGUF(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	var header [4]byte
	_, err = io.ReadFull(file, header[:])
	return err == nil && string(header[:]) == "GGUF"
}

func rootWarning(source Source) Warning {
	label := "Model storage"
	if source == SourceLegacyCache {
		label = "Legacy model cache"
	} else if source == SourceManaged {
		label = "Managed model storage"
	}
	return Warning{Source: source, Message: fmt.Sprintf("%s could not be scanned.", label)}
}
