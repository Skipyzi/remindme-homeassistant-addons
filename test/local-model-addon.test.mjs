import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync("local-llama-cpp/Dockerfile", "utf8");
const run = readFileSync("local-llama-cpp/run.sh", "utf8");
const config = readFileSync("local-llama-cpp/config.yaml", "utf8");
const remindMeConfig = readFileSync("discord-pi-bot/config.yaml", "utf8");
const remindMeRun = readFileSync("discord-pi-bot/run.sh", "utf8");
const remindMeServer = readFileSync("discord-pi-bot/src/harness-server.ts", "utf8");
const managerMain = readFileSync(
	"local-llama-cpp/manager/cmd/model-manager/main.go",
	"utf8",
);
const managerServer = readFileSync(
	"local-llama-cpp/manager/internal/api/server.go",
	"utf8",
);
const modelComponent = readFileSync(
	"discord-pi-bot/public/components/model-cookbook.js",
	"utf8",
);
const pairing = readFileSync(
	"local-llama-cpp/manager/internal/pairing/pairing.go",
	"utf8",
);
const remindMeReadme = readFileSync("discord-pi-bot/README.md", "utf8");
const llamaReadme = readFileSync("local-llama-cpp/README.md", "utf8");

test("llama add-on launches the model manager and keeps the inference port", () => {
	assert.match(dockerfile, /go build .*model-manager/s);
	assert.match(
		dockerfile,
		/sha256:6bc9134e3278a0ecab23d7ef2f6a46b4595740014fe9bc2f67e8ba7dca8395b4/,
	);
	assert.match(run, /exec \/app\/model-manager/);
	assert.match(config, /manager_token: password/);
	assert.match(config, /8080\/tcp: 8080/);
});

test("startup delegates JSON parsing to the Go manager", () => {
	assert.doesNotMatch(run, /sed -n/);
	assert.match(run, /--options \/data\/options\.json/);
});

test("release packages secure direct pairing without sibling privileges", () => {
	assert.match(remindMeConfig, /version: "2\.3\.4"/);
	assert.match(config, /version: "1\.10\.0"/);
	assert.doesNotMatch(remindMeConfig, /hassio_role:\s*(manager|admin)/);
	assert.doesNotMatch(remindMeServer, /\/addons\/\$\{.*\}\/options/);
	assert.doesNotMatch(remindMeServer, /\/addons\/self\/options\/validate/);
	assert.doesNotMatch(remindMeServer, /\/api\/settings|\/addons\/self\/restart/);
	assert.doesNotMatch(managerServer, /POST \/manager\/v1\/activate/);
	assert.doesNotMatch(modelComponent, /api\/models\/activate/);
	assert.match(remindMeRun, /MODEL_MANAGER_TOKEN_PATH=\/data\/model-manager-token/);
	assert.match(
		remindMeRun,
		/PRESENCE_UPTIME_PATH=\/data\/presence-uptime\.json/,
	);
	assert.match(
		remindMeRun,
		/LOCAL_LLM_URL="http:\/\/homeassistant:8080\/v1\/chat\/completions"/,
	);
	assert.match(
		remindMeRun,
		/MODEL_MANAGER_URL="http:\/\/homeassistant:8080\/manager\/v1"/,
	);
	assert.match(managerMain, /filepath\.Join\(dataDirectory, "manager-token"\)/);
});

test("legacy manager token is migration-only and pairing is documented", () => {
	assert.match(config, /manager_token: password/);
	assert.match(pairing, /O_CREATE\|os\.O_EXCL/);
	for (const readme of [remindMeReadme, llamaReadme]) {
		assert.match(readme, /pair/i);
		assert.match(readme, /six-character|six character|6-character/i);
	}
	assert.match(remindMeReadme, /Settings.*harness|harness.*Settings/i);
	assert.match(remindMeReadme, /does not.*Supervisor|Supervisor.*does not/i);
	assert.match(remindMeReadme, /loopback|127\.0\.0\.1/i);
	assert.match(remindMeReadme, /native.*Configuration|Configuration.*native/i);
	assert.match(llamaReadme, /legacy.*manager_token|manager_token.*legacy/i);
	assert.match(llamaReadme, /preserv.*unknown|unknown.*preserv/i);
});

test("RemindMe documents persistent lifetime presence uptime", () => {
	assert.match(remindMeReadme, /cumulative.*uptime|uptime.*cumulative/i);
	assert.match(remindMeReadme, /lifetime.*availability|availability.*lifetime/i);
	assert.match(remindMeReadme, /stopped.*downtime|downtime.*stopped/i);
	assert.match(remindMeReadme, /presence-uptime\.json/);
	assert.match(remindMeReadme, /Gateway presence/i);
	assert.match(remindMeReadme, /RemindMe.*Pi connected/i);
	assert.match(remindMeReadme, /reminders/i);
});

test("manual model workflow is documented", () => {
	for (const readme of [remindMeReadme, llamaReadme]) {
		assert.match(readme, /download.*does not.*running model|running model.*does not.*download/i);
		assert.match(readme, /Copy.*YAML|YAML.*copy/i);
		assert.match(readme, /Configuration/i);
		assert.match(readme, /restart.*llama\.cpp|llama\.cpp.*restart/i);
	}
	assert.match(llamaReadme, /model_path.*authoritative|authoritative.*model_path/i);
	assert.match(remindMeReadme, /runtime.*model|model.*runtime/i);
});

test("llama startup waits for internal server readiness", () => {
	assert.match(llamaReadme, /120 seconds/i);
	assert.match(llamaReadme, /127\.0\.0\.1:8081/);
	assert.match(llamaReadme, /retry|retries/i);
});
