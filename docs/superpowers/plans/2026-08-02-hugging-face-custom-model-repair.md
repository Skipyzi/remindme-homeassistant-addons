# Hugging Face Custom Model Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore curated Hugging Face downloads and allow native Home Assistant configuration to bootstrap exact or `repo:quant` custom GGUF models securely.

**Architecture:** Keep the Go model manager authoritative. Extend its HTTP client to trust only HTTPS Hugging Face domain families, add a resolver that turns exact or shorthand input into one concrete `catalog.Variant`, and register resolved custom variants in the protected custom catalog before the existing preflight/download/activation pipeline runs.

**Tech Stack:** Go 1.24 standard library, Home Assistant add-on YAML, `net/http`, `httptest`, JSON Hugging Face Hub APIs, existing manager catalog/downloader/supervisor packages.

## Global Constraints

- Target checkout: `.worktrees/hardware-model-cookbook` (`Skipyzi/remindme-homeassistant-addons`).
- Do not modify or stage the unrelated untracked `remindme-vault/package-lock.json`.
- Accept both exact `hf_repo` + `hf_file` and llama.cpp-style `<owner>/<repo>:<quant>` with blank `hf_file`.
- Keep `model_path` authoritative and confined beneath `/data/models`.
- Allow only HTTPS redirects to exact or dot-boundary subdomains of `huggingface.co`, `hf.co`, `xethub.hf.co`, and `xethub-eu.hf.co`.
- Never forward a Hugging Face bearer token to CDN/storage redirects.
- Preserve resumable `.partial` downloads, exact size checks, GGUF validation, and curated SHA-256 verification.
- Reject ambiguous and split GGUF shorthand selections explicitly.
- Do not add third-party Go dependencies.
- Every code change follows red-green-refactor and is committed separately.

---

## File Structure

- Modify `local-llama-cpp/manager/internal/download/downloader.go`: shared trusted HTTP client and redirect policy.
- Modify `local-llama-cpp/manager/internal/download/downloader_test.go`: redirect, HTTPS, boundary, and authorization tests.
- Create `local-llama-cpp/manager/internal/download/resolver.go`: parse native model selection, list Hugging Face repository files, select one GGUF, inspect size, and produce a custom variant.
- Create `local-llama-cpp/manager/internal/download/resolver_test.go`: exact, quantized, default, sidecar, ambiguity, split, pagination, and secret-safety tests.
- Modify `local-llama-cpp/manager/internal/catalog/catalog.go`: merge and validate persisted custom variants.
- Modify `local-llama-cpp/manager/internal/catalog/catalog_test.go`: custom catalog loading/merging tests.
- Modify `local-llama-cpp/manager/internal/api/server.go`: expose one safe custom-variant registration path and reuse it from the existing API.
- Modify `local-llama-cpp/manager/internal/api/server_test.go`: registration persistence and duplicate/idempotency tests.
- Modify `local-llama-cpp/manager/cmd/model-manager/main.go`: load persisted custom entries and resolve unknown native configuration during bootstrap.
- Modify `local-llama-cpp/manager/cmd/model-manager/main_test.go`: exact custom and shorthand startup tests.
- Modify `local-llama-cpp/manager/integration_test.go`: end-to-end custom resolve/download/activation regression.
- Modify `local-llama-cpp/config.yaml`: bump add-on version.
- Modify `local-llama-cpp/README.md`: document exact and shorthand native configuration and safety limits.
- Create `local-llama-cpp/CHANGELOG.md`: record the repair.
- Modify `test/local-model-addon.test.mjs`: assert packaged metadata/documentation expectations.

---

### Task 1: Repair Hugging Face Redirect Security

**Files:**
- Modify: `local-llama-cpp/manager/internal/download/downloader.go:237-262`
- Test: `local-llama-cpp/manager/internal/download/downloader_test.go`

**Interfaces:**
- Produces: `trustedHuggingFaceHost(host string) bool`
- Produces: `Downloader.httpClient() *http.Client` that enforces HTTPS, domain boundaries, redirect limits, and credential stripping.
- Consumes: existing `Downloader.Client` and `download.Error{Code: CodeUnsafeRedirect}`.

- [ ] **Step 1: Add failing host-policy tests**

Append table-driven tests that cover current official hosts and lookalikes:

```go
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
```

Add a direct redirect callback test which constructs a redirect request for `https://us.aws.cdn.hf.co/model.gguf`, seeds `Authorization: Bearer hf_test_secret`, invokes `client.CheckRedirect`, and asserts success plus an empty authorization header. Add equivalent rejection cases for `http://us.aws.cdn.hf.co/...` and `https://hf.co.attacker.example/...`.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd local-llama-cpp/manager
go test ./internal/download -run 'TestTrustedHuggingFaceHost|TestRedirect' -count=1
```

Expected: build failure because `trustedHuggingFaceHost` does not exist, followed by failing official-CDN/HTTPS assertions once the test compiles.

- [ ] **Step 3: Implement the strict host helper and redirect callback**

Replace `allowedRedirectHost` with exact-or-dot-boundary matching:

```go
func trustedHuggingFaceHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, root := range []string{"huggingface.co", "hf.co", "xethub.hf.co", "xethub-eu.hf.co"} {
		if host == root || strings.HasSuffix(host, "."+root) {
			return true
		}
	}
	return false
}
```

Update `Downloader.httpClient` so its callback:

```go
clone.CheckRedirect = func(request *http.Request, via []*http.Request) error {
	if request.URL.Scheme != "https" || request.URL.User != nil || !trustedHuggingFaceHost(request.URL.Hostname()) {
		return &Error{Code: CodeUnsafeRedirect, SafeMessage: "Hugging Face redirected the download to an unapproved host."}
	}
	if len(via) >= 10 {
		return &Error{Code: CodeUnsafeRedirect, SafeMessage: "Hugging Face redirected the download too many times."}
	}
	if len(via) > 0 && !strings.EqualFold(via[len(via)-1].URL.Hostname(), request.URL.Hostname()) {
		request.Header.Del("Authorization")
	}
	if prior != nil {
		return prior(request, via)
	}
	return nil
}
```

The callback must strip authorization before invoking a caller-supplied redirect callback.

- [ ] **Step 4: Run all downloader tests**

Run:

```bash
go test ./internal/download -count=1
```

Expected: PASS, including the existing unrelated-host rejection and authentication secret-safety tests.

- [ ] **Step 5: Commit the redirect repair**

```bash
git add local-llama-cpp/manager/internal/download/downloader.go local-llama-cpp/manager/internal/download/downloader_test.go
git commit -m "fix(llama): allow secure Hugging Face CDN redirects"
```

---

### Task 2: Resolve Exact and Quantized Custom GGUF Models

**Files:**
- Create: `local-llama-cpp/manager/internal/download/resolver.go`
- Create: `local-llama-cpp/manager/internal/download/resolver_test.go`
- Modify: `local-llama-cpp/manager/internal/download/downloader.go` (`Downloader` fields only)

**Interfaces:**
- Produces: `func (downloader Downloader) Resolve(ctx context.Context, rawRepo, rawFile, token string, curated catalog.Catalog) (catalog.Variant, error)`.
- Produces: optional `Downloader.APIBase string`; empty defaults to `https://huggingface.co`.
- Consumes: `catalog.ValidateCustom`, `Downloader.Inspect`, and the trusted HTTP client from Task 1.
- Error codes: add `quantization_not_found`, `ambiguous_model`, and `split_model_unsupported` alongside existing download error codes.

- [ ] **Step 1: Write failing resolver tests for curated and exact custom input**

Create `resolver_test.go` with a fake Hugging Face server and these assertions:

```go
func TestResolvePreservesCuratedMetadata(t *testing.T) {
	curated := catalog.Variant{ID: "trusted", Repo: "owner/repo", File: "Model-Q4_K_M.gguf", ExpectedBytes: 123, SHA256: strings.Repeat("a", 64)}
	got, err := (Downloader{}).Resolve(context.Background(), curated.Repo, curated.File, "", catalog.Catalog{Variants: []catalog.Variant{curated}})
	if err != nil || got.ID != curated.ID || got.SHA256 != curated.SHA256 {
		t.Fatalf("variant=%#v err=%v", got, err)
	}
}

func TestResolveInspectsExactCustomFile(t *testing.T) {
	server := newResolverServer(t, []repoFile{{Type: "file", Path: "Model-Q5_K_M.gguf", Size: 321}})
	downloader := Downloader{Client: server.Client(), APIBase: server.URL, ResolveBase: server.URL, MaxBytes: 1024}
	got, err := downloader.Resolve(context.Background(), "owner/repo", "Model-Q5_K_M.gguf", "", catalog.Catalog{})
	if err != nil || got.File != "Model-Q5_K_M.gguf" || got.ExpectedBytes != 321 || !got.Unverified {
		t.Fatalf("variant=%#v err=%v", got, err)
	}
}
```

The test server must answer repository-tree `GET` requests with JSON and exact-file `HEAD` requests with `X-Linked-Size`.

- [ ] **Step 2: Write failing shorthand-selection tests**

Cover:

```go
func TestResolveQuantizedShorthand(t *testing.T) {
	files := []repoFile{
		{Type: "file", Path: "Qwen3.5-2B-Q8_0.gguf", Size: 200},
		{Type: "file", Path: "Qwen3.5-2B-UD-Q4_K_XL.gguf", Size: 120},
		{Type: "file", Path: "Qwen3.5-2B-mtp-UD-Q4_K_XL.gguf", Size: 20},
	}
	server := newResolverServer(t, files)
	downloader := Downloader{Client: server.Client(), APIBase: server.URL, ResolveBase: server.URL, MaxBytes: 1024}
	got, err := downloader.Resolve(context.Background(), "unsloth/Qwen3.5-2B-MTP-GGUF:UD-Q4_K_XL", "", "", catalog.Catalog{})
	if err != nil || got.Repo != "unsloth/Qwen3.5-2B-MTP-GGUF" || got.File != "Qwen3.5-2B-UD-Q4_K_XL.gguf" {
		t.Fatalf("variant=%#v err=%v", got, err)
	}
}
```

Also test:

- quantization matching is case-insensitive;
- blank quant prefers one `Q4_K_M`, then one `Q8_0`, then a sole model;
- `mmproj`, `imatrix`, `mtp-`, `eagle3-`, and `dflash-` are excluded case-insensitively;
- multiple matches return `CodeAmbiguousModel`;
- no match returns `CodeQuantizationNotFound` with a bounded, credential-free list of available model files;
- a `-00001-of-00002.gguf` match returns `CodeSplitModelUnsupported`;
- malformed repo/file input fails without making an HTTP request;
- API pagination follows at most ten trusted HTTPS `Link` pages;
- errors never contain the token or a signed URL.

- [ ] **Step 3: Run resolver tests and verify failure**

```bash
go test ./internal/download -run 'TestResolve' -count=1
```

Expected: build failure because `Downloader.Resolve`, `Downloader.APIBase`, and resolver error constants do not exist.

- [ ] **Step 4: Implement repository parsing and file classification**

Create `resolver.go` with internal types and focused helpers:

```go
type repoFile struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	LFS  *struct {
		Size int64 `json:"size"`
	} `json:"lfs,omitempty"`
}

var splitGGUFPattern = regexp.MustCompile(`(?i)-[0-9]{5}-of-[0-9]{5}\.gguf$`)

func splitRepoQuant(raw string) (repo, quant string, err error) {
	parts := strings.Split(raw, ":")
	if len(parts) > 2 || len(parts) == 0 {
		return "", "", errors.New("repository must use owner/repo[:quant]")
	}
	repo = parts[0]
	if len(parts) == 2 {
		quant = parts[1]
		if quant == "" {
			return "", "", errors.New("quantization suffix is empty")
		}
	}
	return repo, quant, nil
}

func isPrimaryGGUF(path string) bool {
	lower := strings.ToLower(path)
	if !strings.HasSuffix(lower, ".gguf") || strings.Contains(path, "/") {
		return false
	}
	for _, excluded := range []string{"mmproj", "imatrix", "mtp-", "eagle3-", "dflash-"} {
		if strings.Contains(lower, excluded) {
			return false
		}
	}
	return true
}
```

Treat nested paths as unsupported because the existing safe local filename validator intentionally permits only one basename.

- [ ] **Step 5: Implement bounded repository listing and deterministic selection**

Implement `listRepoFiles` using:

```text
GET {APIBase}/api/models/{owner}/{repo}/tree/main?recursive=true&expand=false&limit=1000
Authorization: Bearer <token> only when configured
Accept: application/json
```

Decode with a bounded response body (8 MiB), reject non-200 responses using existing safe authentication/repository errors, and follow only trusted HTTPS pagination links for at most ten pages.

Implement selection as:

1. retain only primary `.gguf` files;
2. if quant is present, match `regexp.QuoteMeta(strings.ToUpper(quant)) + "[.-]"` against uppercase paths;
3. if quant is blank, try `Q4_K_M`, then `Q8_0`, then all primary files;
4. return one unique candidate;
5. return split-unsupported if the unique candidate is a shard;
6. return explicit not-found or ambiguous errors otherwise.

Do not include more than ten available basenames in a safe error message.

- [ ] **Step 6: Implement `Downloader.Resolve`**

Use this control flow:

```go
func (downloader Downloader) Resolve(ctx context.Context, rawRepo, rawFile, token string, curated catalog.Catalog) (catalog.Variant, error) {
	repo, quant, err := splitRepoQuant(rawRepo)
	if err != nil {
		return catalog.Variant{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: err.Error()}
	}
	if rawFile != "" {
		quant = ""
	}
	if rawFile != "" {
		for _, variant := range curated.Variants {
			if variant.Repo == repo && variant.File == rawFile {
				return variant, nil
			}
		}
	}
	file := rawFile
	if file == "" {
		if variant, ok, selectErr := selectCuratedVariant(curated, repo, quant); selectErr != nil {
			return catalog.Variant{}, selectErr
		} else if ok {
			return variant, nil
		}
		files, listErr := downloader.listRepoFiles(ctx, repo, token)
		if listErr != nil {
			return catalog.Variant{}, listErr
		}
		file, err = selectModelFile(files, quant)
		if err != nil {
			return catalog.Variant{}, err
		}
	}
	variant, err := catalog.ValidateCustom(catalog.CustomInput{Repo: repo, File: file})
	if err != nil {
		return catalog.Variant{}, &Error{Code: CodeRepositoryUnavailable, SafeMessage: "The Hugging Face repository or GGUF filename is invalid."}
	}
	metadata, err := downloader.Inspect(ctx, variant, token)
	if err != nil {
		return catalog.Variant{}, err
	}
	variant.ExpectedBytes = metadata.Bytes
	variant.Parameters = max(metadata.Bytes*2, 1)
	variant.MinimumRAM = metadata.Bytes + 2*1024*1024*1024
	variant.RecommendedRAM = variant.MinimumRAM + 1024*1024*1024
	return variant, nil
}
```

`selectCuratedVariant` must apply the same unique quantization and blank-quantization preference rules as `selectModelFile`; it must never treat an unrelated first catalog entry as a match.

- [ ] **Step 7: Run resolver and downloader tests**

```bash
gofmt -w internal/download/downloader.go internal/download/downloader_test.go internal/download/resolver.go internal/download/resolver_test.go
go test ./internal/download -count=1
```

Expected: PASS.

- [ ] **Step 8: Commit the resolver**

```bash
git add local-llama-cpp/manager/internal/download
git commit -m "feat(llama): resolve custom Hugging Face GGUF models"
```

---

### Task 3: Persist Custom Variants and Integrate Native Startup

**Files:**
- Modify: `local-llama-cpp/manager/internal/catalog/catalog.go`
- Test: `local-llama-cpp/manager/internal/catalog/catalog_test.go`
- Modify: `local-llama-cpp/manager/internal/api/server.go`
- Test: `local-llama-cpp/manager/internal/api/server_test.go`
- Modify: `local-llama-cpp/manager/cmd/model-manager/main.go`
- Test: `local-llama-cpp/manager/cmd/model-manager/main_test.go`

**Interfaces:**
- Produces: `catalog.LoadCustomFile(path string) (catalog.Catalog, error)`; missing file returns an empty catalog.
- Produces: `catalog.Merge(base, custom catalog.Catalog) (catalog.Catalog, error)`; IDs and repo/file pairs cannot conflict.
- Produces: `(*api.Server).RegisterCustom(variant catalog.Variant) error`; idempotent for an identical entry and persists all unverified entries with mode `0600`.
- Consumes: `Downloader.Resolve` from Task 2.

- [ ] **Step 1: Add failing custom catalog load/merge tests**

Add tests proving:

```go
func TestLoadCustomFileAllowsValidatedUnverifiedVariant(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalog.json")
	variant, _ := ValidateCustom(CustomInput{Repo: "owner/repo", File: "Model-Q4_K_M.gguf"})
	variant.ExpectedBytes = 123
	data, _ := json.Marshal(map[string]any{"variants": []Variant{variant}})
	if err := os.WriteFile(path, data, 0o600); err != nil { t.Fatal(err) }
	got, err := LoadCustomFile(path)
	if err != nil || len(got.Variants) != 1 || got.Variants[0].SHA256 != "" { t.Fatalf("catalog=%#v err=%v", got, err) }
}
```

Also verify missing file is empty, malformed/custom entries fail closed, identical merge is idempotent, and conflicting IDs or repo/file pairs fail.

- [ ] **Step 2: Run catalog tests and verify failure**

```bash
go test ./internal/catalog -run 'TestLoadCustom|TestMerge' -count=1
```

Expected: build failure for missing `LoadCustomFile` and `Merge`.

- [ ] **Step 3: Implement custom catalog validation and merge**

`LoadCustomFile` must decode with `DisallowUnknownFields`, require `Unverified == true`, regenerate the expected identity through `ValidateCustom`, require matching ID/repo/file, positive `ExpectedBytes`, conservative positive runtime/context/memory values, and no SHA-256. It must treat only `os.ErrNotExist` as an empty catalog.

`Merge` returns a new slice, preserving curated entries first. An identical custom ID/repo/file is ignored; any differing duplicate ID or duplicate repo/file with a different ID returns an error.

- [ ] **Step 4: Add failing API registration tests**

In `server_test.go`, construct a server with a temporary `CustomCatalogPath`, call `RegisterCustom`, and assert:

- the public/server catalog can find the variant;
- the file exists with permission bits `0600`;
- `catalog.LoadCustomFile` reads it back;
- registering the same variant twice is idempotent;
- a conflicting variant returns an error and does not corrupt the persisted file.

- [ ] **Step 5: Implement and reuse `RegisterCustom`**

Move the catalog-lock/update/save logic from `addCustom` into:

```go
func (server *Server) RegisterCustom(variant catalog.Variant) error {
	if !variant.Unverified {
		return errors.New("only custom variants can be registered")
	}
	server.catalogMu.Lock()
	defer server.catalogMu.Unlock()
	merged, err := catalog.Merge(server.catalog, catalog.Catalog{Variants: []catalog.Variant{variant}})
	if err != nil {
		return err
	}
	custom := make([]catalog.Variant, 0)
	for _, item := range merged.Variants {
		if item.Unverified {
			custom = append(custom, item)
		}
	}
	if err := saveProtectedJSON(server.dependencies.CustomCatalogPath, map[string]any{"variants": custom}); err != nil {
		return err
	}
	server.catalog = merged
	return nil
}
```

Change `addCustom` to call `RegisterCustom` and retain its existing HTTP conflict/write error mapping.

- [ ] **Step 6: Run catalog and API tests**

```bash
go test ./internal/catalog ./internal/api -count=1
```

Expected: PASS.

- [ ] **Step 7: Add failing native startup tests**

Refactor the test seam around configured model resolution with:

```go
type configuredResolver interface {
	Resolve(context.Context, string, string, string, catalog.Catalog) (catalog.Variant, error)
}
```

Add a fake resolver recording repo/file/token. Test:

- exact custom `owner/repo` + `Model-Q5_K_M.gguf` invokes the resolver and returns `/data/models/Model-Q5_K_M.gguf`;
- `unsloth/Qwen3.5-2B-MTP-GGUF:UD-Q4_K_XL` + blank file invokes the resolver and returns the resolved primary file;
- curated exact selection remains unchanged;
- `model_path` does not call the resolver;
- resolver errors remain safe and do not replace options;
- an unverified resolved variant is passed to the registration callback before download.

- [ ] **Step 8: Integrate resolver and persisted custom catalog in `main.go`**

After calculating `customCatalogPath`, load and merge persisted custom entries before constructing the API server:

```go
customCatalog, err := catalog.LoadCustomFile(customCatalogPath)
if err != nil {
	log.Fatal(err)
}
modelCatalog, err = catalog.Merge(modelCatalog, customCatalog)
if err != nil {
	log.Fatal(err)
}
```

Change `configuredModel` to accept `context.Context`, `configuredResolver`, and token. Preserve the complete existing `model_path` branch. Replace `findConfiguredVariant`/`unknownVariantDiagnostic` fallback with `resolver.Resolve`.

Change `recoverOrBootstrap` to call the resolver. When the result is unverified, call `server.RegisterCustom(*variant)` before preflight/download. Registration failure degrades startup without downloading. Remove `findConfiguredVariant` and `unknownVariantDiagnostic` after no callers remain.

Pass the existing `download.Downloader` as the resolver and the server registration method into the bootstrap goroutine. Do not move download or llama startup onto the main HTTP-serving goroutine.

- [ ] **Step 9: Run startup and package tests**

```bash
gofmt -w cmd/model-manager/main.go cmd/model-manager/main_test.go internal/catalog/catalog.go internal/catalog/catalog_test.go internal/api/server.go internal/api/server_test.go
go test ./cmd/model-manager ./internal/catalog ./internal/api -count=1
```

Expected: PASS; the old curated-only diagnostic test is removed or replaced by resolver-error coverage.

- [ ] **Step 10: Commit startup integration**

```bash
git add local-llama-cpp/manager/cmd/model-manager local-llama-cpp/manager/internal/catalog local-llama-cpp/manager/internal/api
git commit -m "feat(llama): bootstrap custom models from native options"
```

---

### Task 4: Add End-to-End Regression Coverage

**Files:**
- Modify: `local-llama-cpp/manager/integration_test.go`

**Interfaces:**
- Consumes: `Downloader.Resolve`, `api.Server.RegisterCustom`, and the existing manager download/supervisor lifecycle.
- Produces: regression proof for shorthand resolve → inspect → download → verification → activation.

- [ ] **Step 1: Write the failing integration test**

Add a test Hugging Face server that:

- returns repository-tree JSON containing `Qwen3.5-2B-UD-Q4_K_XL.gguf` and an excluded `Qwen3.5-2B-mtp-UD-Q4_K_XL.gguf`;
- returns `X-Linked-Size` for `HEAD`;
- returns `GGUFcandidate` for `GET`;
- records whether a token reached any simulated CDN handler.

Build the custom variant through:

```go
variant, err := downloader.Resolve(
	context.Background(),
	"unsloth/Qwen3.5-2B-MTP-GGUF:UD-Q4_K_XL",
	"",
	"",
	catalog.Catalog{},
)
```

Register it, install it, wait for verification, activate it, and assert that the launcher reports the resolved filename. Confirm the final model exists, starts with `GGUF`, and is recorded by the verification store.

- [ ] **Step 2: Run the integration test and verify failure**

```bash
go test . -run TestCustomShorthandResolveDownloadAndActivate -count=1
```

Expected: FAIL until every resolver, registration, and activation assertion is wired correctly.

- [ ] **Step 3: Make only the minimal test-harness adjustments required**

Reuse the existing `integrationLauncher`, temporary model directory, supervisor readiness stub, API authentication pattern, and bounded polling loop. Do not introduce production changes unless the integration test exposes a real missing boundary; if it does, return to the owning task's unit test before changing production code.

- [ ] **Step 4: Run all manager tests and race tests**

```bash
go test ./... -count=1
go test -race ./... -count=1
```

Expected: both commands PASS with no data race reports.

- [ ] **Step 5: Commit integration coverage**

```bash
git add local-llama-cpp/manager/integration_test.go
git commit -m "test(llama): cover custom model bootstrap lifecycle"
```

---

### Task 5: Release Metadata and Operator Documentation

**Files:**
- Modify: `local-llama-cpp/config.yaml:2`
- Modify: `local-llama-cpp/README.md`
- Create: `local-llama-cpp/CHANGELOG.md`
- Modify: `test/local-model-addon.test.mjs`

**Interfaces:**
- Produces: Home Assistant add-on version `1.12.1`.
- Documents: exact-file and shorthand native configuration, official redirect behavior, unsupported split/sidecar models, and credential handling.

- [ ] **Step 1: Add failing packaging/documentation assertions**

Extend `test/local-model-addon.test.mjs`, replacing its stale `version: "1.10.0"` assertion, to assert:

```js
assert.match(config, /version:\s*["']1\.12\.1["']/);
assert.match(readme, /owner\/repo:Q4_K_M/);
assert.match(readme, /split GGUF/i);
assert.match(readme, /exact GGUF filename/i);
assert.match(changelog, /us\.aws\.cdn\.hf\.co/);
assert.match(changelog, /custom/i);
```

Read `local-llama-cpp/CHANGELOG.md` in the fixture setup.

- [ ] **Step 2: Run the add-on metadata test and verify failure**

From the checkout root:

```bash
node --test test/local-model-addon.test.mjs
```

Expected: FAIL because version `1.12.1`, changelog, and new documentation are absent.

- [ ] **Step 3: Update version and documentation**

Set `local-llama-cpp/config.yaml` version to `"1.12.1"`.

Add native examples to the README:

```yaml
# Exact custom file
hf_repo: owner/repo
hf_file: Model-Q5_K_M.gguf

# llama.cpp-style quantization selection
hf_repo: owner/repo:Q4_K_M
hf_file: ""
```

State explicitly that shorthand selects one primary, single-file GGUF; ambiguous, split, and sidecar-only repositories require an exact supported single-file selection. Explain that custom models receive size and GGUF checks but not a curated SHA-256 guarantee.

Create `CHANGELOG.md` with a `1.12.1` entry describing:

- official Hugging Face CDN/Xet redirect support, including `us.aws.cdn.hf.co`;
- exact and `repo:quant` custom model bootstrap;
- strict HTTPS/domain-boundary and credential-forwarding protections;
- no replacement of preserved native configuration on errors.

- [ ] **Step 4: Run metadata and manager verification**

```bash
node --test test/local-model-addon.test.mjs
cd local-llama-cpp/manager
go test ./... -count=1
go test -race ./... -count=1
go vet ./...
```

Expected: every command PASS.

- [ ] **Step 5: Build the manager binary and add-on image**

```bash
CGO_ENABLED=0 go build -trimpath -o "$TMPDIR/model-manager" ./cmd/model-manager
cd ../..
docker build -t local-llama-cpp:1.12.1 local-llama-cpp
```

Expected: Go build exits zero and Docker completes the manager stage and final image successfully. If Docker is unavailable, record that environmental limitation without claiming the image build passed; the Go build remains mandatory.

- [ ] **Step 6: Inspect the final diff and ensure unrelated files are absent**

```bash
git status --short
git diff --check
git diff --stat HEAD~4..HEAD -- local-llama-cpp test/local-model-addon.test.mjs
```

Expected: no whitespace errors; `remindme-vault/package-lock.json` remains untracked and unstaged.

- [ ] **Step 7: Commit release metadata**

```bash
git add local-llama-cpp/config.yaml local-llama-cpp/README.md local-llama-cpp/CHANGELOG.md test/local-model-addon.test.mjs
git commit -m "docs(llama): release custom Hugging Face model repair"
```

---

## Final Verification

- [ ] Run the complete manager suite:

```bash
cd local-llama-cpp/manager
go test ./... -count=1
go test -race ./... -count=1
go vet ./...
```

- [ ] Run the add-on packaging regression:

```bash
cd ../..
node --test test/local-model-addon.test.mjs
```

- [ ] Confirm the exact reported failure is covered:

```bash
cd local-llama-cpp/manager
go test ./internal/download -run 'TestTrustedHuggingFaceHost|TestResolveQuantizedShorthand' -count=1 -v
```

Expected: `us.aws.cdn.hf.co` is accepted, the Unsloth `UD-Q4_K_XL` primary GGUF resolves, and sidecars remain excluded.

- [ ] Confirm repository hygiene:

```bash
cd ../..
git status --short
git log --oneline -6
```

Expected: only the pre-existing untracked `remindme-vault/package-lock.json` remains; implementation commits are present and no unrelated file was staged.
