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
	assert.match(remindMeConfig, /version: "2\.3\.0"/);
	assert.match(config, /version: "1\.9\.0"/);
	assert.doesNotMatch(remindMeConfig, /hassio_role:\s*(manager|admin)/);
	assert.doesNotMatch(remindMeServer, /\/addons\/\$\{.*\}\/options/);
	assert.match(remindMeRun, /MODEL_MANAGER_TOKEN_PATH=\/data\/model-manager-token/);
	assert.match(managerMain, /filepath\.Join\(dataDirectory, "manager-token"\)/);
});

test("legacy manager token is migration-only and pairing is documented", () => {
	assert.match(config, /manager_token: password/);
	assert.match(pairing, /O_CREATE\|os\.O_EXCL/);
	for (const readme of [remindMeReadme, llamaReadme]) {
		assert.match(readme, /pair/i);
		assert.match(readme, /six-character|six character|6-character/i);
	}
	assert.match(remindMeReadme, /configuration changed|conflict/i);
	assert.match(remindMeReadme, /restart/i);
	assert.match(llamaReadme, /legacy.*manager_token|manager_token.*legacy/i);
});
