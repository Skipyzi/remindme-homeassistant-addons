/**
 * Cards under an answer: offers, a place, articles, the news. Tools build
 * them from what they found (a price from Geizhals, a place from
 * OpenStreetMap, an article from a feed) and give each an id; the AI picks
 * the ones worth showing by writing [[c1]] in its answer. So every price,
 * picture and link on a card comes from a tool, never from the AI.
 */

export interface Offer {
	/** "199,99 €", as shown. */
	price: string;
	shop: string;
	/** "Free shipping, ships today". */
	note?: string;
}

export type Embed =
	| { kind: "offers"; title: string; url: string; image?: string; meta: string; offers: Offer[]; watching?: string }
	| {
			kind: "place";
			name: string;
			lat: number;
			lon: number;
			/** "Open now, until 20:00". */
			status?: { text: string; open: boolean };
			lines: string[];
			links: Array<{ label: string; url: string }>;
	  }
	| { kind: "article"; title: string; url: string; source: string; image?: string; at?: string; summary?: string }
	| {
			/** The news digest in RemindMe's thread: stories by section, each with its sources. */
			kind: "stories";
			sections: Array<{ label: string; items: Array<{ title: string; summary?: string; image?: string; links: Array<{ source: string; url: string }> }> }>;
	  };

/** A turn's cards so far: tools add, the answer picks. */
export interface EmbedShelf {
	embeds: Embed[];
}

/** Keep a card for this turn; its id ("c3") is what the AI writes to show it. */
export function addEmbed(shelf: EmbedShelf, embed: Embed): string {
	shelf.embeds.push(embed);
	return `c${shelf.embeds.length}`;
}

const MARKER = /\[\[(c\d{1,3})\]\]/g;

/** The answer without its [[c1]] markers, and the cards they named, in order, each once. */
export function takeEmbeds(text: string, embeds: Embed[]): { text: string; shown: Embed[] } {
	const shown: Embed[] = [];
	const seen = new Set<string>();
	for (const [, id] of text.matchAll(MARKER)) {
		const embed = embeds[Number(id.slice(1)) - 1];
		if (embed && !seen.has(id)) {
			seen.add(id);
			shown.push(embed);
		}
	}
	const clean = text
		.replace(MARKER, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { text: clean, shown };
}

const link = (label: string, url: string) => `[${label}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20")})`;

/** A card as Markdown, for Discord and anything else without cards. */
export function embedText(embed: Embed): string {
	switch (embed.kind) {
		case "offers":
			return [`**${embed.title}** (${embed.meta})`, ...embed.offers.map((offer) => `- ${offer.price} at ${offer.shop}${offer.note ? `, ${offer.note}` : ""}`), link("Open", embed.url)].join("\n");
		case "place":
			return [`**${embed.name}**${embed.status ? `: ${embed.status.text}` : ""}`, ...embed.lines, embed.links.map((entry) => link(entry.label, entry.url)).join(" · ")].filter(Boolean).join("\n");
		case "article":
			return `- ${link(embed.title, embed.url)} (${embed.source})`;
		case "stories":
			return embed.sections.map((section) => `**${section.label}**\n${section.items.map((item) => `- **${item.title}** ${item.summary || ""} ${item.links.map((entry) => link(entry.source, entry.url)).join(" · ")}`.trim()).join("\n")}`).join("\n\n");
	}
}

/** The pictures on a card, for whoever proxies them. */
export function embedImages(embed: Embed): string[] {
	if (embed.kind === "offers" || embed.kind === "article") return embed.image ? [embed.image] : [];
	if (embed.kind === "stories") return embed.sections.flatMap((section) => section.items.flatMap((item) => (item.image ? [item.image] : [])));
	return [];
}

/** The same card with every picture address changed (to RemindMe's own picture proxy). */
export function mapImages(embed: Embed, change: (url: string) => string): Embed {
	if ((embed.kind === "offers" || embed.kind === "article") && embed.image) return { ...embed, image: change(embed.image) };
	if (embed.kind === "stories")
		return { ...embed, sections: embed.sections.map((section) => ({ ...section, items: section.items.map((item) => (item.image ? { ...item, image: change(item.image) } : item)) })) };
	return embed;
}
