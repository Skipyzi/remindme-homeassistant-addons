package download

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"remindme.local/model-manager/internal/catalog"
)

type resolverFile struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	LFS  *struct {
		Size int64 `json:"size"`
	} `json:"lfs,omitempty"`
}

func newResolverServer(t *testing.T, files []resolverFile) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	requests := &atomic.Int64{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		switch {
		case request.Method == http.MethodGet && strings.Contains(request.URL.Path, "/api/models/"):
			response.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(response).Encode(files); err != nil {
				t.Errorf("encode repository files: %v", err)
			}
		case request.Method == http.MethodHead && strings.Contains(request.URL.Path, "/resolve/main/"):
			name := request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:]
			for _, file := range files {
				if file.Path == name {
					size := file.Size
					if file.LFS != nil {
						size = file.LFS.Size
					}
					response.Header().Set("X-Linked-Size", stringInt(size))
					return
				}
			}
			http.NotFound(response, request)
		default:
			http.NotFound(response, request)
		}
	}))
	return server, requests
}

func stringInt(value int64) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}

func TestResolvePreservesCuratedMetadata(t *testing.T) {
	curated := catalog.Variant{
		ID: "trusted", Repo: "owner/repo", File: "Model-Q4_K_M.gguf",
		ExpectedBytes: 123, SHA256: strings.Repeat("a", 64),
	}
	got, err := (Downloader{}).Resolve(context.Background(), curated.Repo, curated.File, "", catalog.Catalog{Variants: []catalog.Variant{curated}})
	if err != nil || got.ID != curated.ID || got.SHA256 != curated.SHA256 {
		t.Fatalf("variant=%#v err=%v", got, err)
	}
}

func TestResolveInspectsExactCustomFile(t *testing.T) {
	server, _ := newResolverServer(t, []resolverFile{{Type: "file", Path: "Model-Q5_K_M.gguf", Size: 321}})
	defer server.Close()
	downloader := Downloader{Client: server.Client(), APIBase: server.URL, ResolveBase: server.URL, MaxBytes: 1024}
	got, err := downloader.Resolve(context.Background(), "owner/repo", "Model-Q5_K_M.gguf", "", catalog.Catalog{})
	if err != nil || got.File != "Model-Q5_K_M.gguf" || got.ExpectedBytes != 321 || !got.Unverified {
		t.Fatalf("variant=%#v err=%v", got, err)
	}
}

func TestResolveQuantizedShorthandExcludesMTPFile(t *testing.T) {
	files := []resolverFile{
		{Type: "file", Path: "Qwen3.5-2B-Q8_0.gguf", Size: 200},
		{Type: "file", Path: "Qwen3.5-2B-UD-Q4_K_XL.gguf", Size: 120},
		{Type: "file", Path: "Qwen3.5-2B-mtp-UD-Q4_K_XL.gguf", Size: 20},
	}
	server, _ := newResolverServer(t, files)
	defer server.Close()
	downloader := Downloader{Client: server.Client(), APIBase: server.URL, ResolveBase: server.URL, MaxBytes: 1024}
	got, err := downloader.Resolve(context.Background(), "unsloth/Qwen3.5-2B-MTP-GGUF:ud-q4_k_xl", "", "", catalog.Catalog{})
	if err != nil || got.Repo != "unsloth/Qwen3.5-2B-MTP-GGUF" || got.File != "Qwen3.5-2B-UD-Q4_K_XL.gguf" {
		t.Fatalf("variant=%#v err=%v", got, err)
	}
}

func TestResolveBlankQuantizationPreferences(t *testing.T) {
	for name, testCase := range map[string]struct {
		files []resolverFile
		want  string
	}{
		"q4 before q8": {
			files: []resolverFile{{Type: "file", Path: "Model-Q8_0.gguf", Size: 200}, {Type: "file", Path: "Model-Q4_K_M.gguf", Size: 100}},
			want:  "Model-Q4_K_M.gguf",
		},
		"q8 fallback": {
			files: []resolverFile{{Type: "file", Path: "Model-Q8_0.gguf", Size: 200}, {Type: "file", Path: "notes.txt", Size: 10}},
			want:  "Model-Q8_0.gguf",
		},
		"sole gguf fallback": {
			files: []resolverFile{{Type: "file", Path: "Model-IQ3_XS.gguf", Size: 90}},
			want:  "Model-IQ3_XS.gguf",
		},
	} {
		t.Run(name, func(t *testing.T) {
			server, _ := newResolverServer(t, testCase.files)
			defer server.Close()
			downloader := Downloader{Client: server.Client(), APIBase: server.URL, ResolveBase: server.URL, MaxBytes: 1024}
			got, err := downloader.Resolve(context.Background(), "owner/repo", "", "", catalog.Catalog{})
			if err != nil || got.File != testCase.want {
				t.Fatalf("variant=%#v err=%v want=%q", got, err, testCase.want)
			}
		})
	}
}

func TestResolveRejectsAmbiguousMissingAndSplitModels(t *testing.T) {
	for name, testCase := range map[string]struct {
		repo  string
		files []resolverFile
		code  string
	}{
		"ambiguous": {
			repo: "owner/repo:Q4_K_M",
			files: []resolverFile{
				{Type: "file", Path: "Model-A-Q4_K_M.gguf", Size: 100},
				{Type: "file", Path: "Model-B-Q4_K_M.gguf", Size: 100},
			},
			code: CodeAmbiguousModel,
		},
		"missing": {
			repo:  "owner/repo:Q6_K",
			files: []resolverFile{{Type: "file", Path: "Model-Q4_K_M.gguf", Size: 100}},
			code:  CodeQuantizationNotFound,
		},
		"split": {
			repo:  "owner/repo:Q4_K_M",
			files: []resolverFile{{Type: "file", Path: "Model-Q4_K_M-00001-of-00002.gguf", Size: 100}},
			code:  CodeSplitModelUnsupported,
		},
	} {
		t.Run(name, func(t *testing.T) {
			server, _ := newResolverServer(t, testCase.files)
			defer server.Close()
			downloader := Downloader{Client: server.Client(), APIBase: server.URL, ResolveBase: server.URL, MaxBytes: 1024}
			_, err := downloader.Resolve(context.Background(), testCase.repo, "", "hf_secret_must_not_appear", catalog.Catalog{})
			var safeErr *Error
			if !AsError(err, &safeErr) || safeErr.Code != testCase.code {
				t.Fatalf("err=%#v want code=%q", err, testCase.code)
			}
			if strings.Contains(err.Error(), "hf_secret_must_not_appear") {
				t.Fatalf("error exposed token: %v", err)
			}
		})
	}
}

func TestResolveFollowsRepositoryPagination(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodGet && request.URL.Path != "/page-2":
			response.Header().Set("Content-Type", "application/json")
			response.Header().Set("Link", "<"+server.URL+"/page-2>; rel=\"next\"")
			_, _ = response.Write([]byte(`[{"type":"file","path":"README.md","size":10}]`))
		case request.Method == http.MethodGet && request.URL.Path == "/page-2":
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`[{"type":"file","path":"Model-Q4_K_M.gguf","size":123}]`))
		case request.Method == http.MethodHead:
			response.Header().Set("X-Linked-Size", "123")
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	downloader := Downloader{Client: server.Client(), APIBase: server.URL, ResolveBase: server.URL, MaxBytes: 1024}
	got, err := downloader.Resolve(context.Background(), "owner/repo:Q4_K_M", "", "", catalog.Catalog{})
	if err != nil || got.File != "Model-Q4_K_M.gguf" {
		t.Fatalf("variant=%#v err=%v", got, err)
	}
}

func TestPrimaryGGUFClassificationExcludesSidecars(t *testing.T) {
	for _, path := range []string{
		"Model-mmproj-Q4_K_M.gguf",
		"Model-imatrix-Q4_K_M.gguf",
		"Model-mtp-Q4_K_M.gguf",
		"Model-eagle3-Q4_K_M.gguf",
		"Model-dflash-Q4_K_M.gguf",
	} {
		if isPrimaryGGUF(path) {
			t.Fatalf("sidecar accepted as primary model: %s", path)
		}
	}
	if !isPrimaryGGUF("Model-Q4_K_M.gguf") {
		t.Fatal("primary GGUF was rejected")
	}
}

func TestResolveRejectsMalformedInputBeforeHTTP(t *testing.T) {
	server, requests := newResolverServer(t, nil)
	defer server.Close()
	downloader := Downloader{Client: server.Client(), APIBase: server.URL, ResolveBase: server.URL, MaxBytes: 1024}
	_, err := downloader.Resolve(context.Background(), "https://evil.example/model", "../secret.gguf", "", catalog.Catalog{})
	if err == nil {
		t.Fatal("malformed input was accepted")
	}
	if requests.Load() != 0 {
		t.Fatalf("malformed input made %d HTTP requests", requests.Load())
	}
}
