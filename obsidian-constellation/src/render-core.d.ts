// Minimal typing for the JS render core, which is shared verbatim with the
// SearXNG constellation and stays plain JS on purpose.

export interface ConstellationResult {
	id?: string;
	title: string;
	url?: string;
	snippet?: string;
	group?: string;
	tags?: string[];
	[key: string]: unknown;
}

export interface ConstellationConfig {
	mount?: HTMLElement;
	onSearch?: ((query: string) => Promise<ConstellationResult[]>) | null;
	onOpen?: (result: ConstellationResult) => void;
	groupOf?: (result: ConstellationResult) => string;
	snippetOf?: (result: ConstellationResult) => string;
	subtitleOf?: (result: ConstellationResult) => string;
	linkKeyOf?: (result: ConstellationResult) => string;
	faviconFor?: (result: ConstellationResult) => string | null;
	colorFor?: (key: string) => number;
	placeholder?: string;
	initialQuery?: string;
}

export interface ConstellationView {
	el: HTMLElement;
	setResults: (results: ConstellationResult[]) => void;
	search: (query: string) => Promise<void>;
	setMotion: (on: boolean) => void;
	focus: () => void;
	dispose: () => void;
}

export function createConstellation(config?: ConstellationConfig): ConstellationView;
