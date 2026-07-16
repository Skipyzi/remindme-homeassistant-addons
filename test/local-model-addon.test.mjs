import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync("local-llama-cpp/Dockerfile", "utf8");
const run = readFileSync("local-llama-cpp/run.sh", "utf8");
const config = readFileSync("local-llama-cpp/config.yaml", "utf8");

test("llama add-on launches the model manager and keeps the inference port", () => {
	assert.match(dockerfile, /go build .*model-manager/s);
	assert.match(dockerfile, /sha256:6bc9134e3278a0ecab23d7ef2f6a46b4595740014fe9bc2f67e8ba7dca8395b4/);
	assert.match(run, /exec \/app\/model-manager/);
	assert.match(config, /manager_token: password/);
	assert.match(config, /8080\/tcp: 8080/);
});

test("startup delegates JSON parsing to the Go manager", () => {
	assert.doesNotMatch(run, /sed -n/);
	assert.match(run, /--options \/data\/options\.json/);
});
