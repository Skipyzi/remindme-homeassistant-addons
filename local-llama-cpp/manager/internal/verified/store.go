package verified

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"remindme.local/model-manager/internal/catalog"
)

const currentVersion = 1

type record struct {
	ID            string `json:"id"`
	Repo          string `json:"repo"`
	File          string `json:"file"`
	ExpectedBytes int64  `json:"expectedBytes"`
	SHA256        string `json:"sha256,omitempty"`
	Path          string `json:"path"`
}

type document struct {
	Version int               `json:"version"`
	Models  map[string]record `json:"models"`
}

type Store struct {
	Path     string
	ModelDir string
	mu       sync.Mutex
}

func (store *Store) Record(variant catalog.Variant, path string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	clean, err := store.safePath(path)
	if err != nil {
		return err
	}
	if filepath.Base(clean) != variant.File {
		return errors.New("verified model filename does not match catalog")
	}
	info, err := os.Stat(clean)
	if err != nil {
		return err
	}
	if variant.ExpectedBytes > 0 && info.Size() != variant.ExpectedBytes {
		return errors.New("verified model size does not match catalog")
	}
	current, err := store.load()
	if err != nil {
		return err
	}
	current.Models[variant.ID] = record{
		ID: variant.ID, Repo: variant.Repo, File: variant.File,
		ExpectedBytes: variant.ExpectedBytes, SHA256: variant.SHA256, Path: clean,
	}
	return store.save(current)
}

func (store *Store) Has(variant catalog.Variant) bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	current, err := store.load()
	if err != nil {
		return false
	}
	entry, ok := current.Models[variant.ID]
	if !ok || entry.Repo != variant.Repo || entry.File != variant.File || entry.ExpectedBytes != variant.ExpectedBytes || entry.SHA256 != variant.SHA256 {
		return false
	}
	clean, err := store.safePath(entry.Path)
	if err != nil || filepath.Base(clean) != variant.File {
		return false
	}
	info, err := os.Stat(clean)
	return err == nil && (variant.ExpectedBytes <= 0 || info.Size() == variant.ExpectedBytes)
}

func (store *Store) Remove(id string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	current, err := store.load()
	if err != nil {
		return err
	}
	delete(current.Models, id)
	return store.save(current)
}

func (store *Store) safePath(path string) (string, error) {
	modelDir, err := filepath.Abs(store.ModelDir)
	if err != nil {
		return "", err
	}
	clean, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(modelDir, clean)
	if err != nil || relative == ".." || filepath.IsAbs(relative) || len(relative) >= 3 && relative[:3] == ".."+string(filepath.Separator) {
		return "", errors.New("verified model path is outside model directory")
	}
	return clean, nil
}

func (store *Store) load() (document, error) {
	result := document{Version: currentVersion, Models: map[string]record{}}
	data, err := os.ReadFile(store.Path)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return document{}, fmt.Errorf("decode verified models: %w", err)
	}
	if result.Version != currentVersion || result.Models == nil {
		return document{}, errors.New("unsupported verified model state")
	}
	return result, nil
}

func (store *Store) save(value document) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(store.Path), 0o700); err != nil {
		return err
	}
	temporary := store.Path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return closeErr
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, store.Path)
}
