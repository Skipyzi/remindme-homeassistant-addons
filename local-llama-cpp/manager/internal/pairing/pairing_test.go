package pairing

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestStoreCreatesProtectedTokenAndSingleUseCode(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	directory := t.TempDir()
	store, err := NewStore(
		filepath.Join(directory, "manager-token"),
		filepath.Join(directory, "pairing.json"),
		func() time.Time { return now },
		bytes.NewReader(bytes.Repeat([]byte{7, 19, 31, 43, 59, 71, 83, 97}, 16)),
	)
	if err != nil {
		t.Fatal(err)
	}
	if store.Token() == "" {
		t.Fatal("manager token is empty")
	}
	info, err := os.Stat(filepath.Join(directory, "manager-token"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("token mode=%o", info.Mode().Perm())
	}
	code, expiresAt, err := store.Generate()
	if err != nil {
		t.Fatal(err)
	}
	if len(code) != 6 {
		t.Fatalf("code=%q", code)
	}
	for _, ambiguous := range []string{"0", "O", "1", "I"} {
		if bytes.Contains([]byte(code), []byte(ambiguous)) {
			t.Fatalf("code contains ambiguous character %q: %s", ambiguous, code)
		}
	}
	if !expiresAt.Equal(now.Add(10 * time.Minute)) {
		t.Fatalf("expiresAt=%s", expiresAt)
	}
	token, err := store.Exchange(code)
	if err != nil {
		t.Fatal(err)
	}
	if token != store.Token() {
		t.Fatal("exchange returned a different token")
	}
	if _, err := store.Exchange(code); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("second exchange error=%v", err)
	}
}

func TestCodeExpirySupersessionAndAttemptLimit(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	store, err := NewStore(
		filepath.Join(t.TempDir(), "token"),
		filepath.Join(t.TempDir(), "pairing.json"),
		func() time.Time { return now },
		bytes.NewReader(bytes.Repeat([]byte{2, 3, 4, 5, 6, 7, 8, 9}, 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	first, _, _ := store.Generate()
	_, _, _ = store.Generate()
	if _, err := store.Exchange(first); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("superseded error=%v", err)
	}
	second, _, _ := store.Generate()
	for attempt := 1; attempt <= 4; attempt++ {
		if _, err := store.Exchange("ZZZZZZ"); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("attempt %d error=%v", attempt, err)
		}
	}
	if _, err := store.Exchange("ZZZZZZ"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("fifth error=%v", err)
	}
	if _, err := store.Exchange(second); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("post-limit error=%v", err)
	}

	expiring, _, _ := store.Generate()
	now = now.Add(11 * time.Minute)
	if _, err := store.Exchange(expiring); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("expired error=%v", err)
	}
}

func TestImportLegacyTokenDoesNotOverwriteManagerOwnedToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := ImportLegacyToken(path, "legacy-token"); err != nil {
		t.Fatal(err)
	}
	if err := ImportLegacyToken(path, "replacement"); err != nil {
		t.Fatal(err)
	}
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(value) != "legacy-token" {
		t.Fatalf("token=%q", value)
	}
}

func TestStoreReloadsTokenWithoutChangingIt(t *testing.T) {
	directory := t.TempDir()
	tokenPath := filepath.Join(directory, "token")
	statePath := filepath.Join(directory, "pairing.json")
	first, err := NewStore(tokenPath, statePath, time.Now, bytes.NewReader(bytes.Repeat([]byte{11}, 64)))
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewStore(tokenPath, statePath, time.Now, bytes.NewReader(bytes.Repeat([]byte{22}, 64)))
	if err != nil {
		t.Fatal(err)
	}
	if first.Token() != second.Token() {
		t.Fatal("existing token changed")
	}
}
