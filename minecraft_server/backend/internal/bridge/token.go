package bridge

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"bytes"
)

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func trimSpace(b []byte) []byte { return bytes.TrimSpace(b) }
