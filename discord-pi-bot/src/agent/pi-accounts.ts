// Runs outside the server with the same isolated environment as native workers.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

async function main() {
	const sdk = await (new Function("s", "return import(s)") as (s: string) => Promise<any>)(pathToFileURL(join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
	const directory = process.env.PI_CODING_AGENT_DIR!;
	const auth = sdk.AuthStorage.create(join(directory, "auth.json"));
	const emit = (data: unknown) => process.stdout.write(JSON.stringify(data) + "\n");
	if (process.argv[2] === "list") {
		const registry = sdk.ModelRegistry.create(auth, join(directory, "models.json"));
		emit({ providers: auth.getOAuthProviders().map((p: any) => ({ id: p.id, name: p.name })), connected: auth.list(), models: registry.getAvailable().filter((m: any) => auth.has(m.provider)).map((m: any) => ({ id: `${m.provider}/${m.id}`, name: m.name, provider: m.provider })) });
		return;
	}
	const provider = process.argv[3];
	if (!auth.getOAuthProviders().some((p: any) => p.id === provider)) throw new Error("Unknown Pi login provider");
	const lines = createInterface({ input: process.stdin });
	const replies: Array<(value: string) => void> = [];
	lines.on("line", line => { try { const data = JSON.parse(line); if (typeof data.input === "string") replies.shift()?.(data.input); } catch {} });
	const prompt = (message: string, options?: unknown) => { emit({ prompt: message, options }); return new Promise<string>(resolve => replies.push(resolve)); };
	try {
		await auth.login(provider, {
			onAuth: (info: any) => emit({ output: `${info.instructions || "Open this link to sign in:"}\r\n${info.url}\r\n`, url: info.url }),
			onDeviceCode: (info: any) => emit({ output: `Open ${info.verificationUri} and enter ${info.userCode}\r\n`, url: info.verificationUri }),
			onPrompt: (info: any) => prompt(info.message),
			onProgress: (message: string) => emit({ output: message + "\r\n" }),
			onManualCodeInput: () => prompt("If the browser cannot reach the Pi callback, paste the final callback URL here."),
			onSelect: (info: any) => prompt(info.message, info.options),
		});
		emit({ output: "Signed in. Close this console and choose a model in chat.\r\n" });
	} finally { lines.close(); }
}
void main().then(() => process.exit(0), () => { process.stdout.write(JSON.stringify({ output: "Pi sign-in failed. Start again.\r\n" }) + "\n"); process.exit(1); });
