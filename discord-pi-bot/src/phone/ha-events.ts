/**
 * Home Assistant's event bus over its WebSocket API, for the few events
 * RemindMe acts on, such as a tap on a notification button. Through the
 * Supervisor that's ws://supervisor/core/websocket with the app's token.
 * It reconnects on its own, waiting longer each time, up to a minute.
 */

/** The WebSocket address next to a REST one: …/core/api → …/core/websocket, …/api → …/api/websocket. */
export function websocketUrl(apiUrl: string): string {
	const url = new URL(apiUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = /\/core\/api\/?$/.test(url.pathname) ? url.pathname.replace(/\/core\/api\/?$/, "/core/websocket") : url.pathname.replace(/\/api\/?$/, "/api/websocket");
	return url.toString();
}

export class HaEvents {
	private socket?: WebSocket;
	private retry = 1_000;
	private stopped = false;

	constructor(
		private readonly url: string,
		private readonly token: string,
		private readonly types: string[],
		private readonly onEvent: (type: string, data: Record<string, unknown>) => void,
	) {}

	start(): void {
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.socket?.close();
	}

	private connect(): void {
		if (this.stopped) return;
		let id = 0;
		const socket = new WebSocket(this.url);
		this.socket = socket;
		socket.onmessage = (message) => {
			let data: { type?: string; event?: { event_type?: string; data?: Record<string, unknown> } };
			try {
				data = JSON.parse(String(message.data));
			} catch {
				return;
			}
			if (data.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
			else if (data.type === "auth_ok") {
				this.retry = 1_000;
				for (const type of this.types) socket.send(JSON.stringify({ id: ++id, type: "subscribe_events", event_type: type }));
			} else if (data.type === "auth_invalid") {
				console.warn("Home Assistant turned down RemindMe's event connection.");
				socket.close();
			} else if (data.type === "event" && data.event?.event_type) {
				try {
					this.onEvent(data.event.event_type, data.event.data || {});
				} catch (error) {
					console.warn("Handling a Home Assistant event failed:", error instanceof Error ? error.message : error);
				}
			}
		};
		socket.onerror = () => {
			/* close follows, and reconnects */
		};
		socket.onclose = () => {
			if (this.stopped) return;
			setTimeout(() => this.connect(), this.retry).unref();
			this.retry = Math.min(this.retry * 2, 60_000);
		};
	}
}
