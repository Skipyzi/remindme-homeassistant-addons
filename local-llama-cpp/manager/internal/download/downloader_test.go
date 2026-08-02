package download

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"remindme.local/model-manager/internal/catalog"
)

func checksum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestInspectReadsHuggingFaceLinkedSize(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodHead {
			t.Fatalf("method=%s", request.Method)
		}
		response.Header().Set("X-Linked-Size", "123456")
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client(), ModelDir: t.TempDir(), ResolveBase: server.URL, MaxBytes: 1_000_000}
	metadata, err := downloader.Inspect(context.Background(), catalog.Variant{Repo: "owner/repo", File: "model.gguf"}, "")
	if err != nil || metadata.Bytes != 123456 {
		t.Fatalf("metadata=%#v err=%v", metadata, err)
	}
}

func TestDownloadResumesPartialFile(t *testing.T) {
	full := []byte("GGUF0000tail")
	var rangeHeader string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		rangeHeader = request.Header.Get("Range")
		response.Header().Set("Content-Length", "4")
		response.WriteHeader(http.StatusPartialContent)
		_, _ = response.Write(full[8:])
	}))
	defer server.Close()

	dir := t.TempDir()
	partial := filepath.Join(dir, "model.gguf.partial")
	if err := os.WriteFile(partial, full[:8], 0o600); err != nil {
		t.Fatal(err)
	}
	downloader := Downloader{Client: server.Client(), ModelDir: dir, ResolveBase: server.URL, MaxBytes: 1024}
	result, err := downloader.Download(context.Background(), catalog.Variant{
		Repo: "owner/repo", File: "model.gguf", ExpectedBytes: int64(len(full)), SHA256: checksum(full),
	}, "hf_test_secret", func(Progress) {})
	if err != nil {
		t.Fatal(err)
	}
	if rangeHeader != "bytes=8-" {
		t.Fatalf("range=%q", rangeHeader)
	}
	if result.Bytes != int64(len(full)) {
		t.Fatalf("bytes=%d", result.Bytes)
	}
	contents, err := os.ReadFile(result.Path)
	if err != nil || string(contents) != string(full) {
		t.Fatalf("contents=%q err=%v", contents, err)
	}
}

func TestServerIgnoringRangeRestartsDownload(t *testing.T) {
	full := []byte("GGUFfresh")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Length", "9")
		_, _ = response.Write(full)
	}))
	defer server.Close()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "model.gguf.partial"), []byte("GGUFold"), 0o600); err != nil {
		t.Fatal(err)
	}
	downloader := Downloader{Client: server.Client(), ModelDir: dir, ResolveBase: server.URL, MaxBytes: 1024}
	result, err := downloader.Download(context.Background(), catalog.Variant{Repo: "owner/repo", File: "model.gguf", ExpectedBytes: 9, SHA256: checksum(full)}, "", func(Progress) {})
	if err != nil {
		t.Fatal(err)
	}
	contents, _ := os.ReadFile(result.Path)
	if string(contents) != string(full) {
		t.Fatalf("contents=%q", contents)
	}
}

func TestDownloadRejectsInvalidGGUFAndChecksum(t *testing.T) {
	for name, testCase := range map[string]struct {
		body []byte
		sum  string
		code string
	}{
		"header":   {body: []byte("NOPEdata"), sum: checksum([]byte("NOPEdata")), code: CodeInvalidGGUF},
		"checksum": {body: []byte("GGUFdata"), sum: strings.Repeat("a", 64), code: CodeChecksumMismatch},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) { _, _ = response.Write(testCase.body) }))
			defer server.Close()
			dir := t.TempDir()
			downloader := Downloader{Client: server.Client(), ModelDir: dir, ResolveBase: server.URL, MaxBytes: 1024}
			_, err := downloader.Download(context.Background(), catalog.Variant{Repo: "owner/repo", File: "model.gguf", ExpectedBytes: int64(len(testCase.body)), SHA256: testCase.sum}, "", func(Progress) {})
			var safeErr *Error
			if !AsError(err, &safeErr) || safeErr.Code != testCase.code {
				t.Fatalf("err=%#v", err)
			}
			if _, statErr := os.Stat(filepath.Join(dir, "model.gguf")); !os.IsNotExist(statErr) {
				t.Fatal("invalid file was finalized")
			}
		})
	}
}

func TestAuthenticationErrorNeverContainsToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Error(response, request.Header.Get("Authorization"), http.StatusUnauthorized)
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client(), ModelDir: t.TempDir(), ResolveBase: server.URL, MaxBytes: 1024}
	_, err := downloader.Download(context.Background(), catalog.Variant{Repo: "owner/repo", File: "model.gguf", ExpectedBytes: 8}, "hf_test_secret", func(Progress) {})
	if err == nil || strings.Contains(err.Error(), "hf_test_secret") || strings.Contains(err.Error(), "Bearer") {
		t.Fatalf("unsafe error: %v", err)
	}
}

func TestDownloadRejectsRedirectOutsideHuggingFace(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, "https://evil.example/model.gguf", http.StatusFound)
	}))
	defer server.Close()
	downloader := Downloader{Client: server.Client(), ModelDir: t.TempDir(), ResolveBase: server.URL, MaxBytes: 1024}
	_, err := downloader.Download(context.Background(), catalog.Variant{Repo: "owner/repo", File: "model.gguf", ExpectedBytes: 8}, "", func(Progress) {})
	var safeErr *Error
	if !AsError(err, &safeErr) || safeErr.Code != CodeUnsafeRedirect {
		t.Fatalf("unsafe redirect was not preserved: %v", err)
	}
}

func TestTrustedHuggingFaceHostUsesDomainBoundaries(t *testing.T) {
	for host, want := range map[string]bool{
		"huggingface.co":              true,
		"cdn-lfs.huggingface.co":      true,
		"hf.co":                       true,
		"us.aws.cdn.hf.co":            true,
		"cdn-lfs-us-1.hf.co":          true,
		"cas-server.xethub.hf.co":     true,
		"transfer.xethub-eu.hf.co":    true,
		"hf.co.attacker.example":      false,
		"not-hf.co":                   false,
		"xethub.hf.co.attacker.test":  false,
		"huggingface.co.evil.example": false,
		"":                            false,
	} {
		t.Run(host, func(t *testing.T) {
			if got := trustedHuggingFaceHost(host); got != want {
				t.Fatalf("trustedHuggingFaceHost(%q)=%v want %v", host, got, want)
			}
		})
	}
}

func TestRedirectPolicyRequiresHTTPSAndStripsAuthorizationFromCDN(t *testing.T) {
	client := (Downloader{}).httpClient()
	origin, err := http.NewRequest(http.MethodGet, "https://huggingface.co/owner/repo/resolve/main/model.gguf", nil)
	if err != nil {
		t.Fatal(err)
	}
	origin.Header.Set("Authorization", "Bearer hf_test_secret")

	cdn, err := http.NewRequest(http.MethodGet, "https://us.aws.cdn.hf.co/model.gguf", nil)
	if err != nil {
		t.Fatal(err)
	}
	cdn.Header = origin.Header.Clone()
	if err := client.CheckRedirect(cdn, []*http.Request{origin}); err != nil {
		t.Fatalf("official CDN redirect rejected: %v", err)
	}
	if got := cdn.Header.Get("Authorization"); got != "" {
		t.Fatalf("authorization forwarded to CDN: %q", got)
	}

	for _, rawURL := range []string{
		"http://us.aws.cdn.hf.co/model.gguf",
		"https://hf.co.attacker.example/model.gguf",
	} {
		request, requestErr := http.NewRequest(http.MethodGet, rawURL, nil)
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		if redirectErr := client.CheckRedirect(request, []*http.Request{origin}); redirectErr == nil {
			t.Fatalf("unsafe redirect accepted: %s", rawURL)
		}
	}
}

func TestCancelledDownloadRemainsResumable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write([]byte("GGUF"))
		if flusher, ok := response.(http.Flusher); ok {
			flusher.Flush()
		}
		<-request.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	dir := t.TempDir()
	downloader := Downloader{Client: server.Client(), ModelDir: dir, ResolveBase: server.URL, MaxBytes: 1024}
	result := make(chan error, 1)
	progressed := make(chan struct{}, 1)
	go func() {
		_, err := downloader.Download(ctx, catalog.Variant{Repo: "owner/repo", File: "model.gguf", ExpectedBytes: 8}, "", func(Progress) {
			select {
			case progressed <- struct{}{}:
			default:
			}
		})
		result <- err
	}()
	<-progressed
	cancel()
	err := <-result
	var safeErr *Error
	if !AsError(err, &safeErr) || safeErr.Code != CodeDownloadInterrupted || !safeErr.Retryable {
		t.Fatalf("unexpected cancellation: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "model.gguf.partial")); statErr != nil {
		t.Fatalf("partial file missing: %v", statErr)
	}
}
