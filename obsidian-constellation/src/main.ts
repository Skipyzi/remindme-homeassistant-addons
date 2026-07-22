import { Plugin, WorkspaceLeaf } from "obsidian";
import { ConstellationView, VIEW_TYPE_CONSTELLATION } from "./constellation-view.js";

/**
 * Registers the constellation as a workspace view and gives two ways in: a
 * ribbon orbit icon and a command. It is a file viewer, so it opens in a main
 * (not side) leaf by default.
 */
export default class ConstellationPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(
			VIEW_TYPE_CONSTELLATION,
			(leaf) => new ConstellationView(leaf),
		);

		this.addRibbonIcon("orbit", "Open vault constellation", () =>
			this.activateView(),
		);

		this.addCommand({
			id: "open-vault-constellation",
			name: "Open vault constellation",
			callback: () => this.activateView(),
		});
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CONSTELLATION);
	}

	private async activateView(): Promise<void> {
		const { workspace } = this.app;
		// Reveal an existing view rather than stacking duplicates.
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CONSTELLATION)[0];
		const leaf: WorkspaceLeaf = existing ?? workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_CONSTELLATION, active: true });
		workspace.revealLeaf(leaf);
	}
}
