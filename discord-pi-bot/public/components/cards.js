(function (globalScope) {
	"use strict";

	/**
	 * Cards under an answer: offers, a place with its map, articles, the
	 * news. Like richtext, it builds DOM nodes and never parses markup, so
	 * nothing a shop or news page wrote can become an element. Pictures come
	 * through RemindMe's own proxy (./api/media), map tiles from ./api/tiles.
	 */

	/** Only links that can't run script: web pages and phone numbers. */
	function safeHref(url) {
		const value = String(url || "").trim();
		return /^(https?:|tel:\+?[\d]+$)/i.test(value) ? value : "";
	}

	/** Pictures only from RemindMe itself. */
	function safeSrc(url) {
		const value = String(url || "").trim();
		return /^\.\/api\/(media|tiles)\b/.test(value) ? value : "";
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined && text !== null) node.textContent = String(text);
		return node;
	}

	function anchor(className, href, text) {
		const node = el("a", className, text);
		const safe = safeHref(href);
		if (safe) {
			node.href = safe;
			if (/^https?:/i.test(safe)) {
				node.target = "_blank";
				node.rel = "noopener noreferrer";
			}
		}
		return node;
	}

	/** A picture that goes away without a trace when it doesn't load. */
	function picture(src, className, onFail) {
		const safe = safeSrc(src);
		if (!safe) return null;
		const img = el("img", className);
		img.src = safe;
		img.alt = "";
		img.loading = "lazy";
		img.decoding = "async";
		img.addEventListener("error", () => {
			img.remove();
			if (onFail) onFail();
		});
		return img;
	}

	function host(url) {
		try {
			return new URL(url).hostname.replace(/^www\./, "");
		} catch {
			return "";
		}
	}

	function when(iso) {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
	}

	/* ── Offers: the product, its cheapest few, where it's watched ── */
	function offers(card) {
		const box = el("div", "rm-card");
		const head = el("div", "rm-card-head");
		const image = picture(card.image, "", () => head.classList.add("no-pic"));
		if (image) head.append(image);
		else head.classList.add("no-pic");
		const words = el("span");
		words.append(el("b", "", card.title), el("span", "", card.meta));
		head.append(words);
		const list = el("ul", "rm-offers");
		(card.offers || []).forEach((offer, index) => {
			const row = el("li", index === 0 ? "rm-best" : "");
			row.append(el("span", "rm-price", offer.price), el("span", "", offer.shop));
			if (offer.note) row.append(el("small", "", offer.note));
			list.append(row);
		});
		const acts = el("div", "rm-card-acts");
		acts.append(anchor("rm-link", card.url, `Open on ${host(card.url) || "the site"}`));
		if (card.watching) acts.append(el("span", "rm-card-note", `✓ ${card.watching}`));
		box.append(head, list, acts);
		return box;
	}

	/* ── A place: the map around it, whether it's open, what to tap ── */
	const ZOOM = 16;
	function mapOf(lat, lon) {
		const map = el("div", "rm-map");
		const scale = 2 ** ZOOM;
		const x = ((lon + 180) / 360) * scale;
		const y = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * scale;
		const tiles = el("div", "rm-map-tiles");
		const firstX = Math.floor(x) - 1;
		const firstY = Math.floor(y) - 1;
		// Three by three tiles, placed so the place sits in the middle of the card.
		tiles.style.left = `calc(50% - ${Math.round((x - firstX) * 256)}px)`;
		tiles.style.top = `calc(50% - ${Math.round((y - firstY) * 256)}px)`;
		for (let row = 0; row < 3; row++)
			for (let column = 0; column < 3; column++) {
				const tile = picture(`./api/tiles/${ZOOM}/${firstX + column}/${firstY + row}`, "");
				if (!tile) continue;
				tile.style.left = `${column * 256}px`;
				tile.style.top = `${row * 256}px`;
				tiles.append(tile);
			}
		map.append(tiles, el("span", "rm-map-pin"), el("span", "rm-map-credit", "© OpenStreetMap"));
		return map;
	}

	function place(card) {
		const box = el("div", "rm-card");
		if (Number.isFinite(card.lat) && Number.isFinite(card.lon)) box.append(mapOf(card.lat, card.lon));
		const body = el("div", "rm-place");
		body.append(el("b", "", card.name));
		if (card.status) body.append(el("p", card.status.open ? "rm-open" : "rm-closed", card.status.text));
		for (const line of card.lines || []) body.append(el("p", "", line));
		box.append(body);
		const links = (card.links || []).filter((link) => safeHref(link.url));
		if (links.length) {
			const acts = el("div", "rm-card-acts");
			for (const link of links) acts.append(anchor("rm-link", link.url, link.label));
			box.append(acts);
		}
		return box;
	}

	/* ── Articles: one as a row, several on a shelf you swipe ── */
	function articleRow(card) {
		const row = anchor("rm-story", card.url);
		const image = picture(card.image, "", () => row.classList.add("textonly"));
		if (image) row.append(image);
		else row.classList.add("textonly");
		const words = el("span");
		words.append(el("b", "", card.title));
		if (card.summary) words.append(el("p", "", card.summary));
		words.append(el("span", "", [card.source, card.at ? when(card.at) : ""].filter(Boolean).join(" · ")));
		row.append(words);
		return row;
	}

	function shelf(cards) {
		const box = el("div", "rm-shelf");
		for (const card of cards) {
			const item = anchor("rm-card", card.url);
			const image = picture(card.image, "", () => item.classList.add("textonly"));
			if (image) item.append(image);
			else item.classList.add("textonly");
			const words = el("span", "rm-art");
			words.append(el("b", "", card.title), el("span", "", [card.source, card.at ? when(card.at) : ""].filter(Boolean).join(" · ")));
			item.append(words);
			box.append(item);
		}
		return box;
	}

	/* ── The news: sections, each story with its picture and sources ── */
	function stories(card) {
		const box = el("div", "rm-stories");
		for (const section of card.sections || []) {
			box.append(el("p", "rm-stories-label", section.label));
			for (const item of section.items || []) {
				const row = el("div", "rm-story");
				const image = picture(item.image, "", () => row.classList.add("textonly"));
				if (image) row.append(image);
				else row.classList.add("textonly");
				const words = el("span");
				words.append(el("b", "", item.title));
				if (item.summary) words.append(el("p", "", item.summary));
				const sources = el("span", "rm-story-links");
				(item.links || []).forEach((link, index) => {
					if (index) sources.append(document.createTextNode(" · "));
					sources.append(anchor("", link.url, link.source));
				});
				words.append(sources);
				row.append(words);
				box.append(row);
			}
		}
		return box;
	}

	function render(element, cards) {
		element.replaceChildren();
		const list = Array.isArray(cards) ? cards : [];
		for (let index = 0; index < list.length; index++) {
			const card = list[index];
			if (!card || typeof card !== "object") continue;
			if (card.kind === "article") {
				// Articles next to each other share a shelf; a lone one is a row.
				const run = [card];
				while (list[index + 1]?.kind === "article") run.push(list[++index]);
				if (run.length === 1) {
					const box = el("div", "rm-card rm-card-row");
					box.append(articleRow(card));
					element.append(box);
				} else element.append(shelf(run));
			} else if (card.kind === "offers") element.append(offers(card));
			else if (card.kind === "place") element.append(place(card));
			else if (card.kind === "stories") element.append(stories(card));
		}
	}

	globalScope.RemindMeEmbeds = { render };
})(typeof window !== "undefined" ? window : globalThis);
