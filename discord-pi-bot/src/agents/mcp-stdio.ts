import { createInterface } from "node:readline";

/** Only a short-lived, turn-scoped capability is passed to native clients. */
async function request(method: string, params?: unknown) {
	const url = process.env.REMINDME_TOOL_URL || "";
	if (!/^http:\/\/127\.0\.0\.1:\d+\/internal\/agent-tools$/.test(url)) throw new Error("Invalid tool bridge address");
	const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.REMINDME_TOOL_TOKEN || ""}` }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error("Home Assistant tool capability expired or failed");
	return response.json();
}
async function main() {
	for await (const line of createInterface({ input: process.stdin })) {
		let message: any;
		try { message = JSON.parse(line); } catch { continue; }
		if (message.id === undefined) continue;
		try {
			let result: unknown;
			if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "remindme-home", version: "1.0.0" } };
			else if (message.method === "ping") result = {};
			else if (message.method === "tools/list" || message.method === "tools/call") result = await request(message.method, message.params);
			else { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported" } })}\n`); continue; }
			process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
		} catch (error) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Tool failed" } })}\n`); }
	}
}
if (require.main === module) void main();
