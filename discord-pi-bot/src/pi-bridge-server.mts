import "dotenv/config";
import express from "express";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const app = express();
const port = Number(process.env.PI_BRIDGE_PORT || 3000);
const sessions = new Map<string, Awaited<ReturnType<typeof createAgentSession>>["session"]>();
const activeRequests = new Map<string, Promise<string>>();

app.use(express.json({ limit: "64kb" }));

app.get("/health", (_request, response) => {
	response.json({ status: "ok", service: "pi-agent-bridge" });
});

app.post("/api/webhook", async (request, response) => {
	const body = request.body as { message?: unknown; userId?: unknown };
	const message = typeof body.message === "string" ? body.message.trim() : "";
	const userId = typeof body.userId === "string" ? body.userId : "default";

	if (!message) {
		response.status(400).json({ error: "message is required" });
		return;
	}

	try {
		const previous = activeRequests.get(userId);
		if (previous) await previous;

		const requestPromise = answer(userId, message);
		activeRequests.set(userId, requestPromise);
		const text = await requestPromise;
		response.json({ response: text });
	} catch (error) {
		console.error("Pi agent request failed:", error);
		response.status(502).json({ error: "Pi agent failed to answer" });
	} finally {
		activeRequests.delete(userId);
	}
});

async function answer(userId: string, prompt: string): Promise<string> {
	let session = sessions.get(userId);
	if (!session) {
		const created = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
		});
		session = created.session;
		sessions.set(userId, session);
	}

	let text = "";
	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			text += event.assistantMessageEvent.delta;
		}
	});

	try {
		await session.prompt(prompt);
		return text.trim() || "Pi returned an empty response.";
	} finally {
		unsubscribe();
	}
}

app.listen(port, () => {
	console.log(`Pi agent bridge listening at http://localhost:${port}`);
});
