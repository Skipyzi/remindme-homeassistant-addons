import {
	ItemView,
	TFile,
	WorkspaceLeaf,
	getAllTags,
	type CachedMetadata,
} from "obsidian";
import {
	createConstellation,
	type ConstellationResult,
	type ConstellationView as CoreView,
} from "./render-core.js";

export const VIEW_TYPE_CONSTELLATION = "remindme-constellation";

/**
 * A vault as a constellation. Each note is a specimen, grouped by its type
 * (frontmatter `type`, else its folder, else its leading tag) and related to
 * its neighbours by shared tag — the render core's relation map draws the link.
 * Flying to a note and opening it is the whole point: this is a file viewer.
 *
 * The render core is data-agnostic and shared verbatim with the SearXNG search
 * constellation; everything Obsidian-specific is the mapping below.
 */
export class ConstellationView extends ItemView {
	private view: CoreView | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CONSTELLATION;
	}

	getDisplayText(): string {
		return "Vault constellation";
	}

	getIcon(): string {
		return "orbit";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.style.position = "relative";
		container.style.height = "100%";

		this.view = createConstellation({
			mount: container,
			groupOf: (note) => String(note.group || "note"),
			snippetOf: (note) => String(note.snippet || ""),
			subtitleOf: (note) =>
				note.tags && note.tags.length ? `#${note.tags[0]}` : "",
			// Shared leading tag is what the relation map connects across groups.
			linkKeyOf: (note) => (note.tags && note.tags.length ? note.tags[0] : ""),
			faviconFor: () => null,
			onOpen: (note) => this.openNote(note),
		});

		await this.refresh();

		// Rebuild once the metadata cache has resolved (tags and frontmatter are
		// not reliably present on first paint), and whenever the vault changes.
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => void this.refresh()),
		);
		this.registerEvent(this.app.vault.on("create", () => void this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => void this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => void this.refresh()));
	}

	async onClose(): Promise<void> {
		this.view?.dispose();
		this.view = null;
	}

	/** Map every markdown note in the vault onto a render-core result. */
	private async refresh(): Promise<void> {
		if (!this.view) return;
		const files = this.app.vault.getMarkdownFiles();
		const results: ConstellationResult[] = files.map((file) => {
			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = (cache?.frontmatter || {}) as Record<string, unknown>;
			const tags = (getAllTags(cache as CachedMetadata) || []).map((tag) =>
				tag.replace(/^#/, ""),
			);
			const type =
				(typeof frontmatter.type === "string" && frontmatter.type) ||
				folderGroup(file) ||
				tags[0] ||
				"note";
			return {
				id: file.path,
				title:
					(typeof frontmatter.title === "string" && frontmatter.title) ||
					file.basename,
				url: file.path,
				snippet: "",
				group: String(type).toLowerCase(),
				tags,
			};
		});

		// A short excerpt for the read panel — frontmatter stripped, markup
		// flattened. Read from cache so this stays cheap on a large vault.
		await Promise.all(
			results.map(async (result) => {
				const file = this.app.vault.getAbstractFileByPath(String(result.id));
				if (!(file instanceof TFile)) return;
				const text = await this.app.vault.cachedRead(file);
				result.snippet = text
					.replace(/^---[\s\S]*?---/, "")
					.replace(/[#*`>[\]]/g, "")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 220);
			}),
		);

		this.view.setResults(results);
	}

	private openNote(note: ConstellationResult): void {
		const file = this.app.vault.getAbstractFileByPath(String(note.url || note.id));
		if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
	}
}

/** The note's top-level folder, if it lives in one, as a grouping fallback. */
function folderGroup(file: TFile): string | undefined {
	const parent = file.parent;
	if (!parent || parent.isRoot()) return undefined;
	return parent.path.split("/")[0];
}
