import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A connector is one outside source RemindMe reads: today mail accounts,
 * later calendars or feeds. Settings come from the console; passwords are
 * kept here on the Pi and never go back to the browser.
 */
export interface StoredConnector {
	id: string;
	kind: string;
	preset: string;
	name: string;
	enabled: boolean;
	values: Record<string, string>;
	secrets: Record<string, string>;
	createdAt: string;
	/** Imported from the app options; their password there wins when it changes. */
	fromOptions?: boolean;
}

/** What the console may see: everything but the secrets, which show as set or not. */
export interface PublicConnector extends Omit<StoredConnector, "secrets"> {
	secretsSet: string[];
}

export function publicView(connector: StoredConnector): PublicConnector {
	const { secrets, ...rest } = connector;
	return { ...rest, secretsSet: Object.keys(secrets).filter((key) => Boolean(secrets[key])) };
}

export class ConnectorStore {
	private connectors: StoredConnector[] = [];

	constructor(private readonly path = process.env.CONNECTORS_DATA_PATH || "./data/connectors.json") {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as StoredConnector[];
			this.connectors = Array.isArray(saved) ? saved.filter((item) => item && typeof item.id === "string") : [];
		} catch {
			this.connectors = [];
		}
	}

	private async save(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await writeFile(`${this.path}.tmp`, JSON.stringify(this.connectors, null, 2), { mode: 0o600 });
		await rename(`${this.path}.tmp`, this.path);
		await chmod(this.path, 0o600).catch(() => {});
	}

	list(kind?: string): StoredConnector[] {
		return this.connectors.filter((connector) => !kind || connector.kind === kind);
	}

	get(id: string): StoredConnector | undefined {
		return this.connectors.find((connector) => connector.id === id);
	}

	async create(values: Omit<StoredConnector, "id" | "createdAt">): Promise<StoredConnector> {
		const connector: StoredConnector = { ...values, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString() };
		this.connectors.push(connector);
		await this.save();
		return connector;
	}

	/** Blank secrets keep the stored ones: the console never has them to send back. */
	async update(
		id: string,
		patch: { name?: string; enabled?: boolean; values?: Record<string, string>; secrets?: Record<string, string>; dropSecrets?: string[] },
	): Promise<StoredConnector | undefined> {
		const connector = this.get(id);
		if (!connector) return undefined;
		if (patch.name !== undefined) connector.name = patch.name;
		if (patch.enabled !== undefined) connector.enabled = patch.enabled;
		if (patch.values) connector.values = { ...connector.values, ...patch.values };
		for (const [key, value] of Object.entries(patch.secrets || {})) if (value) connector.secrets[key] = value;
		for (const key of patch.dropSecrets || []) delete connector.secrets[key];
		await this.save();
		return connector;
	}

	async remove(id: string): Promise<boolean> {
		const before = this.connectors.length;
		this.connectors = this.connectors.filter((connector) => connector.id !== id);
		if (this.connectors.length === before) return false;
		await this.save();
		return true;
	}
}
