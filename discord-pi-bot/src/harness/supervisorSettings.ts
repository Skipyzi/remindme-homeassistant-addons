import {
	AddonSettingsError,
	applySettingsPatch,
	normalizeAddonOptions,
	publicAddonSettings,
	settingsRevision,
	type PublicAddonSettings,
} from "./addonSettings";

export interface LoadedAddonSettings {
	revision: string;
	settings: PublicAddonSettings;
}

export interface SaveSettingsResult extends LoadedAddonSettings {
	restartRequired: true;
}

export class SupervisorSettingsError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: number,
		public readonly retryable = false,
	) {
		super(message);
	}
}

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export class SupervisorSettingsClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly requestFetch: FetchLike = fetch,
	) {}

	private async request(
		path: string,
		init: RequestInit = {},
		validationWrite = false,
	): Promise<unknown> {
		let response: Response;
		try {
			response = await this.requestFetch(`${this.baseUrl}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
					...init.headers,
				},
			});
		} catch {
			throw new SupervisorSettingsError(
				"supervisor_unavailable",
				"Home Assistant Supervisor is unavailable.",
				502,
				true,
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new SupervisorSettingsError(
				"supervisor_unavailable",
				"Home Assistant Supervisor returned an invalid response.",
				502,
				true,
			);
		}
		if (!response.ok) {
			const message = safeSupervisorMessage(body);
			if (validationWrite && response.status === 400)
				throw new SupervisorSettingsError(
					"configuration_invalid",
					message || "Supervisor rejected the add-on configuration.",
					422,
				);
			throw new SupervisorSettingsError(
				"supervisor_unavailable",
				message || `Supervisor returned HTTP ${response.status}.`,
				502,
				response.status >= 500,
			);
		}
		if (!body || typeof body !== "object")
			throw new SupervisorSettingsError(
				"supervisor_unavailable",
				"Home Assistant Supervisor returned an invalid response.",
				502,
				true,
			);
		const envelope = body as { result?: unknown; data?: unknown };
		if (envelope.result !== "ok" || !("data" in envelope))
			throw new SupervisorSettingsError(
				"supervisor_unavailable",
				"Home Assistant Supervisor returned an invalid response.",
				502,
				true,
			);
		return envelope.data;
	}

	private async loadRaw(): Promise<Record<string, unknown>> {
		const data = await this.request("/addons/self/options/config", {
			cache: "no-store",
		});
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new SupervisorSettingsError(
				"supervisor_unavailable",
				"Supervisor configuration response did not contain options.",
				502,
				true,
			);
		try {
			return normalizeAddonOptions(data) as unknown as Record<string, unknown>;
		} catch (error) {
			throw new SupervisorSettingsError(
				"configuration_invalid",
				error instanceof Error ? error.message : "Stored configuration is invalid.",
				422,
			);
		}
	}

	async load(): Promise<LoadedAddonSettings> {
		const raw = await this.loadRaw();
		return {
			revision: settingsRevision(raw),
			settings: publicAddonSettings(normalizeAddonOptions(raw)),
		};
	}

	async save(revision: string, changes: unknown): Promise<SaveSettingsResult> {
		const current = await this.loadRaw();
		if (settingsRevision(current) !== revision)
			throw new SupervisorSettingsError(
				"configuration_changed",
				"Configuration changed elsewhere. Reload before saving.",
				409,
				true,
			);
		let merged: Record<string, unknown>;
		try {
			merged = applySettingsPatch(current, changes);
		} catch (error) {
			if (error instanceof AddonSettingsError)
				throw new SupervisorSettingsError(error.code, error.message, 400);
			throw error;
		}
		await this.request(
			"/addons/self/options",
			{
				method: "POST",
				body: JSON.stringify({ options: merged }),
			},
			true,
		);
		const loaded = await this.load();
		return { ...loaded, restartRequired: true };
	}
}

function safeSupervisorMessage(body: unknown): string {
	if (!body || typeof body !== "object") return "";
	const value = body as { message?: unknown; error?: unknown };
	if (typeof value.message === "string") return value.message.slice(0, 400);
	if (typeof value.error === "string") return value.error.slice(0, 400);
	return "";
}
