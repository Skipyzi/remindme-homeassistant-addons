# Model Disk Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RemindMe discover and safely remove actual GGUF files stored by the llama.cpp add-on, even when catalog metadata says they are only available.

**Architecture:** Add a bounded, symlink-safe inventory package and authenticated inventory endpoints to the Go model manager. Proxy those endpoints through the RemindMe server and render a separate physical-file inventory in the Models view; browser requests use opaque IDs, never paths.

**Tech Stack:** Go 1.24 standard library, Node.js/TypeScript, Express 5, browser JavaScript with Alpine.js, Node test runner, pnpm, Home Assistant add-on packaging.

## Global Constraints

- Scan only `/data/models` and `/data/.cache`.
- Never follow symlinks or expose absolute paths.
- Inventory only case-insensitive `.gguf` files; do not manage `.partial` files in this iteration.
- Keep invalid GGUF files visible and removable.
- Deletion accepts only a freshly resolved opaque inventory ID.
- Active and in-progress models cannot be removed.
- Existing install, activate, catalog removal, YAML, credentials, pairing, SSE, and inference behavior must remain compatible.
- Do not add a bulk cache purge or a separate Local LLM sidebar UI.
- Use pnpm, not npm, for Node commands.

---

## File Structure

### Create

- `local-llama-cpp/manager/internal/inventory/inventory.go` — bounded physical-file scanning, classification, safe opaque IDs, and GGUF header checks.
- `local-llama-cpp/manager/internal/inventory/inventory_test.go` — scan bounds, source classification, duplicate names, invalid files, and symlink behavior.

### Modify

- `local-llama-cpp/manager/internal/api/server.go` — authenticated inventory routes, catalog matching, active/operation protection, and deletion.
- `local-llama-cpp/manager/internal/api/server_test.go` — endpoint security, response privacy, deletion, and protection tests.
- `local-llama-cpp/manager/cmd/model-manager/main.go` — inject `/data/.cache` as the legacy inventory root.
- `local-llama-cpp/config.yaml` — add-on version bump.
- `local-llama-cpp/README.md` — document physical inventory and safe removal.
- `discord-pi-bot/src/harness-server.ts` — server-side inventory proxies and ID validation.
- `discord-pi-bot/test/model-manager-routes.test.ts` — proxy/auth/error tests.
- `discord-pi-bot/public/components/model-cookbook.js` — inventory state, load, remove, confirmation, and refresh behavior.
- `discord-pi-bot/public/app.js` — Alpine wrapper methods.
- `discord-pi-bot/public/harness.html` — Downloaded models section.
- `discord-pi-bot/public/styles.css` — responsive inventory rows and states.
- `discord-pi-bot/test/model-cookbook-markup.test.mjs` — static browser-contract tests.
- `discord-pi-bot/config.yaml` — RemindMe add-on version bump.

---

### Task 1: Build the bounded physical inventory scanner

**Files:**

- Create: `local-llama-cpp/manager/internal/inventory/inventory.go`
- Create: `local-llama-cpp/manager/internal/inventory/inventory_test.go`

**Interfaces:**

- Consumes: fixed caller-provided `Root` values.
- Produces: `Scanner.Scan() (Result, error)`, `Item` records with private `Path`, and `Scanner.Resolve(id string) (Item, error)`.

- [ ] **Step 1: Write failing scanner tests**

Create table-driven tests with real temporary directories. The core assertions must use this shape:

```go
func TestScanFindsManagedAndLegacyGGUFWithoutLeakingPaths(t *testing.T) {
 base := t.TempDir()
 models := filepath.Join(base, "models")
 cache := filepath.Join(base, ".cache", "llama.cpp")
 for _, path := range []string{models, cache} {
  if err := os.MkdirAll(path, 0o700); err != nil { t.Fatal(err) }
 }
 managed := filepath.Join(models, "known.gguf")
 legacy := filepath.Join(cache, "old.gguf")
 if err := os.WriteFile(managed, []byte("GGUFmanaged"), 0o600); err != nil { t.Fatal(err) }
 if err := os.WriteFile(legacy, []byte("GGUFlegacy"), 0o600); err != nil { t.Fatal(err) }

 result, err := (Scanner{Roots: []Root{
  {Path: models, Source: SourceManaged},
  {Path: filepath.Join(base, ".cache"), Source: SourceLegacyCache},
 }}).Scan()
 if err != nil { t.Fatal(err) }
 if len(result.Items) != 2 { t.Fatalf("items = %d", len(result.Items)) }
 encoded, err := json.Marshal(result)
 if err != nil { t.Fatal(err) }
 if bytes.Contains(encoded, []byte(base)) { t.Fatalf("response leaked path: %s", encoded) }
}
```

Also add named tests for:

```go
func TestScanListsInvalidGGUFButIgnoresPartialAndUnrelatedFiles(t *testing.T)
func TestScanAssignsDifferentIDsToDuplicateBasenames(t *testing.T)
func TestScanDoesNotFollowFileOrDirectorySymlinks(t *testing.T)
func TestScanStopsAtDepthAndEntryBounds(t *testing.T)
func TestResolveReturnsOnlyCurrentApprovedRegularFiles(t *testing.T)
```

Use `t.Skip("symlink creation is unavailable")` only when `os.Symlink` itself fails on Windows.

- [ ] **Step 2: Run tests and verify the missing package failure**

Run:

```bash
cd local-llama-cpp/manager
go test ./internal/inventory -run TestScan -v
```

Expected: FAIL because `internal/inventory` and its types do not exist.

- [ ] **Step 3: Implement the scanner**

Define these public contracts exactly:

```go
package inventory

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

var ErrNotFound = errors.New("inventory item not found")

func (scanner Scanner) Scan() (Result, error)
func (scanner Scanner) Resolve(id string) (Item, error)
```

Implementation requirements:

```go
func opaqueID(source Source, relative string) string {
 sum := sha256.Sum256([]byte(string(source) + "\x00" + filepath.ToSlash(relative)))
 return hex.EncodeToString(sum[:16])
}

func validGGUF(path string) bool {
 file, err := os.Open(path)
 if err != nil { return false }
 defer file.Close()
 var header [4]byte
 _, err = io.ReadFull(file, header[:])
 return err == nil && string(header[:]) == "GGUF"
}
```

During `filepath.WalkDir`:

- canonicalize each configured root once;
- count visited entries and return an error when the configured bound is exceeded;
- skip symlink entries, including symlinked directories;
- skip entries deeper than `MaxDepth` with `filepath.SkipDir` for directories;
- accept regular files ending in `.gguf` using `strings.EqualFold(filepath.Ext(name), ".gguf")`;
- sort results by `Source`, then case-folded `Name`, then `ID`;
- represent an absent/unreadable root as a root-scoped warning when another root can still be scanned;
- return a scan error when no approved root can be inspected.

`Resolve` must perform a fresh `Scan`, match the exact 32-character lowercase hexadecimal ID, then re-check `Lstat`, regular-file status, canonical root containment, and symlink-free path components before returning the private `Path`.

- [ ] **Step 4: Run inventory tests**

Run:

```bash
cd local-llama-cpp/manager
go test ./internal/inventory -v
```

Expected: PASS, including bound and symlink tests.

- [ ] **Step 5: Commit the scanner**

```bash
git add local-llama-cpp/manager/internal/inventory
git commit -m "feat(models): inventory GGUF files on disk"
```

---

### Task 2: Expose authenticated inventory and safe deletion

**Files:**

- Modify: `local-llama-cpp/manager/internal/api/server.go`
- Modify: `local-llama-cpp/manager/internal/api/server_test.go`
- Modify: `local-llama-cpp/manager/cmd/model-manager/main.go`

**Interfaces:**

- Consumes: `inventory.Scanner`, catalog variants, and `ModelSupervisor.State()`.
- Produces: `GET /manager/v1/models/inventory` and `DELETE /manager/v1/models/inventory/{inventoryId}`.

- [ ] **Step 1: Write failing API tests**

Add tests using separate temporary model and cache roots:

```go
func TestInventoryListsPhysicalFilesWithoutPaths(t *testing.T) {
 dependencies := testDependencies(t, "http://127.0.0.1:8081")
 cacheDir := t.TempDir()
 dependencies.CacheDir = cacheDir
 writeGGUF(t, filepath.Join(dependencies.ModelDir, "test.gguf"))
 writeGGUF(t, filepath.Join(cacheDir, "legacy.gguf"))
 server := NewServer(dependencies)

 request := httptest.NewRequest(http.MethodGet, "/manager/v1/models/inventory", nil)
 request.Header.Set("Authorization", "Bearer manager-secret")
 response := httptest.NewRecorder()
 server.ServeHTTP(response, request)
 if response.Code != http.StatusOK { t.Fatalf("status = %d: %s", response.Code, response.Body.String()) }
 if strings.Contains(response.Body.String(), dependencies.ModelDir) || strings.Contains(response.Body.String(), cacheDir) {
  t.Fatalf("inventory leaked a path: %s", response.Body.String())
 }
}
```

Add explicit tests:

```go
func TestInventoryMarksCatalogMatchAndActiveProtection(t *testing.T)
func TestInventoryDeleteRemovesUnknownManagedFile(t *testing.T)
func TestInventoryDeleteRemovesLegacyCacheFile(t *testing.T)
func TestInventoryDeleteRejectsActiveAndInProgressFiles(t *testing.T)
func TestInventoryDeleteConflictsWithConcurrentMutation(t *testing.T)
func TestInventoryDeleteRejectsInvalidOrUnknownID(t *testing.T)
func TestInventoryDeleteClearsMatchingVerificationRecord(t *testing.T)
func TestInventoryRoutesRequireAuthentication(t *testing.T)
```

Helper signatures:

```go
func writeGGUF(t *testing.T, path string)
func inventoryID(t *testing.T, server http.Handler, name string) string
```

- [ ] **Step 2: Run focused API tests and verify failure**

```bash
cd local-llama-cpp/manager
go test ./internal/api -run Inventory -v
```

Expected: FAIL because `Dependencies.CacheDir` and the inventory routes do not exist.

- [ ] **Step 3: Wire inventory dependencies and routes**

Add to `Dependencies`:

```go
CacheDir string
```

Construct one scanner inside `NewServer` from fixed roots:

```go
scanner := inventory.Scanner{Roots: []inventory.Root{
 {Path: dependencies.ModelDir, Source: inventory.SourceManaged},
 {Path: dependencies.CacheDir, Source: inventory.SourceLegacyCache},
}}
```

Store it on `Server` as `inventory inventory.Scanner`, then register:

```go
server.manager.Handle("GET /manager/v1/models/inventory", server.auth(http.HandlerFunc(server.listInventory)))
server.manager.Handle("DELETE /manager/v1/models/inventory/{id}", server.auth(http.HandlerFunc(server.removeInventoryItem)))
```

Inject the cache root in `main.go`:

```go
CacheDir: filepath.Join(filepath.Dir(configured.models), ".cache"),
```

- [ ] **Step 4: Implement response enrichment and deletion**

Use API-only response types so private filesystem paths cannot marshal:

```go
type inventoryItemResponse struct {
 ID         string           `json:"id"`
 Name       string           `json:"name"`
 Size       int64            `json:"size"`
 Modified   time.Time        `json:"modified"`
 Source     inventory.Source `json:"source"`
 ValidGGUF  bool             `json:"validGguf"`
 CatalogID  string           `json:"catalogId,omitempty"`
 Active     bool             `json:"active"`
 InProgress bool             `json:"inProgress"`
 Removable  bool             `json:"removable"`
}
```

`listInventory` must:

1. call `server.inventory.Scan()`;
2. snapshot catalog under `catalogMu.RLock()`;
3. map catalog IDs only when exactly one variant filename equals the inventory basename;
4. compare canonical file paths with `State().Active.Path` and `State().Operation.ModelPath` (also protect the operation's final `.gguf` path when its stored path ends in `.partial`);
5. return `{items, warnings}` with `Cache-Control: no-store`.

`removeInventoryItem` must:

```go
id := request.PathValue("id")
if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(id) {
 writeError(response, http.StatusBadRequest, APIError{Code: "invalid_inventory_target", Message: "Inventory item is invalid."})
 return
}
item, err := server.inventory.Resolve(id)
```

Acquire the existing mutation guard before resolution so activation or installation cannot race deletion:

```go
if !server.beginMutation(response) { return }
defer server.endMutation()
```

After resolution, recompute protection from a fresh state snapshot. Return `409 model_protected` for active/in-progress targets. Call `os.Remove(item.Path)` only after those checks. Treat `os.ErrNotExist` after resolution as success. For an unambiguous catalog match, remove its verification record after unlinking. Return `204 No Content`.

Map scan/resolve errors to the exact safe codes from the design: `inventory_scan_failed`, `inventory_item_not_found`, `invalid_inventory_target`, `model_protected`, and `remove_failed`.

- [ ] **Step 5: Run manager tests**

```bash
cd local-llama-cpp/manager
go test ./... -count=1
```

Expected: all manager packages PASS; existing removal and activation tests remain green.

- [ ] **Step 6: Commit manager endpoints**

```bash
git add local-llama-cpp/manager/cmd/model-manager/main.go \
  local-llama-cpp/manager/internal/api/server.go \
  local-llama-cpp/manager/internal/api/server_test.go
git commit -m "feat(models): expose safe disk inventory"
```

---

### Task 3: Proxy inventory through the RemindMe server

**Files:**

- Modify: `discord-pi-bot/src/harness-server.ts`
- Modify: `discord-pi-bot/test/model-manager-routes.test.ts`

**Interfaces:**

- Consumes: manager inventory endpoints and existing `proxyModelManager` authentication/error mapping.
- Produces: browser-safe `GET /api/models/inventory` and `DELETE /api/models/inventory/:id`.

- [ ] **Step 1: Extend the route test's fake manager**

Add fake responses and captured authorization:

```ts
const inventory = {
 items: [{
  id: "0123456789abcdef0123456789abcdef",
  name: "old.gguf",
  size: 4096,
  modified: "2026-07-28T10:00:00Z",
  source: "legacy_cache",
  validGguf: true,
  active: false,
  inProgress: false,
  removable: true,
 }],
};
let inventoryAuthorization = "";
let deletedInventoryID = "";
```

Handle upstream GET and DELETE paths, then assert:

```ts
const listed = await nativeFetch(`${baseUrl}/api/models/inventory`);
assert.deepEqual(await listed.json(), inventory);
assert.equal(inventoryAuthorization, `Bearer ${pairedToken}`);

const removed = await nativeFetch(
 `${baseUrl}/api/models/inventory/0123456789abcdef0123456789abcdef`,
 { method: "DELETE" },
);
assert.equal(removed.status, 204);
assert.equal(deletedInventoryID, "0123456789abcdef0123456789abcdef");
```

Also assert a non-hex ID returns `400 invalid_inventory_target` without upstream access.

- [ ] **Step 2: Run route test and verify failure**

```bash
cd discord-pi-bot
pnpm exec node --import tsx --test test/model-manager-routes.test.ts
```

Expected: FAIL with 404 for `/api/models/inventory`.

- [ ] **Step 3: Add specific routes before the generic `/:id` route**

Add:

```ts
const inventoryIDPattern = /^[a-f0-9]{32}$/;

app.get("/api/models/inventory", async (_request, response) => {
 await proxyModelManager(response, "/models/inventory");
});

app.delete("/api/models/inventory/:id", async (request, response) => {
 if (!inventoryIDPattern.test(request.params.id))
  return response.status(400).json(
   safeModelError("invalid_inventory_target", "Inventory item is invalid."),
  );
 await proxyModelManager(
  response,
  `/models/inventory/${encodeURIComponent(request.params.id)}`,
  "DELETE",
 );
});
```

Place both before `app.get("/api/models/:id/options.yaml", ...)` and `app.delete("/api/models/:id", ...)` so Express never treats `inventory` as a catalog ID.

- [ ] **Step 4: Run server tests and build**

```bash
cd discord-pi-bot
pnpm exec node --import tsx --test test/model-manager.test.ts test/model-manager-routes.test.ts
pnpm build
```

Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the proxy**

```bash
git add discord-pi-bot/src/harness-server.ts discord-pi-bot/test/model-manager-routes.test.ts
git commit -m "feat(models): proxy physical model inventory"
```

---

### Task 4: Render and operate the Downloaded models inventory

**Files:**

- Modify: `discord-pi-bot/public/components/model-cookbook.js`
- Modify: `discord-pi-bot/public/app.js`
- Modify: `discord-pi-bot/public/harness.html`
- Modify: `discord-pi-bot/public/styles.css`
- Modify: `discord-pi-bot/test/model-cookbook-markup.test.mjs`

**Interfaces:**

- Consumes: browser inventory proxy from Task 3.
- Produces: `modelInventory`, `modelInventoryWarnings`, `modelInventoryLoading`, `loadInventory(vm)`, and `removeInventoryItem(vm, item)`.

- [ ] **Step 1: Write failing browser-contract tests**

Add assertions:

```js
test("models expose physical downloaded-file inventory", () => {
 assert.match(html, /Downloaded models/);
 assert.match(html, /x-for="item in modelInventory"/);
 assert.match(html, /item\.source === 'legacy_cache'/);
 assert.match(html, /item\.removable/);
 assert.match(html, /removeInventoryItem\(item\)/);
 assert.match(html, /No downloaded model files found/);
 assert.match(component, /\.\/api\/models\/inventory/);
 assert.match(component, /window\.confirm/);
 assert.match(component, /loadInventory\(vm\)/);
 assert.match(app, /removeInventoryItem\(item\)/);
 assert.match(css, /\.model-inventory/);
 assert.match(css, /\.model-inventory-row/);
});
```

- [ ] **Step 2: Run markup tests and verify failure**

```bash
cd discord-pi-bot
pnpm exec node --test test/model-cookbook-markup.test.mjs
```

Expected: FAIL because the Downloaded models section is absent.

- [ ] **Step 3: Add inventory state and operations**

Extend `state()` with:

```js
modelInventory: [],
modelInventoryWarnings: [],
modelInventoryLoading: false,
modelInventoryError: "",
```

Change paired `load(vm)` to fetch catalog, status, and inventory together:

```js
await Promise.all([
 this.loadCatalog(vm),
 this.loadStatus(vm),
 this.loadInventory(vm),
]);
```

Add methods:

```js
async loadInventory(vm) {
 vm.modelInventoryLoading = true;
 vm.modelInventoryError = "";
 try {
  const result = await fetch("./api/models/inventory").then(readModelResponse);
  vm.modelInventory = Array.isArray(result.items) ? result.items : [];
  vm.modelInventoryWarnings = Array.isArray(result.warnings) ? result.warnings : [];
 } catch (error) {
  vm.modelInventoryError = error.message || "Downloaded models could not be scanned.";
 } finally {
  vm.modelInventoryLoading = false;
 }
},

async removeInventoryItem(vm, item) {
 if (!item?.removable) return;
 const size = this.formatBytes(item.size);
 if (!window.confirm(`Remove "${item.name}" and reclaim ${size}?`)) return;
 vm.modelInventoryError = "";
 try {
  const response = await fetch(
   `./api/models/inventory/${encodeURIComponent(item.id)}`,
   { method: "DELETE" },
  );
  await readModelResponse(response);
  await Promise.all([this.loadInventory(vm), this.loadCatalog(vm)]);
 } catch (error) {
  vm.modelInventoryError = error.message || "Downloaded model could not be removed.";
 }
},
```

Update SSE completion refreshes to call `loadInventory(vm)` alongside status/catalog because downloads and switches change protection and disk state.

Expose the wrapper in `public/app.js`:

```js
async removeInventoryItem(item) {
 return window.RemindMeModelCookbook.removeInventoryItem(this, item);
},
```

- [ ] **Step 4: Add accessible inventory markup**

Place the section after the catalog grid and before native YAML:

```html
<section class="model-inventory" x-show="modelPairingConfigured" aria-labelledby="model-inventory-title">
  <div class="model-inventory-head">
    <div>
      <div class="kicker">Persistent storage</div>
      <h3 id="model-inventory-title">Downloaded models</h3>
    </div>
    <button class="ghost" :disabled="modelInventoryLoading" @click="reloadModels()">Refresh</button>
  </div>
  <p class="micro" x-show="modelInventoryLoading">Scanning model storage…</p>
  <p class="model-error" role="alert" x-show="modelInventoryError" x-text="modelInventoryError"></p>
  <template x-for="warning in modelInventoryWarnings" :key="warning.source">
    <p class="micro" x-text="warning.message"></p>
  </template>
  <p class="micro" x-show="!modelInventoryLoading && !modelInventoryError && modelInventory.length === 0">
    No downloaded model files found.
  </p>
  <div class="model-inventory-list">
    <template x-for="item in modelInventory" :key="item.id">
      <article class="model-inventory-row">
        <div class="model-inventory-copy">
          <b x-text="item.name"></b>
          <small x-text="`${item.source === 'legacy_cache' ? 'Legacy cache' : 'Managed'} · ${formatModelBytes(item.size)}`"></small>
          <small x-show="!item.validGguf">Invalid GGUF</small>
          <small x-show="item.catalogId" x-text="`Catalog: ${item.catalogId}`"></small>
        </div>
        <span class="model-inventory-state" x-text="item.active ? 'Running' : item.inProgress ? 'In progress' : item.removable ? 'Stored' : 'Protected'"></span>
        <button class="ghost danger" :disabled="!item.removable || modelOperationBusy" @click="removeInventoryItem(item)" x-text="item.removable ? 'Remove' : 'In use'"></button>
      </article>
    </template>
  </div>
</section>
```

- [ ] **Step 5: Add responsive styles**

Add focused styles near existing model rules:

```css
.model-inventory {
 margin-top: 18px;
 border: 1px solid var(--amber-faint);
 background: rgba(255, 178, 0, 0.025);
 padding: 14px;
}
.model-inventory-head,
.model-inventory-row {
 display: flex;
 align-items: center;
 gap: 12px;
}
.model-inventory-head { justify-content: space-between; }
.model-inventory-list { display: grid; gap: 8px; margin-top: 10px; }
.model-inventory-row { border-top: 1px solid var(--amber-faint); padding-top: 9px; }
.model-inventory-copy { display: grid; gap: 2px; min-width: 0; flex: 1; }
.model-inventory-copy b,
.model-inventory-copy small { overflow-wrap: anywhere; }
.model-inventory-copy small,
.model-inventory-state { color: var(--muted); font-size: 10px; }
.model-inventory-state { flex: none; }
.model-inventory .danger:not(:disabled) { color: var(--bad); border-color: var(--bad); }
@media (max-width: 520px) {
 .model-inventory-row { align-items: stretch; flex-direction: column; }
 .model-inventory-state { align-self: flex-start; }
}
```

Use existing color variables and button classes; do not introduce an unrelated visual system.

- [ ] **Step 6: Run UI and route tests**

```bash
cd discord-pi-bot
pnpm exec node --test test/model-cookbook-markup.test.mjs
pnpm exec node --import tsx --test test/model-manager-routes.test.ts
pnpm build
pnpm lint
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the UI**

```bash
git add discord-pi-bot/public/components/model-cookbook.js \
  discord-pi-bot/public/app.js \
  discord-pi-bot/public/harness.html \
  discord-pi-bot/public/styles.css \
  discord-pi-bot/test/model-cookbook-markup.test.mjs
git commit -m "feat(models): show downloaded files in RemindMe"
```

---

### Task 5: Version, document, and verify both add-ons

**Files:**

- Modify: `local-llama-cpp/config.yaml`
- Modify: `local-llama-cpp/README.md`
- Modify: `discord-pi-bot/config.yaml`

**Interfaces:**

- Consumes: completed manager and RemindMe behavior.
- Produces: deployable add-on versions and operator instructions.

- [ ] **Step 1: Update versions**

Change:

```yaml
# local-llama-cpp/config.yaml
version: "1.13.0"

# discord-pi-bot/config.yaml
version: "2.59.0"
```

Both versions must move together because the browser proxy depends on the new manager API.

- [ ] **Step 2: Document supported removal**

Add a `## Downloaded model storage` section to `local-llama-cpp/README.md` containing these operational facts:

```markdown
## Downloaded model storage

RemindMe's **Models → Downloaded models** section scans the add-on's persistent `/data/models` directory and legacy GGUF files under `/data/.cache`. It lists physical files independently of the curated catalog, so custom and older downloads remain visible.

A non-running file can be removed after confirmation. The manager refuses to remove the active model or a model involved in an operation. The browser receives opaque inventory identifiers rather than filesystem paths.
```

- [ ] **Step 3: Run complete manager verification**

```bash
cd local-llama-cpp/manager
gofmt -w $(find cmd internal -name '*.go' -type f)
go test ./... -count=1
```

Expected: `go test` exits 0 with all packages passing.

- [ ] **Step 4: Run complete RemindMe verification**

```bash
cd discord-pi-bot
pnpm exec node --import tsx --test test/*.test.ts
pnpm exec node --test test/*.test.mjs
pnpm lint
pnpm build
```

Expected: all test suites pass; lint and TypeScript build exit 0.

- [ ] **Step 5: Run packaging checks**

From the repository root:

```bash
git diff --check

docker build -t local-llama-cpp-inventory-test local-llama-cpp
docker build -t remindme-discord-bot-inventory-test discord-pi-bot
```

Expected: no whitespace errors and both images build. If Docker is unavailable, record the exact daemon error as a residual verification gap; do not claim image verification passed.

- [ ] **Step 6: Inspect diagnostics before completion**

Run language diagnostics on all modified Go, TypeScript, JavaScript, HTML, CSS, and YAML files. Resolve every new error and review every warning before declaring completion.

- [ ] **Step 7: Commit versions and documentation**

```bash
git add local-llama-cpp/config.yaml local-llama-cpp/README.md discord-pi-bot/config.yaml
git commit -m "docs(models): document disk inventory rollout"
```

- [ ] **Step 8: Final acceptance check**

On an updated Home Assistant installation:

1. Update Local llama.cpp to `1.13.0` and RemindMe to `2.59.0`.
2. Open **RemindMe → Models → Downloaded models**.
3. Verify previously hidden managed and legacy-cache GGUF files appear with sizes.
4. Confirm the running file shows **In use** and cannot be removed.
5. Remove one non-running file and confirm the displayed inventory and available disk space refresh.
6. Restart both add-ons and verify the removed file does not return and inference still works.
