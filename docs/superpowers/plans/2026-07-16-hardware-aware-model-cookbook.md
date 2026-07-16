<!-- markdownlint-disable MD013 -->

# Hardware-Aware Local Model Cookbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hardware-aware GGUF catalog that downloads candidates while chat remains available, activates them through a supervised llama.cpp child process, and automatically rolls back failed candidates.

**Architecture:** A static Go model-manager binary becomes PID 1 in the local llama.cpp add-on. It supervises `llama-server` on loopback port 8081, reverse-proxies inference through the existing port 8080, and exposes authenticated `/manager/v1` operations. RemindMe pairs with it server-side through the Home Assistant Supervisor, proxies safe management data to the browser, and renders the catalog in the existing Hardware Cookbook.

**Tech Stack:** Go 1.24 standard library, llama.cpp server, Home Assistant add-on Supervisor API, Node.js 22, TypeScript 7, Express 5, Alpine.js 3, Node test runner, Docker/BuildKit, pnpm.

## Global Constraints

- Target Home Assistant OS on Raspberry Pi 5 8 GB, ARM64.
- Preserve `http://homeassistant:8080/v1/chat/completions` as the inference endpoint.
- Keep the active model serving throughout candidate download and verification.
- Retain the current active model and one previous successfully activated fallback.
- Keep Hugging Face tokens and manager credentials out of browser state, logs, GitHub, and public settings responses.
- Curated entries may use official or reviewed community GGUFs; arbitrary custom entries remain unverified and conservative.
- Do not implement STT, TTS, image inference, or cloud composition in this plan.
- Use server-side confirmation and validation boundaries already established by RemindMe.
- Use pnpm rather than npm for package operations.
- Follow test-driven development: write a failing focused test, observe failure, implement the minimum behavior, and rerun it before each commit.

---

## File Structure

### New llama.cpp manager files

- `homeassistant-addons/local-llama-cpp/manager/go.mod` — isolated dependency-free Go module.
- `homeassistant-addons/local-llama-cpp/manager/cmd/model-manager/main.go` — composition root and shutdown handling.
- `homeassistant-addons/local-llama-cpp/manager/internal/catalog/catalog.go` — catalog types, loading, custom-entry validation, and safe public projection.
- `homeassistant-addons/local-llama-cpp/manager/internal/catalog/catalog_test.go` — catalog and path-security tests.
- `homeassistant-addons/local-llama-cpp/manager/internal/catalog/catalog.json` — curated exact GGUF variants.
- `homeassistant-addons/local-llama-cpp/manager/internal/hardware/hardware.go` — host facts, KV estimate, runtime clamping, and compatibility ranking.
- `homeassistant-addons/local-llama-cpp/manager/internal/hardware/hardware_test.go` — Pi 5 and low-memory profiles.
- `homeassistant-addons/local-llama-cpp/manager/internal/state/store.go` — atomic persisted state and startup recovery decisions.
- `homeassistant-addons/local-llama-cpp/manager/internal/state/store_test.go` — state transitions and corrupt-state recovery.
- `homeassistant-addons/local-llama-cpp/manager/internal/download/downloader.go` — authenticated resumable Hugging Face downloads and GGUF validation.
- `homeassistant-addons/local-llama-cpp/manager/internal/download/downloader_test.go` — fake-Hugging-Face tests.
- `homeassistant-addons/local-llama-cpp/manager/internal/runtime/supervisor.go` — child process, proxy target, probes, activation, rollback, and retention.
- `homeassistant-addons/local-llama-cpp/manager/internal/runtime/supervisor_test.go` — fake llama-server lifecycle tests.
- `homeassistant-addons/local-llama-cpp/manager/internal/api/server.go` — authenticated management API, event stream, and inference reverse proxy.
- `homeassistant-addons/local-llama-cpp/manager/internal/api/server_test.go` — API, auth, redaction, concurrency, and streaming tests.

### Modified llama.cpp add-on files

- `homeassistant-addons/local-llama-cpp/Dockerfile` — build and install static manager binary.
- `homeassistant-addons/local-llama-cpp/config.yaml` — manager options and version bump.
- `homeassistant-addons/local-llama-cpp/run.sh` — migrate existing options and execute the manager.
- `homeassistant-addons/local-llama-cpp/README.md` — catalog, recovery, and credential documentation.

### New RemindMe backend files

- `src/harness/modelManager.ts` — typed manager client, Supervisor pairing, URL derivation, and safe error mapping.
- `test/model-manager.test.ts` — client and pairing tests.

### Modified RemindMe files

- `src/harness-server.ts` — model catalog/status/mutation/SSE routes and response model attribution.
- `src/harness/settings.ts` — public credential state only.
- `src/harness/modelPhases.ts` — model identifier in completed phase metrics.
- `test/model-phases.test.ts` — model attribution test.
- `test/settings.test.ts` — secret redaction regression.
- `public/components/model-cookbook.js` — browser-side catalog state and actions.
- `public/app.js` — initialize cookbook component state.
- `public/harness.html` — catalog, operation progress, custom entry, and token controls.
- `public/styles.css` — responsive catalog and state styling.
- `test/harness-markup.test.mjs` — semantic catalog and secret-field assertions.
- `homeassistant-addons/discord-pi-bot/config.yaml` — Supervisor permission, manager options, and version bump.
- `homeassistant-addons/discord-pi-bot/run.sh` — model-manager environment exports.
- Mirrored `src/` and `public/` under `homeassistant-addons/discord-pi-bot/` after verification.

---

### Task 1: Curated Catalog and Safe Custom Entries

**Files:**

- Create: `homeassistant-addons/local-llama-cpp/manager/go.mod`
- Create: `homeassistant-addons/local-llama-cpp/manager/internal/catalog/catalog.go`
- Create: `homeassistant-addons/local-llama-cpp/manager/internal/catalog/catalog_test.go`
- Create: `homeassistant-addons/local-llama-cpp/manager/internal/catalog/catalog.json`

**Interfaces:**

- Produces: `catalog.Load(io.Reader) (Catalog, error)`
- Produces: `catalog.ValidateCustom(CustomInput) (Variant, error)`
- Produces: `Catalog.Find(id string) (Variant, bool)`
- Produces: `Variant.Public() PublicVariant`

- [ ] **Step 1: Create the Go module**

```go
module remindme.local/model-manager

go 1.24
```

- [ ] **Step 2: Write failing catalog tests**

```go
func TestLoadFindsCuratedVariant(t *testing.T) {
 c, err := Load(strings.NewReader(`{"variants":[{"id":"qwen3-4b-q4","family":"Qwen3 4B","repo":"Qwen/Qwen3-4B-GGUF","file":"Qwen3-4B-Q4_K_M.gguf","parameters":4022468096,"quantization":"Q4_K_M","expectedBytes":2497280256,"sha256":"7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5","minimumRAM":6442450944,"recommendedRAM":7516192768,"nativeContext":40960,"recommendedContext":8192,"capabilities":["chat","tools","reasoning"],"tier":"recommended","source":"official","runtime":{"batch":256,"ubatch":128,"threads":4,"reasoningFormat":"deepseek","reasoningMode":"auto"}}]}`))
 if err != nil { t.Fatal(err) }
 v, ok := c.Find("qwen3-4b-q4")
 if !ok || v.File != "Qwen3-4B-Q4_K_M.gguf" { t.Fatalf("unexpected variant: %#v", v) }
}

func TestValidateCustomRejectsTraversalAndRemoteURLs(t *testing.T) {
 bad := []CustomInput{
  {Repo: "Qwen/Qwen3-4B-GGUF", File: "../secret.gguf"},
  {Repo: "https://evil.example/model", File: "model.gguf"},
  {Repo: "owner/repo", File: "model.bin"},
 }
 for _, input := range bad {
  if _, err := ValidateCustom(input); err == nil { t.Fatalf("accepted %#v", input) }
 }
}
```

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```bash
cd homeassistant-addons/local-llama-cpp/manager
go test ./internal/catalog -run 'TestLoad|TestValidateCustom' -v
```

Expected: FAIL because `Load`, `CustomInput`, and `ValidateCustom` do not exist.

- [ ] **Step 4: Implement catalog types and validation**

```go
type Capability string
type Tier string

type RuntimeProfile struct {
 Batch           int    `json:"batch"`
 UBatch          int    `json:"ubatch"`
 Threads         int    `json:"threads"`
 ReasoningFormat string `json:"reasoningFormat"`
 ReasoningMode   string `json:"reasoningMode"`
}

type Variant struct {
 ID                 string         `json:"id"`
 Family             string         `json:"family"`
 Repo               string         `json:"repo"`
 File               string         `json:"file"`
 Parameters         int64          `json:"parameters"`
 Quantization       string         `json:"quantization"`
 ExpectedBytes      int64          `json:"expectedBytes"`
 SHA256             string         `json:"sha256,omitempty"`
 MinimumRAM         int64          `json:"minimumRAM"`
 RecommendedRAM     int64          `json:"recommendedRAM"`
 NativeContext      int            `json:"nativeContext"`
 RecommendedContext int            `json:"recommendedContext"`
 Capabilities       []Capability   `json:"capabilities"`
 Tier               Tier           `json:"tier"`
 Source             string         `json:"source"`
 Gated              bool           `json:"gated"`
 Runtime            RuntimeProfile `json:"runtime"`
 Unverified         bool           `json:"unverified,omitempty"`
}

type Catalog struct { Variants []Variant `json:"variants"` }
type CustomInput struct { Repo, File string }

var repoPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$`)
var filePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*\.gguf$`)

func ValidateCustom(input CustomInput) (Variant, error) {
 if !repoPattern.MatchString(input.Repo) || !filePattern.MatchString(input.File) {
  return Variant{}, errors.New("repository and file must identify one Hugging Face GGUF")
 }
 id := "custom-" + strings.ToLower(strings.NewReplacer("/", "-", ".", "-").Replace(input.Repo+"-"+input.File))
 return Variant{ID: id, Family: input.Repo, Repo: input.Repo, File: input.File, Quantization: "unknown", RecommendedContext: 4096, Capabilities: []Capability{"chat"}, Tier: "experimental", Source: "custom", Unverified: true, Runtime: RuntimeProfile{Batch: 128, UBatch: 64, Threads: 4, ReasoningMode: "off"}}, nil
}
```

`Load` must decode JSON with `DisallowUnknownFields`, reject duplicate IDs, validate every repository/file pair, and reject non-positive curated sizes or contexts. `PublicVariant` must omit future credentials and internal paths.

- [ ] **Step 5: Add exact curated variants**

Use these verified repository/file pairs in `catalog.json`:

```json
{
  "variants": [
    {"id":"minicpm5-1b-q4","family":"MiniCPM5 1B","repo":"openbmb/MiniCPM5-1B-GGUF","file":"MiniCPM5-1B-Q4_K_M.gguf","parameters":1080632832,"quantization":"Q4_K_M","expectedBytes":688065920,"sha256":"81b64d05a23b17b34c475f42b3e72fbde62d4b92cc34541f7a8031d0752deafa","minimumRAM":3221225472,"recommendedRAM":4294967296,"nativeContext":131072,"recommendedContext":8192,"capabilities":["chat","tools","reasoning"],"tier":"compatible","source":"official","runtime":{"batch":256,"ubatch":128,"threads":4,"reasoningFormat":"deepseek","reasoningMode":"auto"}},
    {"id":"minicpm5-1b-q8","family":"MiniCPM5 1B","repo":"openbmb/MiniCPM5-1B-GGUF","file":"MiniCPM5-1B-Q8_0.gguf","parameters":1080632832,"quantization":"Q8_0","expectedBytes":1153529216,"sha256":"0dc7638539067268774c275a14a6ec9c7e01f7eeb2cff606c8590361fa527e4c","minimumRAM":4294967296,"recommendedRAM":5368709120,"nativeContext":131072,"recommendedContext":8192,"capabilities":["chat","tools","reasoning"],"tier":"compatible","source":"official","runtime":{"batch":256,"ubatch":128,"threads":4,"reasoningFormat":"deepseek","reasoningMode":"auto"}},
    {"id":"qwen3-1.7b-q8","family":"Qwen3 1.7B","repo":"Qwen/Qwen3-1.7B-GGUF","file":"Qwen3-1.7B-Q8_0.gguf","parameters":1720574976,"quantization":"Q8_0","expectedBytes":1834426016,"sha256":"061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a","minimumRAM":5368709120,"recommendedRAM":6442450944,"nativeContext":40960,"recommendedContext":8192,"capabilities":["chat","tools","reasoning"],"tier":"recommended","source":"official","runtime":{"batch":256,"ubatch":128,"threads":4,"reasoningFormat":"deepseek","reasoningMode":"auto"}},
    {"id":"qwen3-4b-q4","family":"Qwen3 4B","repo":"Qwen/Qwen3-4B-GGUF","file":"Qwen3-4B-Q4_K_M.gguf","parameters":4022468096,"quantization":"Q4_K_M","expectedBytes":2497280256,"sha256":"7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5","minimumRAM":6442450944,"recommendedRAM":7516192768,"nativeContext":40960,"recommendedContext":8192,"capabilities":["chat","tools","reasoning"],"tier":"recommended","source":"official","runtime":{"batch":256,"ubatch":128,"threads":4,"reasoningFormat":"deepseek","reasoningMode":"auto"}},
    {"id":"granite-3.3-2b-q4","family":"Granite 3.3 2B","repo":"ibm-granite/granite-3.3-2b-instruct-GGUF","file":"granite-3.3-2b-instruct-Q4_K_M.gguf","parameters":2533539840,"quantization":"Q4_K_M","expectedBytes":1545303328,"sha256":"ac71e9e32c0bea919b409c5918f69ca74339854b0319c5065e4e9fb6d95c4852","minimumRAM":4294967296,"recommendedRAM":6442450944,"nativeContext":131072,"recommendedContext":8192,"capabilities":["chat","tools"],"tier":"compatible","source":"official","runtime":{"batch":256,"ubatch":128,"threads":4,"reasoningFormat":"none","reasoningMode":"off"}},
    {"id":"smollm3-3b-q4","family":"SmolLM3 3B","repo":"ggml-org/SmolLM3-3B-GGUF","file":"SmolLM3-Q4_K_M.gguf","parameters":3075098624,"quantization":"Q4_K_M","expectedBytes":1915305312,"sha256":"8334b850b7bd46238c16b0c550df2138f0889bf433809008cc17a8b05761863e","minimumRAM":5368709120,"recommendedRAM":7516192768,"nativeContext":65536,"recommendedContext":8192,"capabilities":["chat","tools","reasoning"],"tier":"experimental","source":"reviewed-community","runtime":{"batch":256,"ubatch":128,"threads":4,"reasoningFormat":"deepseek","reasoningMode":"auto"}},
    {"id":"gemma3-4b-q4","family":"Gemma 3 4B","repo":"google/gemma-3-4b-it-qat-q4_0-gguf","file":"gemma-3-4b-it-q4_0.gguf","parameters":3880099328,"quantization":"Q4_0","expectedBytes":3155051328,"sha256":"76aed0a8285b83102f18b5d60e53c70d09eb4e9917a20ce8956bd546452b56e2","minimumRAM":6442450944,"recommendedRAM":7516192768,"nativeContext":131072,"recommendedContext":4096,"capabilities":["chat","vision"],"tier":"compatible","source":"official","gated":true,"runtime":{"batch":128,"ubatch":64,"threads":4,"reasoningFormat":"none","reasoningMode":"off"}},
    {"id":"phi4-mini-q4","family":"Phi-4 Mini","repo":"unsloth/Phi-4-mini-instruct-GGUF","file":"Phi-4-mini-instruct-Q4_K_M.gguf","parameters":3836021856,"quantization":"Q4_K_M","expectedBytes":2491874272,"sha256":"88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a","minimumRAM":6442450944,"recommendedRAM":7516192768,"nativeContext":131072,"recommendedContext":4096,"capabilities":["chat","reasoning"],"tier":"experimental","source":"reviewed-community","runtime":{"batch":128,"ubatch":64,"threads":4,"reasoningFormat":"none","reasoningMode":"off"}}
  ]
}
```

The byte lengths and SHA-256 values above come from each repository's Hugging Face LFS metadata. Catalog validation requires exact positive byte lengths and a 64-character lowercase SHA-256 value for every curated variant.

- [ ] **Step 6: Run catalog tests**

Run: `cd homeassistant-addons/local-llama-cpp/manager && go test ./internal/catalog -v`

Expected: PASS with duplicate IDs, traversal, extension, and public-projection cases covered.

- [ ] **Step 7: Commit**

```bash
git add homeassistant-addons/local-llama-cpp/manager
git commit -m "feat: add curated GGUF model catalog"
```

---

### Task 2: Hardware Estimation and Runtime Clamping

**Files:**

- Create: `homeassistant-addons/local-llama-cpp/manager/internal/hardware/hardware.go`
- Create: `homeassistant-addons/local-llama-cpp/manager/internal/hardware/hardware_test.go`

**Interfaces:**

- Consumes: `catalog.Variant`, `catalog.RuntimeProfile`
- Produces: `hardware.Assess(variant catalog.Variant, facts Facts, requestedContext int, override bool) Assessment`
- Produces: `hardware.ReadFacts(modelDir string) (Facts, error)`

- [ ] **Step 1: Write failing Pi assessment tests**

```go
func TestAssessQwen4BFitsPi8GBAtBoundedContext(t *testing.T) {
 v := catalog.Variant{ExpectedBytes: 2497280256, Parameters: 4022468096, RecommendedContext: 8192, MinimumRAM: 6442450944, RecommendedRAM: 7516192768, Runtime: catalog.RuntimeProfile{Batch: 256, UBatch: 128, Threads: 4}}
 a := Assess(v, Facts{TotalRAM: 8589934592, FreeRAM: 7516192768, FreeDisk: 12884901888, CPUCores: 4, Architecture: "arm64"}, 8192, false)
 if !a.Safe || a.Runtime.Context != 8192 || a.Runtime.Threads != 4 { t.Fatalf("unexpected: %#v", a) }
}

func TestAssessRejectsUnsafeMemoryWithoutOverride(t *testing.T) {
 v := catalog.Variant{ExpectedBytes: 3155051328, Parameters: 3880099328, RecommendedContext: 8192, MinimumRAM: 6442450944, Runtime: catalog.RuntimeProfile{Batch: 256, UBatch: 128, Threads: 8}}
 a := Assess(v, Facts{TotalRAM: 4294967296, FreeRAM: 3221225472, FreeDisk: 12884901888, CPUCores: 4, Architecture: "arm64"}, 8192, false)
 if a.Safe || a.Code != "insufficient_memory" { t.Fatalf("unexpected: %#v", a) }
}
```

- [ ] **Step 2: Verify failure**

Run: `cd homeassistant-addons/local-llama-cpp/manager && go test ./internal/hardware -v`

Expected: FAIL because `Assess` and `Facts` do not exist.

- [ ] **Step 3: Implement deterministic estimates**

```go
type Facts struct { TotalRAM, FreeRAM, FreeDisk int64; CPUCores int; Architecture string }
type Runtime struct { Context, Batch, UBatch, Threads int; ReasoningFormat, ReasoningMode string }
type Assessment struct { Safe bool; Code string; RequiredRAM, RequiredDisk int64; Runtime Runtime; Warnings []string }

func estimateKV(parameters int64, context int) int64 {
 bytesPerToken := int64(128*1024)
 if parameters >= 3_000_000_000 { bytesPerToken = 256 * 1024 }
 return int64(context) * bytesPerToken
}

func Assess(v catalog.Variant, f Facts, requestedContext int, override bool) Assessment {
 context := min(max(requestedContext, 1024), v.RecommendedContext)
 kv := estimateKV(v.Parameters, context)
 overhead := max(int64(512*1024*1024), v.ExpectedBytes/5)
 requiredRAM := v.ExpectedBytes + kv + overhead + (v.ExpectedBytes+kv+overhead)/4
 requiredDisk := v.ExpectedBytes*2 + 512*1024*1024
 runtime := Runtime{Context: context, Batch: min(v.Runtime.Batch, 256), UBatch: min(v.Runtime.UBatch, 128), Threads: min(max(f.CPUCores, 1), max(v.Runtime.Threads, 1)), ReasoningFormat: v.Runtime.ReasoningFormat, ReasoningMode: v.Runtime.ReasoningMode}
 result := Assessment{Safe: true, RequiredRAM: requiredRAM, RequiredDisk: requiredDisk, Runtime: runtime}
 if requiredRAM > f.TotalRAM || requiredRAM > f.FreeRAM+v.ExpectedBytes { result.Safe, result.Code = override, "insufficient_memory" }
 if requiredDisk > f.FreeDisk { result.Safe, result.Code = false, "insufficient_storage" }
 return result
}
```

`ReadFacts` must read `/proc/meminfo`, `runtime.NumCPU`, `runtime.GOARCH`, and `syscall.Statfs` without shelling out.

- [ ] **Step 4: Run tests and static analysis**

Run:

```bash
cd homeassistant-addons/local-llama-cpp/manager
go test ./internal/hardware -v
go vet ./internal/hardware
```

Expected: PASS and no vet findings.

- [ ] **Step 5: Commit**

```bash
git add homeassistant-addons/local-llama-cpp/manager/internal/hardware
git commit -m "feat: score models against local hardware"
```

---

### Task 3: Atomic State Store and Restart Recovery

**Files:**

- Create: `homeassistant-addons/local-llama-cpp/manager/internal/state/store.go`
- Create: `homeassistant-addons/local-llama-cpp/manager/internal/state/store_test.go`

**Interfaces:**

- Produces: `state.Store.Load() (State, error)`
- Produces: `state.Store.Save(State) error`
- Produces: `state.Recovery(State, fileExists func(string) bool) Decision`
- Produces: `State.Begin`, `State.Transition`, `State.Succeed`, and `State.Fail`

- [ ] **Step 1: Write failing atomicity and recovery tests**

```go
func TestRecoveryRollsBackInterruptedActivation(t *testing.T) {
 s := State{Phase: "activating", Active: &Installed{ID: "candidate", Path: "/models/candidate.gguf"}, Fallback: &Installed{ID: "stable", Path: "/models/stable.gguf", Healthy: true}}
 d := Recovery(s, func(path string) bool { return path == "/models/stable.gguf" })
 if d.Action != "restore" || d.Model.ID != "stable" { t.Fatalf("unexpected: %#v", d) }
}

func TestSaveUsesAtomicRenameAnd0600(t *testing.T) {
 dir := t.TempDir()
 store := Store{Path: filepath.Join(dir, "state.json")}
 if err := store.Save(State{Phase: "idle"}); err != nil { t.Fatal(err) }
 info, err := os.Stat(store.Path)
 if err != nil || info.Mode().Perm() != 0o600 { t.Fatalf("mode=%v err=%v", info.Mode(), err) }
}
```

- [ ] **Step 2: Verify failure**

Run: `cd homeassistant-addons/local-llama-cpp/manager && go test ./internal/state -v`

Expected: FAIL because the store and recovery types do not exist.

- [ ] **Step 3: Implement explicit persisted state**

```go
type Installed struct { ID, Repo, File, Path string; Healthy bool; ActivatedAt time.Time }
type Operation struct { ID, VariantID, ModelPath, Phase string; BytesDone, BytesTotal int64; StartedAt time.Time; ErrorCode, ErrorMessage string }
type State struct { Version int; Phase string; Active, Fallback *Installed; Operation *Operation; Failed []Installed; CredentialConfigured bool }
type Store struct { Path string }
type Decision struct { Action string; Model *Installed; Degraded bool; Reason string }

func (s Store) Save(value State) error {
 value.Version = 1
 data, err := json.MarshalIndent(value, "", "  ")
 if err != nil { return err }
 if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil { return err }
 tmp := s.Path + ".tmp"
 if err := os.WriteFile(tmp, data, 0o600); err != nil { return err }
 if err := os.Chmod(tmp, 0o600); err != nil { return err }
 return os.Rename(tmp, s.Path)
}
```

`Load` must quarantine malformed JSON as `state.json.corrupt-<unix>` and return a degraded default. `Recovery` must restore fallback for `activating`, `probing`, or `rollback`; resume metadata for `downloading`; and select active only when its file exists and it is healthy.

- [ ] **Step 4: Run tests**

Run: `cd homeassistant-addons/local-llama-cpp/manager && go test ./internal/state -v`

Expected: PASS for every operation phase and missing/corrupt file case.

- [ ] **Step 5: Commit**

```bash
git add homeassistant-addons/local-llama-cpp/manager/internal/state
git commit -m "feat: persist model manager recovery state"
```

---

### Task 4: Resumable Hugging Face Downloader and GGUF Validation

**Files:**

- Create: `homeassistant-addons/local-llama-cpp/manager/internal/download/downloader.go`
- Create: `homeassistant-addons/local-llama-cpp/manager/internal/download/downloader_test.go`

**Interfaces:**

- Consumes: validated `catalog.Variant`
- Produces: `Downloader.Download(ctx, variant, token, progress) (Result, error)`
- Produces: typed `download.Error{Code, SafeMessage}`
- Produces: `download.ValidateGGUF(path string, expectedBytes int64) error`

- [ ] **Step 1: Write failing resumable and redaction tests**

```go
func TestDownloadResumesPartialFile(t *testing.T) {
 var rangeHeader string
 server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
  rangeHeader = r.Header.Get("Range")
  w.Header().Set("Content-Length", "4")
  w.WriteHeader(http.StatusPartialContent)
  _, _ = w.Write([]byte("GGUF"))
 }))
 defer server.Close()
 dir := t.TempDir()
 partial := filepath.Join(dir, "model.gguf.partial")
 if err := os.WriteFile(partial, []byte("GGUF0000"), 0o600); err != nil { t.Fatal(err) }
 d := Downloader{Client: server.Client(), ModelDir: dir, ResolveBase: server.URL}
 _, err := d.Download(context.Background(), catalog.Variant{Repo: "owner/repo", File: "model.gguf", ExpectedBytes: 12}, "hf_secret", func(Progress) {})
 if err != nil { t.Fatal(err) }
 if rangeHeader != "bytes=8-" { t.Fatalf("range=%q", rangeHeader) }
}

func TestDownloadErrorNeverContainsToken(t *testing.T) {
 err := SafeHTTPError(401, "https://huggingface.co/file?token=hf_secret", "hf_secret")
 if strings.Contains(err.Error(), "hf_secret") { t.Fatal("token leaked") }
}
```

- [ ] **Step 2: Verify failure**

Run: `cd homeassistant-addons/local-llama-cpp/manager && go test ./internal/download -v`

Expected: FAIL because downloader types do not exist.

- [ ] **Step 3: Implement bounded resumable download**

```go
type Progress struct { BytesDone, BytesTotal int64 }
type Result struct { Path string; Bytes int64 }
type Error struct { Code, SafeMessage string }
func (e *Error) Error() string { return e.SafeMessage }
type Downloader struct { Client *http.Client; ModelDir, ResolveBase string; MaxBytes int64 }

func (d Downloader) Download(ctx context.Context, v catalog.Variant, token string, progress func(Progress)) (Result, error) {
 partial := filepath.Join(d.ModelDir, v.File+".partial")
 final := filepath.Join(d.ModelDir, v.File)
 if err := os.MkdirAll(d.ModelDir, 0o700); err != nil { return Result{}, err }
 start := int64(0)
 if info, err := os.Stat(partial); err == nil { start = info.Size() }
 url := strings.TrimRight(d.ResolveBase, "/") + "/" + v.Repo + "/resolve/main/" + url.PathEscape(v.File)
 req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
 if err != nil { return Result{}, err }
 if start > 0 { req.Header.Set("Range", fmt.Sprintf("bytes=%d-", start)) }
 if token != "" { req.Header.Set("Authorization", "Bearer "+token) }
 resp, err := d.Client.Do(req)
 if err != nil { return Result{}, &Error{Code: "download_interrupted", SafeMessage: "Download interrupted; it can be resumed."} }
 defer resp.Body.Close()
 if resp.StatusCode == 401 || resp.StatusCode == 403 { return Result{}, &Error{Code: "authentication_required", SafeMessage: "Configure Hugging Face access and accept the model licence first."} }
 if resp.StatusCode != 200 && resp.StatusCode != 206 { return Result{}, &Error{Code: "repository_unavailable", SafeMessage: "The Hugging Face model file is unavailable."} }
 flags := os.O_CREATE | os.O_WRONLY
 if start > 0 && resp.StatusCode == 206 { flags |= os.O_APPEND } else { flags |= os.O_TRUNC; start = 0 }
 file, err := os.OpenFile(partial, flags, 0o600)
 if err != nil { return Result{}, err }
 defer file.Close()
 written, err := copyWithProgress(ctx, file, io.LimitReader(resp.Body, d.MaxBytes-start+1), start, v.ExpectedBytes, progress)
 if err != nil { return Result{}, err }
 if written != v.ExpectedBytes { return Result{}, &Error{Code: "size_mismatch", SafeMessage: "Downloaded model size did not match its catalog metadata."} }
 if err := ValidateGGUF(partial, v.ExpectedBytes); err != nil { return Result{}, err }
 if v.SHA256 != "" {
  if err := verifySHA256(partial, v.SHA256); err != nil { return Result{}, &Error{Code: "checksum_mismatch", SafeMessage: "Downloaded model checksum did not match its catalog metadata."} }
 }
 if err := os.Rename(partial, final); err != nil { return Result{}, err }
 return Result{Path: final, Bytes: written}, nil
}
```

`ValidateGGUF` must verify exact size and the first four bytes `GGUF`; `verifySHA256` streams the file through `sha256.New` and compares lowercase hex in constant time. The HTTP client must reject redirects outside `huggingface.co`, `hf.co`, and `cdn-lfs.huggingface.co`. Progress updates must be throttled to at most five per second.

- [ ] **Step 4: Run downloader and race tests**

Run:

```bash
cd homeassistant-addons/local-llama-cpp/manager
go test ./internal/download -v
go test -race ./internal/download
```

Expected: PASS; cancelled downloads leave `.partial`, invalid GGUFs do not become final files, and tokens never appear in errors.

- [ ] **Step 5: Commit**

```bash
git add homeassistant-addons/local-llama-cpp/manager/internal/download
git commit -m "feat: download and validate GGUF models safely"
```

---

### Task 5: llama-server Supervision, Probe, Rollback, and Retention

**Files:**

- Create: `homeassistant-addons/local-llama-cpp/manager/internal/runtime/supervisor.go`
- Create: `homeassistant-addons/local-llama-cpp/manager/internal/runtime/supervisor_test.go`

**Interfaces:**

- Consumes: `state.Store`, `state.State`, `catalog.Variant`, `hardware.Runtime`
- Produces: `Supervisor.Start(ctx, installed, runtime) error`
- Produces: `Supervisor.Activate(ctx, candidate, runtime) error`
- Produces: `Supervisor.ProxyTarget() *url.URL`
- Produces: `Supervisor.Prune(state.State) error`

- [ ] **Step 1: Write a failing rollback integration test**

```go
func TestActivateRestoresFallbackWhenCandidateProbeFails(t *testing.T) {
 launcher := newFakeLauncher(map[string]fakeBehavior{"stable.gguf": {Healthy: true, Answer: "ready"}, "broken.gguf": {Healthy: false}})
 store := state.Store{Path: filepath.Join(t.TempDir(), "state.json")}
 stable := state.Installed{ID: "stable", Path: filepath.Join(t.TempDir(), "stable.gguf"), Healthy: true}
 candidate := state.Installed{ID: "broken", Path: filepath.Join(t.TempDir(), "broken.gguf")}
 s := NewSupervisor(launcher, store, "http://127.0.0.1:8081")
 if err := s.Start(context.Background(), stable, hardware.Runtime{Context: 4096, Threads: 4}); err != nil { t.Fatal(err) }
 if err := s.Activate(context.Background(), candidate, hardware.Runtime{Context: 4096, Threads: 4}); err == nil { t.Fatal("expected probe failure") }
 if s.ActiveID() != "stable" || launcher.Starts("stable.gguf") != 2 { t.Fatalf("rollback failed: %#v", launcher) }
}
```

- [ ] **Step 2: Verify failure**

Run: `cd homeassistant-addons/local-llama-cpp/manager && go test ./internal/runtime -run TestActivateRestoresFallback -v`

Expected: FAIL because the supervisor does not exist.

- [ ] **Step 3: Implement process construction without shell interpolation**

```go
type Launcher interface { Start(context.Context, string, []string) (Process, error) }
type Process interface { Stop(time.Duration) error; Wait() error }
type Supervisor struct { mu sync.RWMutex; launcher Launcher; store state.Store; process Process; current *state.Installed; target *url.URL; probeClient *http.Client; modelDir string }

func llamaArgs(model state.Installed, r hardware.Runtime) []string {
 args := []string{"--model", model.Path, "--host", "127.0.0.1", "--port", "8081", "--ctx-size", strconv.Itoa(r.Context), "--threads", strconv.Itoa(r.Threads), "--threads-batch", strconv.Itoa(r.Threads), "--batch-size", strconv.Itoa(r.Batch), "--ubatch-size", strconv.Itoa(r.UBatch), "--cache-prompt", "--parallel", "1", "--jinja"}
 if r.ReasoningFormat != "" && r.ReasoningFormat != "none" { args = append(args, "--reasoning-format", r.ReasoningFormat) }
 if r.ReasoningMode != "" { args = append(args, "--reasoning", r.ReasoningMode) }
 return args
}
```

`Activate` must persist `activating`, gracefully stop the current process, start the candidate, wait up to 120 seconds for `/health`, POST a deterministic `max_tokens: 8`, `temperature: 0` completion, persist success, or transition to `rollback` and restart the fallback. It must not accept filesystem paths from API input; paths come only from validated installed records.

- [ ] **Step 4: Implement retention protection**

```go
func protectedPaths(s state.State) map[string]bool {
 paths := map[string]bool{}
 if s.Active != nil { paths[s.Active.Path] = true }
 if s.Fallback != nil { paths[s.Fallback.Path] = true }
 if s.Operation != nil && s.Operation.ModelPath != "" { paths[s.Operation.ModelPath] = true }
 return paths
}
```

`Prune` must delete only completed `.gguf` files not referenced by active, fallback, operation, or a resumable `.partial`; it must ignore symlinks and files outside the canonical model directory.

- [ ] **Step 5: Run runtime tests**

Run:

```bash
cd homeassistant-addons/local-llama-cpp/manager
go test ./internal/runtime -v
go test -race ./internal/runtime
```

Expected: PASS for successful activation, failed health, failed completion, stop timeout, rollback failure/degraded state, and retention protection.

- [ ] **Step 6: Commit**

```bash
git add homeassistant-addons/local-llama-cpp/manager/internal/runtime
git commit -m "feat: supervise llama server with automatic rollback"
```

---

### Task 6: Authenticated Manager API, Progress Events, and Inference Proxy

**Files:**

- Create: `homeassistant-addons/local-llama-cpp/manager/internal/api/server.go`
- Create: `homeassistant-addons/local-llama-cpp/manager/internal/api/server_test.go`
- Create: `homeassistant-addons/local-llama-cpp/manager/cmd/model-manager/main.go`

**Interfaces:**

- Consumes: catalog, hardware assessor, downloader, state store, runtime supervisor.
- Produces management routes under `/manager/v1` and transparent inference proxy for all other paths.

- [ ] **Step 1: Write failing auth, redaction, and proxy tests**

```go
func TestManagerRequiresCurrentOptionToken(t *testing.T) {
 server := NewServer(Dependencies{Token: func() string { return "secret" }})
 req := httptest.NewRequest(http.MethodGet, "/manager/v1/status", nil)
 response := httptest.NewRecorder()
 server.ServeHTTP(response, req)
 if response.Code != http.StatusUnauthorized { t.Fatalf("status=%d", response.Code) }
}

func TestInferencePathDoesNotRequireManagerToken(t *testing.T) {
 upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Content-Type", "application/json"); _, _ = w.Write([]byte(`{"ok":true}`)) }))
 defer upstream.Close()
 server := NewServer(Dependencies{InferenceURL: upstream.URL, Token: func() string { return "secret" }})
 response := httptest.NewRecorder()
 server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health", nil))
 if response.Code != 200 || response.Body.String() != `{"ok":true}` { t.Fatalf("%d %s", response.Code, response.Body.String()) }
}
```

- [ ] **Step 2: Verify failure**

Run: `cd homeassistant-addons/local-llama-cpp/manager && go test ./internal/api -v`

Expected: FAIL because `NewServer` does not exist.

- [ ] **Step 3: Implement routes and serialized operations**

```go
mux.HandleFunc("GET /manager/v1/status", authenticated(statusHandler))
mux.HandleFunc("GET /manager/v1/catalog", authenticated(catalogHandler))
mux.HandleFunc("POST /manager/v1/preflight", authenticated(preflightHandler))
mux.HandleFunc("POST /manager/v1/install", authenticated(installHandler))
mux.HandleFunc("POST /manager/v1/activate", authenticated(activateHandler))
mux.HandleFunc("POST /manager/v1/cancel", authenticated(cancelHandler))
mux.HandleFunc("DELETE /manager/v1/models/{id}", authenticated(removeHandler))
mux.HandleFunc("POST /manager/v1/catalog/custom", authenticated(customHandler))
mux.HandleFunc("PUT /manager/v1/credentials/huggingface", authenticated(credentialsHandler))
mux.HandleFunc("GET /manager/v1/events", authenticated(eventsHandler))
```

Authentication must compare `Authorization: Bearer <token>` with the latest `manager_token` from `/data/options.json` using `subtle.ConstantTimeCompare`. Mutations acquire a one-slot semaphore; competing mutations return HTTP 409 with code `operation_in_progress`. The inference `httputil.ReverseProxy` must set `FlushInterval = -1` so chat streaming is not buffered.

API errors use only:

```go
type APIError struct { Code string `json:"code"`; Message string `json:"message"`; Retryable bool `json:"retryable"` }
```

The event endpoint sends `event: operation` and JSON snapshots, a heartbeat every 15 seconds, and removes disconnected subscribers.

- [ ] **Step 4: Implement composition root and shutdown**

```go
func main() {
 ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
 defer stop()
 app, err := buildApplication("/data/options.json", "/data/model-manager/state.json", "/data/models", "/app/catalog.json", "/app/llama-server")
 if err != nil { log.Fatal(err) }
 if err := app.RecoverAndStart(ctx); err != nil { log.Printf("startup degraded: %v", err) }
 server := &http.Server{Addr: ":8080", Handler: app.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
 go func() { <-ctx.Done(); shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second); defer cancel(); _ = server.Shutdown(shutdown); app.Stop() }()
 if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) { log.Fatal(err) }
}
```

- [ ] **Step 5: Run API, race, and full manager tests**

Run:

```bash
cd homeassistant-addons/local-llama-cpp/manager
go test ./internal/api -v
go test -race ./...
go vet ./...
```

Expected: PASS; no race or vet findings; inference SSE arrives incrementally in the proxy test.

- [ ] **Step 6: Commit**

```bash
git add homeassistant-addons/local-llama-cpp/manager
git commit -m "feat: expose authenticated local model manager"
```

---

### Task 7: Package and Migrate the llama.cpp Add-on

**Files:**

- Modify: `homeassistant-addons/local-llama-cpp/Dockerfile`
- Modify: `homeassistant-addons/local-llama-cpp/config.yaml`
- Modify: `homeassistant-addons/local-llama-cpp/run.sh`
- Modify: `homeassistant-addons/local-llama-cpp/README.md`
- Create: `test/local-model-addon.test.mjs`

**Interfaces:**

- Produces: `/app/model-manager`, `/app/catalog.json`, `/app/llama-server` image paths.
- Produces options: `manager_token`, existing model options, runtime defaults.

- [ ] **Step 1: Write a failing packaging test**

```js
test("llama add-on launches the model manager and keeps the inference port", () => {
 const dockerfile = readFileSync("homeassistant-addons/local-llama-cpp/Dockerfile", "utf8");
 const run = readFileSync("homeassistant-addons/local-llama-cpp/run.sh", "utf8");
 const config = readFileSync("homeassistant-addons/local-llama-cpp/config.yaml", "utf8");
 assert.match(dockerfile, /go build .*model-manager/);
 assert.match(run, /exec \/app\/model-manager/);
 assert.match(config, /manager_token: password/);
 assert.match(config, /8080\/tcp: 8080/);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test test/local-model-addon.test.mjs`

Expected: FAIL because the image still executes `/app/llama-server` directly.

- [ ] **Step 3: Add a multi-stage static build**

```dockerfile
FROM golang:1.24-alpine AS manager-build
WORKDIR /src
COPY manager/go.mod ./
COPY manager/cmd ./cmd
COPY manager/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/model-manager ./cmd/model-manager

FROM ghcr.io/ggml-org/llama.cpp:server@sha256:6bc9134e3278a0ecab23d7ef2f6a46b4595740014fe9bc2f67e8ba7dca8395b4
COPY --from=manager-build /out/model-manager /app/model-manager
RUN cp /app/llama-server /app/llama-server.bin
COPY manager/internal/catalog/catalog.json /app/catalog.json
COPY run.sh /run.sh
RUN chmod 0755 /run.sh /app/model-manager /app/llama-server.bin
EXPOSE 8080
ENTRYPOINT ["/run.sh"]
```

The pinned multi-architecture digest above is llama.cpp build `b10015` (revision `12127defda4f41b7679cb2477a4b0d65ee6a0c8f`); its entrypoint executable is `/app/llama-server`. Copy it to `/app/llama-server.bin` before replacing the image entrypoint.

- [ ] **Step 4: Migrate startup without deleting the existing cache**

`run.sh` must create `/data/model-manager` and `/data/models`, convert an existing `hf_repo`/`hf_file` selection into a bootstrap candidate record when no manager state exists, set file permissions to `0700`, and execute:

```sh
exec /app/model-manager \
  --options /data/options.json \
  --state /data/model-manager/state.json \
  --models /data/models \
  --catalog /app/catalog.json \
  --llama /app/llama-server.bin
```

Do not parse JSON with `sed`; migration data is passed to the manager, which reads `options.json` with Go's JSON decoder.

- [ ] **Step 5: Update add-on configuration and docs**

Add `manager_token: ""` to options and `manager_token: password` to schema. Keep existing options for backward compatibility. Bump the add-on version from `1.7.0` to `1.8.0`. Document recovery behavior, last-two retention, the unchanged inference endpoint, and the fact that the token is paired by RemindMe.

- [ ] **Step 6: Run packaging tests and build ARM64 image**

Run:

```bash
node --test test/local-model-addon.test.mjs
docker build --platform linux/arm64 -t remindme-local-llama:1.8.0 homeassistant-addons/local-llama-cpp
```

Expected: tests PASS and Docker build completes with the static manager and llama server present.

- [ ] **Step 7: Commit**

```bash
git add homeassistant-addons/local-llama-cpp test/local-model-addon.test.mjs
git commit -m "feat: package managed llama cpp appliance"
```

---

### Task 8: RemindMe Manager Client and Automatic Pairing

**Files:**

- Create: `src/harness/modelManager.ts`
- Create: `test/model-manager.test.ts`
- Modify: `homeassistant-addons/discord-pi-bot/config.yaml`
- Modify: `homeassistant-addons/discord-pi-bot/run.sh`

**Interfaces:**

- Produces: `ModelManagerClient.request<T>(path, init?)`
- Produces: `ensureModelManagerPairing(dependencies) (Pairing, error)`
- Produces: `deriveManagerUrl(completionUrl string) string`

- [ ] **Step 1: Write failing URL, redaction, and pairing tests**

```ts
it("derives the manager root from the internal completion endpoint", () => {
 assert.equal(deriveManagerUrl("http://homeassistant:8080/v1/chat/completions"), "http://homeassistant:8080/manager/v1");
});

it("pairs by updating the discovered llama add-on without returning the token", async () => {
 let saved: unknown;
 const pairing = await ensureModelManagerPairing({
  secretPath: join(tempDir, "manager-token"),
  listAddons: async () => [{ slug: "local_local_llama_cpp", name: "Local llama.cpp" }],
  updateOptions: async (slug, options) => { saved = { slug, options }; },
  randomBytes: () => Buffer.alloc(32, 7),
 });
 assert.equal(pairing.addonSlug, "local_local_llama_cpp");
 assert.deepEqual(saved, { slug: "local_local_llama_cpp", options: { manager_token: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" } });
 assert.equal("token" in pairing, false);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --import tsx --test test/model-manager.test.ts`

Expected: FAIL because the client and pairing functions do not exist.

- [ ] **Step 3: Implement client and safe errors**

```ts
export function deriveManagerUrl(completionUrl: string): string {
 const url = new URL(completionUrl);
 if (url.protocol !== "http:" || !["homeassistant", "localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Model manager must use the internal add-on network");
 url.pathname = "/manager/v1";
 url.search = "";
 return url.toString().replace(/\/$/, "");
}

export class ModelManagerClient {
 constructor(private readonly baseUrl: string, private readonly token: () => Promise<string>) {}
 async request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const secret = await this.token();
  const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, ...init.headers }, signal: AbortSignal.timeout(130_000) });
  const body = await response.json().catch(() => ({ code: "manager_unavailable", message: "Local model manager is unavailable." }));
  if (!response.ok) throw new ModelManagerError(String(body.code || "manager_error"), String(body.message || "Local model operation failed."), response.status);
  return body as T;
 }
}
```

`ensureModelManagerPairing` must create a 32-byte URL-safe random secret with mode `0600`, discover an add-on whose slug is `local_llama_cpp` or ends in `_local_llama_cpp`, and update only its `manager_token` option through Supervisor. It returns only `{addonSlug, configured: true}`.

- [ ] **Step 4: Enable the minimum add-on permission and environment**

Add `hassio_api: true`, `model_manager_enabled: true`, and `model_manager_url: http://homeassistant:8080/manager/v1` to RemindMe add-on config/schema. `run.sh` exports `MODEL_MANAGER_ENABLED`, `MODEL_MANAGER_URL`, and `MODEL_MANAGER_TOKEN_PATH=/data/model-manager-token`. Do not add a user-visible token option to RemindMe.

- [ ] **Step 5: Run tests and diagnostics**

Run:

```bash
node --import tsx --test test/model-manager.test.ts
./node_modules/.bin/tsc --noEmit
```

Expected: PASS and no TypeScript diagnostics.

- [ ] **Step 6: Commit**

```bash
git add src/harness/modelManager.ts test/model-manager.test.ts homeassistant-addons/discord-pi-bot/config.yaml homeassistant-addons/discord-pi-bot/run.sh
git commit -m "feat: pair RemindMe with local model manager"
```

---

### Task 9: RemindMe Model Management Routes and Progress Relay

**Files:**

- Modify: `src/harness-server.ts`
- Modify: `src/harness/settings.ts`
- Modify: `test/settings.test.ts`
- Create: `test/model-manager-routes.test.ts`

**Interfaces:**

- Consumes: `ModelManagerClient`
- Produces: `/api/models`, `/api/models/status`, `/api/models/preflight`, `/api/models/install`, `/api/models/activate`, `/api/models/cancel`, `/api/models/:id`, `/api/models/custom`, `/api/models/credentials`, and `/api/models/events`.

- [ ] **Step 1: Write failing route and redaction tests**

```ts
it("returns catalog without credentials", async () => {
 const response = await request(app).get("/api/models");
 assert.equal(response.status, 200);
 assert.equal(JSON.stringify(response.body).includes("hf_secret"), false);
});

it("accepts a Hugging Face token without echoing it", async () => {
 const response = await request(app).put("/api/models/credentials").send({ token: "hf_secret" });
 assert.equal(response.status, 200);
 assert.deepEqual(response.body, { configured: true });
 assert.equal(JSON.stringify(response.body).includes("hf_secret"), false);
});
```

Use the project's existing Express app test pattern rather than introducing Supertest if it is not already installed; start `createHarnessApp()` on an ephemeral port and use `fetch`.

- [ ] **Step 2: Verify failure**

Run: `node --import tsx --test test/model-manager-routes.test.ts test/settings.test.ts`

Expected: FAIL with 404 for model routes.

- [ ] **Step 3: Add thin validated proxy routes**

```ts
app.get("/api/models", async (_request, response) => proxyManager(response, "/catalog"));
app.get("/api/models/status", async (_request, response) => proxyManager(response, "/status"));
app.post("/api/models/preflight", async (request, response) => proxyManager(response, "/preflight", "POST", pickModelSelection(request.body)));
app.post("/api/models/install", async (request, response) => proxyManager(response, "/install", "POST", pickModelSelection(request.body)));
app.post("/api/models/activate", async (request, response) => proxyManager(response, "/activate", "POST", pickModelSelection(request.body)));
app.post("/api/models/cancel", async (_request, response) => proxyManager(response, "/cancel", "POST", {}));
app.delete("/api/models/:id", async (request, response) => proxyManager(response, `/models/${encodeURIComponent(validateModelId(request.params.id))}`, "DELETE"));
app.post("/api/models/custom", async (request, response) => proxyManager(response, "/catalog/custom", "POST", validateCustomInput(request.body)));
app.put("/api/models/credentials", async (request, response) => {
 const token = typeof request.body?.token === "string" ? request.body.token.trim() : "";
 if (!/^hf_[A-Za-z0-9]{20,}$/.test(token)) return response.status(400).json({ code: "invalid_token", message: "Enter a valid Hugging Face access token." });
 await manager.request("/credentials/huggingface", { method: "PUT", body: JSON.stringify({ token }) });
 response.json({ configured: true });
});
```

The credential regex is format validation only and must not log the body. `proxyManager` maps typed manager errors to the original safe status/code/message and maps network failures to HTTP 503.

- [ ] **Step 4: Relay SSE with disconnect cancellation**

`/api/models/events` must set `text/event-stream`, open the upstream manager event request with the server-side bearer token, pipe bytes without parsing, abort upstream when the browser disconnects, and send no-store headers. It must not accept query-string credentials.

- [ ] **Step 5: Extend public settings safely**

`publicSettings` may expose `modelManagerEnabled` and `huggingFaceConfigured`; it must never expose the manager token path, token value, Hugging Face token, or Supervisor token. Extend the existing redaction test with all four forbidden strings.

- [ ] **Step 6: Run route, settings, and TypeScript tests**

Run:

```bash
node --import tsx --test test/model-manager-routes.test.ts test/settings.test.ts
./node_modules/.bin/tsc --noEmit
```

Expected: PASS with no secret values in JSON or SSE.

- [ ] **Step 7: Commit**

```bash
git add src/harness-server.ts src/harness/settings.ts test/model-manager-routes.test.ts test/settings.test.ts
git commit -m "feat: proxy safe model management routes"
```

---

### Task 10: Hardware Cookbook Catalog UI

**Files:**

- Create: `public/components/model-cookbook.js`
- Modify: `public/app.js`
- Modify: `public/harness.html`
- Modify: `public/styles.css`
- Modify: `test/harness-markup.test.mjs`

**Interfaces:**

- Produces: `window.RemindMeModelCookbook` with `state`, `load`, `install`, `activate`, `cancel`, `remove`, `saveToken`, and `saveCustom`.
- Consumes: safe `/api/models*` routes only.

- [ ] **Step 1: Write failing semantic and secret-handling tests**

```js
test("hardware cookbook exposes model lifecycle controls", () => {
 assert.match(html, /data-model-catalog/);
 assert.match(html, /@click="installModel\(variant.id\)"/);
 assert.match(html, /@click="cancelModelOperation\(\)"/);
 assert.match(html, /type="password"[^>]*autocomplete="off"/);
 assert.match(html, /components\/model-cookbook\.js/);
});

test("model cards remain contained at narrow widths", () => {
 assert.match(css, /\.model-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*18rem\),\s*1fr\)\)/s);
 assert.match(css, /\.model-card\s*\{[^}]*min-width:\s*0/s);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test test/harness-markup.test.mjs`

Expected: FAIL because the catalog component and controls are absent.

- [ ] **Step 3: Implement a focused browser component**

```js
window.RemindMeModelCookbook = {
 state() { return { modelCatalog: [], modelStatus: null, modelOperation: null, modelError: "", hfToken: "", customModel: { repo: "", file: "" }, modelEvents: null }; },
 async load(vm) {
  const [catalog, status] = await Promise.all([fetch("./api/models").then(readJson), fetch("./api/models/status").then(readJson)]);
  vm.modelCatalog = catalog.variants || [];
  vm.modelStatus = status;
  this.connect(vm);
 },
 connect(vm) {
  vm.modelEvents?.close();
  const source = new EventSource("./api/models/events");
  source.addEventListener("operation", (event) => { vm.modelOperation = JSON.parse(event.data); if (["active", "failed", "degraded"].includes(vm.modelOperation.phase)) this.loadStatus(vm); });
  source.onerror = () => { vm.modelError = "Model progress connection interrupted; operation recovery remains active on the server."; };
  vm.modelEvents = source;
 },
 async mutate(vm, path, body) {
  vm.modelError = "";
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await readJson(response);
  if (!response.ok) { vm.modelError = result.message || "Model operation failed."; return; }
  vm.modelOperation = result.operation || result;
 },
 install(vm, id) { return this.mutate(vm, "./api/models/install", { id }); },
 activate(vm, id) { return this.mutate(vm, "./api/models/activate", { id }); },
 cancel(vm) { return this.mutate(vm, "./api/models/cancel", {}); },
};
```

`readJson` must handle non-JSON failures without showing raw response bodies. `saveToken` clears `vm.hfToken` in a `finally` block. `saveCustom` accepts only repository and filename fields.

- [ ] **Step 4: Integrate Alpine state and methods**

Load `components/model-cookbook.js` before `app.js`. Spread `window.RemindMeModelCookbook.state()` into `harness()`. Add wrapper methods `installModel`, `activateModel`, `cancelModelOperation`, `removeModel`, `saveHuggingFaceToken`, and `saveCustomModel`. Call `load(this)` during initialization only when `modelManagerEnabled` is true.

- [ ] **Step 5: Replace the static cookbook body with catalog UI**

The HTML must include:

- Active model, health, and fallback.
- Compatibility badges and warnings.
- Grouped model cards and quantization labels.
- Memory, disk, context, source, tier, and capabilities.
- Install/activate/remove actions disabled during a mutating operation.
- One progress bar with byte counts and current phase.
- Password token field with configured/not-configured state.
- Advanced custom repo/file form.
- `aria-live="polite"` operation status and `role="alert"` safe errors.

Do not place any token into `x-data`, localStorage, URL query parameters, or rendered status text.

- [ ] **Step 6: Add contained responsive styling**

Use the existing Lucky 38 variables and typography. Cards use the required auto-fit grid, `min-width: 0`, `overflow-wrap: anywhere`, and no fixed heights. Progress animation must respect the existing `prefers-reduced-motion` rules.

- [ ] **Step 7: Run frontend tests and browser syntax checks**

Run:

```bash
node --test test/harness-markup.test.mjs test/harness-assets.test.mjs
node --check public/components/model-cookbook.js
node --check public/app.js
```

Expected: PASS; every new local asset has JavaScript MIME type and unknown assets still return non-HTML 404.

- [ ] **Step 8: Commit**

```bash
git add public/components/model-cookbook.js public/app.js public/harness.html public/styles.css test/harness-markup.test.mjs
git commit -m "feat: add hardware aware model cookbook UI"
```

---

### Task 11: Model Capability Refresh and Response Attribution

**Files:**

- Modify: `src/harness/modelPhases.ts`
- Modify: `src/harness-server.ts`
- Modify: `test/model-phases.test.ts`
- Modify: `public/components/timeline.js`
- Modify: `public/harness.html`

**Interfaces:**

- Produces: `PhaseMetrics.modelId?: string` and `PhaseMetrics.modelName?: string`.
- Consumes manager active-model capabilities for `/api/status` and thinking-profile selection.

- [ ] **Step 1: Write a failing model attribution test**

```ts
it("phase metrics retain the generating model", () => {
 const metrics = normalizePhaseMetrics({ usage: { prompt_tokens: 10, completion_tokens: 4 }, timings: {} }, { modelId: "qwen3-4b-q4", modelName: "Qwen3 4B Q4_K_M" });
 assert.equal(metrics.modelId, "qwen3-4b-q4");
 assert.equal(metrics.modelName, "Qwen3 4B Q4_K_M");
});
```

- [ ] **Step 2: Verify failure**

Run: `node --import tsx --test test/model-phases.test.ts`

Expected: FAIL because normalized metrics do not accept model metadata.

- [ ] **Step 3: Add model metadata to completed phases**

```ts
export interface ActiveModelMetadata { modelId?: string; modelName?: string }

export function normalizePhaseMetrics(payload: unknown, model: ActiveModelMetadata = {}): PhaseMetrics {
 const normalized = normalizeExistingMetrics(payload);
 return { ...normalized, modelId: model.modelId, modelName: model.modelName };
}
```

At the start of each agent request, read the current manager status once and pass that immutable model snapshot through each phase. Do not query status after generation because activation could occur between completion and metrics emission.

- [ ] **Step 4: Refresh runtime capabilities after activation**

`/api/status` must prefer the manager's active ID/name/context/capabilities and fall back to existing environment values when the manager is unavailable. Expose vision only when the active model reports `vision` and the later vision runtime is actually configured; a vision-capable text-only activation must leave attachments disabled.

- [ ] **Step 5: Render response attribution**

Add a compact response metric chip using `message.metrics.modelName` or `message.metrics.modelId`. It must remain optional so historical messages without model metadata still render.

- [ ] **Step 6: Run tests**

Run:

```bash
node --import tsx --test test/model-phases.test.ts test/thinking-profiles.test.ts
node --test test/timeline-state.test.mjs test/harness-markup.test.mjs
./node_modules/.bin/tsc --noEmit
```

Expected: PASS; switching models changes only new response attribution and available thinking profiles.

- [ ] **Step 7: Commit**

```bash
git add src/harness/modelPhases.ts src/harness-server.ts test/model-phases.test.ts public/components/timeline.js public/harness.html
git commit -m "feat: attribute responses to active local model"
```

---

### Task 12: Full Integration, Security Gate, Mirroring, and Release

**Files:**

- Modify: `homeassistant-addons/local-llama-cpp/README.md`
- Modify: `homeassistant-addons/discord-pi-bot/README.md`
- Modify: `README.md`
- Modify: `homeassistant-addons/discord-pi-bot/config.yaml`
- Mirror: root `src/` and `public/` into `homeassistant-addons/discord-pi-bot/`
- Create: `test/model-manager-integration.test.ts`

**Interfaces:**

- Verifies the complete download → verify → activate → probe → rollback path.

- [ ] **Step 1: Write the end-to-end fake-service test**

The test must start:

- A fake Hugging Face server supporting `HEAD`, full GET, ranged GET, gated 403, and interrupted transfer.
- A fake llama executable that can become healthy, fail health, or fail deterministic completion based on model filename.
- The model manager on an ephemeral port.
- The RemindMe app pointed at that manager.

The primary test asserts:

```ts
assert.equal(await activeModel(), "stable");
await install("broken");
await waitForPhase("active");
assert.equal(await activeModel(), "stable");
assert.equal((await managerStatus()).lastError.code, "activation_failed_rolled_back");
assert.equal((await listInstalled()).filter((model) => model.protected).length, 2);
```

- [ ] **Step 2: Run the integration test and verify failure before final wiring**

Run: `node --import tsx --test test/model-manager-integration.test.ts`

Expected: FAIL until all process paths, event relays, and state transitions are wired together.

- [ ] **Step 3: Complete only the wiring exposed by the integration test**

Fix exact endpoint paths, child executable arguments, operation event transitions, and test dependency injection. Do not add STT, TTS, image inference, cloud routing, model benchmarks, or multiple loaded servers.

- [ ] **Step 4: Mirror verified source and public assets**

```bash
rm -rf homeassistant-addons/discord-pi-bot/src homeassistant-addons/discord-pi-bot/public
cp -R src homeassistant-addons/discord-pi-bot/src
cp -R public homeassistant-addons/discord-pi-bot/public
```

Verify `diff -qr src homeassistant-addons/discord-pi-bot/src` and `diff -qr public homeassistant-addons/discord-pi-bot/public` both produce no output.

- [ ] **Step 5: Bump and document releases**

Set the RemindMe add-on version to `2.2.0` and retain the llama.cpp add-on version `1.8.0`. Document:

- Installation and automatic pairing.
- Curated versus custom trust levels.
- Hugging Face token/licence flow.
- Last-two retention.
- Download resume.
- Forced rollback recovery.
- Pi 5 8 GB recommended choices.
- Explicit non-support for vision execution, STT, TTS, and cloud composition in this release.

- [ ] **Step 6: Run the complete verification gate**

Run:

```bash
cd homeassistant-addons/local-llama-cpp/manager && go test -race ./... && go vet ./...
cd ../../../..
./node_modules/.bin/tsc --noEmit
node --test test/*.test.mjs
node --import tsx --test test/*.test.ts
node --check public/app.js
node --check public/components/model-cookbook.js
sh -n homeassistant-addons/local-llama-cpp/run.sh
sh -n homeassistant-addons/discord-pi-bot/run.sh
docker build --platform linux/arm64 -t remindme-local-llama:1.8.0 homeassistant-addons/local-llama-cpp
docker build --platform linux/arm64 -t remindme-discord-bot:2.2.0 homeassistant-addons/discord-pi-bot
```

Expected: every command exits 0.

- [ ] **Step 7: Scan changed content for credentials**

Run a targeted secret scan over the final diff. Expected: no Discord, Supervisor, Home Assistant, Hugging Face, Exa, GitHub, Tailscale, or manager credentials. Test-only values must be visibly fake, such as `hf_test_secret`.

- [ ] **Step 8: Perform manual Pi acceptance before promoting tiers**

On the Raspberry Pi 5 8 GB, test MiniCPM5-1B Q4, Qwen3-1.7B Q8, and Qwen3-4B Q4. Record cold start, warm decode speed, peak free RAM, tool-call success, Fast/no-thinking behavior, bounded reasoning, resumed download, switch duration, and forced rollback. Keep MiniCPM and Qwen 4B at `compatible` until this evidence passes; then update their catalog tier to `recommended` in a separate evidence-backed commit.

- [ ] **Step 9: Commit the release**

```bash
git add README.md homeassistant-addons src public test
git commit -m "feat: release hardware aware local model cookbook"
```

---

## Final Acceptance Checklist

- [ ] Existing chat remains usable during model download and verification.
- [ ] Inference remains available through `homeassistant:8080`.
- [ ] Candidate activation is serialized and non-cancellable after shutdown begins.
- [ ] A failed health or completion probe restores the previous model automatically.
- [ ] Restart during every persisted phase produces a deterministic recovery action.
- [ ] Active and fallback models cannot be removed or pruned.
- [ ] Partial downloads resume and invalid GGUFs never become active.
- [ ] Browser state, API responses, logs, and repository files contain no credentials.
- [ ] Custom entries cannot escape Hugging Face or the model directory.
- [ ] Response metrics identify the model used at request start.
- [ ] Pi validation evidence exists before experimental/compatible tiers are promoted.
