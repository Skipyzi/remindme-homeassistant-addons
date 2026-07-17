package pairing

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	codeLength   = 6
	maxAttempts  = 5
	codeLifetime = 10 * time.Minute
	alphabet     = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
)

var (
	ErrInvalidCode = errors.New("pairing code is invalid")
	ErrRateLimited = errors.New("pairing attempts exceeded")
)

type persistedState struct {
	CodeHash  string    `json:"codeHash"`
	ExpiresAt time.Time `json:"expiresAt"`
	Attempts  int       `json:"attempts"`
	Consumed  bool      `json:"consumed"`
}

type Store struct {
	mu        sync.Mutex
	tokenPath string
	statePath string
	now       func() time.Time
	random    io.Reader
	token     string
	state     persistedState
}

func ImportLegacyToken(tokenPath, token string) error {
	if token == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(tokenPath), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(tokenPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = file.WriteString(token); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		_ = os.Remove(tokenPath)
		return err
	}
	if closeErr != nil {
		_ = os.Remove(tokenPath)
		return closeErr
	}
	return os.Chmod(tokenPath, 0o600)
}

func NewStore(tokenPath, statePath string, now func() time.Time, random io.Reader) (*Store, error) {
	store := &Store{tokenPath: tokenPath, statePath: statePath, now: now, random: random}
	token, err := os.ReadFile(tokenPath)
	if err == nil && len(token) > 0 {
		store.token = string(token)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	} else {
		raw := make([]byte, 32)
		if _, err := io.ReadFull(random, raw); err != nil {
			return nil, err
		}
		store.token = base64.RawURLEncoding.EncodeToString(raw)
		if err := writeProtected(tokenPath, []byte(store.token)); err != nil {
			return nil, err
		}
	}
	stateData, err := os.ReadFile(statePath)
	if err == nil {
		if err := json.Unmarshal(stateData, &store.state); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return store, nil
}

func (store *Store) Token() string {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.token
}

func (store *Store) Generate() (string, time.Time, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	codeBytes := make([]byte, codeLength)
	for index := range codeBytes {
		value, err := randomIndex(store.random, len(alphabet))
		if err != nil {
			return "", time.Time{}, err
		}
		codeBytes[index] = alphabet[value]
	}
	code := string(codeBytes)
	hash := sha256.Sum256([]byte(code))
	store.state = persistedState{
		CodeHash: hex.EncodeToString(hash[:]), ExpiresAt: store.now().Add(codeLifetime),
	}
	if err := store.saveState(); err != nil {
		return "", time.Time{}, err
	}
	return code, store.state.ExpiresAt, nil
}

func (store *Store) Exchange(code string) (string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.state.Attempts >= maxAttempts {
		return "", ErrRateLimited
	}
	if store.state.Consumed || store.state.CodeHash == "" || !store.now().Before(store.state.ExpiresAt) {
		return "", ErrInvalidCode
	}
	expected, err := hex.DecodeString(store.state.CodeHash)
	if err != nil {
		return "", ErrInvalidCode
	}
	actual := sha256.Sum256([]byte(code))
	if subtle.ConstantTimeCompare(expected, actual[:]) != 1 {
		store.state.Attempts++
		if store.state.Attempts >= maxAttempts {
			store.state.Consumed = true
			if err := store.saveState(); err != nil {
				return "", err
			}
			return "", ErrRateLimited
		}
		if err := store.saveState(); err != nil {
			return "", err
		}
		return "", ErrInvalidCode
	}
	store.state.Consumed = true
	if err := store.saveState(); err != nil {
		return "", err
	}
	return store.token, nil
}

func (store *Store) saveState() error {
	data, err := json.Marshal(store.state)
	if err != nil {
		return err
	}
	return writeProtected(store.statePath, data)
}

func writeProtected(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + ".tmp"
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
	return os.Rename(temporary, path)
}

func randomIndex(random io.Reader, size int) (int, error) {
	limit := 256 - (256 % size)
	buffer := []byte{0}
	for {
		if _, err := io.ReadFull(random, buffer); err != nil {
			return 0, err
		}
		if int(buffer[0]) < limit {
			return int(buffer[0]) % size, nil
		}
	}
}
