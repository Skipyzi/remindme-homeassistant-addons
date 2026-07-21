import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { glslDocument, wgslDocument } from "./shaderDocument";
import { luaDocument, threeDocument } from "./runtimeDocument";

/**
 * Artifacts: self-contained documents the model writes and the console
 * renders — a chart, a diagram, a page, a snippet worth keeping.
 *
 * Everywhere else in this codebase model output is never allowed to become
 * markup. An artifact is the deliberate exception, so the isolation has to be
 * real rather than a sanitiser: HTML and SVG are rendered inside an iframe
 * with `sandbox="allow-scripts"` and no `allow-same-origin`, which puts them
 * in an opaque origin with no access to the parent document, the Home
 * Assistant session, or storage. Those two flags together would undo the
 * sandbox entirely, which is why they are never combined.
 */

export type ArtifactKind =
	| "html"
	| "svg"
	| "markdown"
	| "code"
	| "glsl"
	| "wgsl"
	| "three"
	| "lua";

export interface Artifact {
	id: string;
	title: string;
	kind: ArtifactKind;
	/** Language hint for `code`; ignored otherwise. */
	language?: string;
	content: string;
	createdAt: string;
	updatedAt: string;
}

/** Big enough for a real page, small enough not to fill a Pi's disk. */
export const MAX_ARTIFACT_BYTES = 128_000;

const KINDS: ArtifactKind[] = [
	"html",
	"svg",
	"markdown",
	"code",
	"glsl",
	"wgsl",
	"three",
	"lua",
];

export function normalizeKind(value: unknown): ArtifactKind {
	const kind = String(value || "").toLowerCase();
	return (KINDS as string[]).includes(kind) ? (kind as ArtifactKind) : "markdown";
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

export class ArtifactStore {
	private artifacts: Artifact[] = [];
	constructor(
		private readonly path = process.env.ARTIFACT_DATA_PATH ||
			"./data/artifacts.json",
	) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			this.artifacts = Array.isArray(parsed) ? (parsed as Artifact[]) : [];
		} catch (error) {
			if (!isMissing(error)) console.error("Failed to load artifacts:", error);
			this.artifacts = [];
		}
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify(this.artifacts, null, 2), "utf8");
		await rename(temporary, this.path);
	}

	/** Listing omits content: a sidebar does not need the whole document. */
	list(): Array<Omit<Artifact, "content"> & { bytes: number }> {
		return this.artifacts.map(({ content, ...rest }) => ({
			...rest,
			bytes: content.length,
		}));
	}

	get(id: string): Artifact | undefined {
		return this.artifacts.find((artifact) => artifact.id === id);
	}

	async create(values: Partial<Artifact>): Promise<Artifact> {
		const content = String(values.content || "").slice(0, MAX_ARTIFACT_BYTES);
		const now = new Date().toISOString();
		const artifact: Artifact = {
			id: randomUUID().slice(0, 8),
			title: String(values.title || "Untitled").slice(0, 120),
			kind: normalizeKind(values.kind),
			language: values.language ? String(values.language).slice(0, 24) : undefined,
			content,
			createdAt: now,
			updatedAt: now,
		};
		this.artifacts.unshift(artifact);
		// Keep the store bounded; artifacts are cheap to regenerate.
		this.artifacts = this.artifacts.slice(0, 100);
		await this.persist();
		return artifact;
	}

	async update(
		id: string,
		values: Partial<Artifact>,
	): Promise<Artifact | undefined> {
		const artifact = this.get(id);
		if (!artifact) return undefined;
		if (typeof values.title === "string")
			artifact.title = values.title.slice(0, 120);
		if (typeof values.content === "string")
			artifact.content = values.content.slice(0, MAX_ARTIFACT_BYTES);
		if (values.kind) artifact.kind = normalizeKind(values.kind);
		artifact.updatedAt = new Date().toISOString();
		await this.persist();
		return artifact;
	}

	async delete(id: string): Promise<boolean> {
		const before = this.artifacts.length;
		this.artifacts = this.artifacts.filter((artifact) => artifact.id !== id);
		if (this.artifacts.length === before) return false;
		await this.persist();
		return true;
	}
}

/**
 * Wrap artifact source into a standalone document for the sandboxed frame.
 * A restrictive CSP is set inside the document as well as the sandbox
 * attribute outside it, so a bare `svg` or fragment cannot reach the network
 * even if the frame flags were ever loosened.
 */
export function toDocument(artifact: Artifact): string {
	const csp =
		"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'";
	const shell = (body: string) =>
		`<!doctype html><html><head><meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
		`<style>html,body{margin:0;background:#160f04;color:#e8dcc0;` +
		`font-family:ui-monospace,monospace;padding:12px}` +
		`svg{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;

	if (artifact.kind === "html") {
		// Already a document? Leave it be; the sandbox is what contains it.
		return /<html[\s>]/i.test(artifact.content)
			? artifact.content
			: shell(artifact.content);
	}
	if (artifact.kind === "svg") return shell(artifact.content);
	/* Shaders are compiled by the GPU driver inside the same frame; the
	 * shell supplies the canvas, the uniforms and the error pane. */
	if (artifact.kind === "glsl") return glslDocument(artifact.content);
	if (artifact.kind === "wgsl") return wgslDocument(artifact.content);
	if (artifact.kind === "three") return threeDocument(artifact.content);
	if (artifact.kind === "lua") return luaDocument(artifact.content);
	return "";
}
