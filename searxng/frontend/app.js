/*
 * RemindMe Search — the command line that drives SearXNG's JSON API.
 *
 * The page never leaves the landing template: a submit is intercepted, the
 * query goes to /search?format=json on the same origin, and the results are
 * rendered here. Results are arbitrary web content, so every field is put on
 * the page as a text node and every link's scheme is checked — nothing from a
 * result is ever parsed as markup.
 */
(function () {
	"use strict";

	const form = document.getElementById("search-form");
	const input = document.getElementById("q");
	const prompt = input.closest(".prompt");
	const channelsBox = document.getElementById("channels");
	const categoriesField = document.getElementById("categories");
	const readout = document.getElementById("readout");
	const stage = document.getElementById("stage");
	const suggestBox = document.getElementById("suggest");
	const linkStatus = document.getElementById("link-status");
	const themesBox = document.getElementById("themes");
	const fxLevel = document.getElementById("fx-level");
	const tagline = document.querySelector(".tagline");
	const runKey = document.querySelector(".run-key");
	const boot = document.getElementById("boot");
	const bootLog = document.getElementById("boot-log");

	const THEMES = ["amber", "green", "oled", "light"];
	const THEME_KEY = "remindme.search.theme";
	const IMMERSIONS = ["silent", "standard", "cinematic"];
	const FX_KEY = "remindme.search.immersion";
	let immersion = "standard";

	// The few strings that read differently in-world once the terminal is on.
	// Silent shares the plain set; only Cinematic speaks like a RobCo unit.
	const PLAIN = {
		tagline: "Private metasearch · no logs, no tracking",
		placeholder: "query the open web",
		run: "RUN",
		scanning: "Scanning",
		empty1: "No signal — nothing came back for that.",
		empty2: "Try different words, or switch channel.",
		err1: "Search core unreachable.",
		err2: "SearXNG did not answer. Check the add-on is running.",
	};
	const TERMINAL = {
		tagline: "ATOMLINK TERMINAL · UNIFIED OPERATING SYSTEM",
		placeholder: "enter query",
		run: "EXEC",
		scanning: "Accessing",
		empty1: "NO ENTRIES FOUND.",
		empty2: "Refine the query, or switch data channel.",
		err1: "TERMLINK CONNECTION SEVERED.",
		err2: "The search node did not respond. Verify it is online.",
	};
	const BOOT_LINES = [
		"ATOMLINK TERMINAL · UOS v2.7",
		"ESTABLISHING SECURE UPLINK ..........",
		"NODE  REMINDME-SEARCH  ·  LAN PRIVATE",
		"AUTH  OVERSEER  ·  ACCESS GRANTED",
		"LOADING SEARCH.EXE ...",
		"READY",
	];

	function copy() {
		return immersion === "cinematic" ? TERMINAL : PLAIN;
	}

	let category = "general";
	let state = { query: "", pageno: 1, running: false, exhausted: false };
	let suggestTimer = 0;
	let suggestPick = -1;

	/* ── small helpers ────────────────────────────────────────────────── */

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	/** Only http(s) links are turned into anchors; anything else stays text. */
	function safeUrl(url) {
		const value = String(url || "").trim();
		return /^https?:\/\//i.test(value) ? value : "";
	}

	function prettyUrl(url) {
		try {
			const u = new URL(url);
			return decodeURIComponent(u.host + u.pathname + u.search).replace(/\/$/, "");
		} catch (_) {
			return url;
		}
	}

	function setStatus(mode) {
		linkStatus.setAttribute("data-state", mode);
	}

	function cursorState() {
		prompt.classList.toggle("is-empty", input.value.length === 0);
	}

	/* ── theme ────────────────────────────────────────────────────────── */

	function applyTheme(name) {
		const theme = THEMES.indexOf(name) !== -1 ? name : "amber";
		document.documentElement.setAttribute("data-theme", theme);
		if (themesBox) {
			for (const swatch of themesBox.querySelectorAll(".swatch")) {
				swatch.setAttribute(
					"aria-pressed",
					swatch.getAttribute("data-set") === theme ? "true" : "false",
				);
			}
		}
		try {
			localStorage.setItem(THEME_KEY, theme);
		} catch (_) {
			/* private mode — the choice just will not persist */
		}
	}

	if (themesBox) {
		themesBox.addEventListener("click", function (event) {
			const swatch = event.target.closest(".swatch");
			if (swatch) applyTheme(swatch.getAttribute("data-set"));
		});
	}

	/* ── immersion ────────────────────────────────────────────────────── */

	function reducedMotion() {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	}

	function applyImmersion(name, runBoot) {
		immersion = IMMERSIONS.indexOf(name) !== -1 ? name : "standard";
		document.documentElement.setAttribute("data-immersion", immersion);
		if (fxLevel) {
			fxLevel.setAttribute("data-level", immersion);
			for (const step of fxLevel.querySelectorAll(".fx-step")) {
				step.setAttribute(
					"aria-pressed",
					step.getAttribute("data-fx") === immersion ? "true" : "false",
				);
			}
		}
		const words = copy();
		if (tagline) tagline.textContent = words.tagline;
		if (runKey) runKey.textContent = words.run;
		input.placeholder = words.placeholder;
		try {
			localStorage.setItem(FX_KEY, immersion);
		} catch (_) {
			/* ignore */
		}
		if (immersion === "cinematic") {
			if (runBoot) bootSequence();
		} else {
			dismissBoot(true);
		}
	}

	if (fxLevel) {
		fxLevel.addEventListener("click", function (event) {
			const step = event.target.closest(".fx-step");
			if (step) applyImmersion(step.getAttribute("data-fx"), true);
		});
	}

	/* The boot handshake. A run token lets a fresh boot or a dismiss cancel a
	 * typing pass already in flight. */
	let bootRun = 0;
	function bootSequence() {
		if (!boot || !bootLog) return;
		const token = ++bootRun;
		bootLog.textContent = "";
		boot.classList.remove("off");
		boot.classList.add("on");

		if (reducedMotion()) {
			bootLog.textContent = BOOT_LINES.join("\n");
			window.setTimeout(function () {
				if (token === bootRun) dismissBoot();
			}, 900);
			return;
		}

		const full = BOOT_LINES.join("\n");
		let index = 0;
		const caret = document.createElement("span");
		caret.className = "caret-block";
		function tick() {
			if (token !== bootRun) return;
			index += 1;
			bootLog.textContent = full.slice(0, index);
			bootLog.appendChild(caret);
			if (index < full.length) {
				window.setTimeout(tick, full.charAt(index) === "\n" ? 90 : 16);
			} else {
				window.setTimeout(function () {
					if (token === bootRun) dismissBoot();
				}, 550);
			}
		}
		tick();
	}

	function dismissBoot(immediate) {
		if (!boot || !boot.classList.contains("on")) return;
		bootRun += 1; // cancel any typing in flight
		if (immediate) {
			boot.classList.remove("on", "off");
			return;
		}
		boot.classList.add("off");
		window.setTimeout(function () {
			boot.classList.remove("on", "off");
		}, 420);
	}

	if (boot) {
		boot.addEventListener("click", function () {
			dismissBoot();
		});
	}
	document.addEventListener("keydown", function (event) {
		if (boot && boot.classList.contains("on")) {
			dismissBoot();
			if (event.key === "Escape") event.preventDefault();
		}
	});

	/* ── channels ─────────────────────────────────────────────────────── */

	channelsBox.addEventListener("click", function (event) {
		const button = event.target.closest(".channel");
		if (!button) return;
		category = button.getAttribute("data-cat") || "general";
		categoriesField.value = category;
		for (const tab of channelsBox.querySelectorAll(".channel")) {
			const on = tab === button;
			tab.classList.toggle("is-on", on);
			tab.setAttribute("aria-selected", on ? "true" : "false");
		}
		if (state.query) run(state.query, 1, true);
	});

	/* ── search ───────────────────────────────────────────────────────── */

	function apiUrl(query, pageno) {
		const params = new URLSearchParams({
			q: query,
			format: "json",
			categories: category,
			pageno: String(pageno),
		});
		return "/search?" + params.toString();
	}

	async function run(query, pageno, replace) {
		query = String(query || "").trim();
		if (!query) return;
		hideSuggest();
		state.query = query;
		state.pageno = pageno;
		state.running = true;
		stage.setAttribute("data-mode", "active");
		setStatus("busy");

		if (replace) {
			readout.innerHTML = "";
			readout.appendChild(loadingNotice());
			syncHistory(query);
		}

		let data;
		try {
			const response = await fetch(apiUrl(query, pageno), {
				headers: { Accept: "application/json" },
			});
			if (!response.ok) throw new Error("HTTP " + response.status);
			data = await response.json();
		} catch (error) {
			state.running = false;
			setStatus("error");
			if (replace) {
				readout.innerHTML = "";
				showError();
			}
			return;
		}

		state.running = false;
		setStatus("ok");
		render(data, replace);
	}

	function render(data, replace) {
		const results = Array.isArray(data.results) ? data.results : [];
		if (replace) {
			readout.innerHTML = "";
			if (!results.length) {
				showEmpty();
				return;
			}
			readout.appendChild(metaLine(data));
			const answer = firstAnswer(data.answers);
			if (answer) readout.appendChild(answerCard(answer));
		}

		if (!results.length) {
			state.exhausted = true;
			const more = readout.querySelector(".more");
			if (more) more.remove();
			return;
		}

		const list = ensureList();
		const startRank = list.childElementCount;
		results.forEach(function (result, index) {
			const row =
				category === "images"
					? imageTile(result)
					: resultRow(result, startRank + index + 1);
			if (row) list.appendChild(row);
		});

		if (replace) {
			readout.appendChild(relatedRow(data.suggestions));
			runSweep();
		}
		attachMore();
	}

	/* ── result pieces ────────────────────────────────────────────────── */

	function metaLine(data) {
		const meta = el("div", "meta");
		meta.appendChild(el("span", null, "Channel"));
		const name = el("b", null, category.toUpperCase());
		meta.appendChild(name);
		const total = Number(data.number_of_results || 0);
		if (total > 0) {
			meta.appendChild(el("span", null, "· approx " + total.toLocaleString() + " hits"));
		}
		return meta;
	}

	function firstAnswer(answers) {
		if (!Array.isArray(answers) || !answers.length) return "";
		const first = answers[0];
		if (typeof first === "string") return first;
		return first && (first.answer || first.text) ? first.answer || first.text : "";
	}

	function answerCard(text) {
		const card = el("div", "answer");
		card.appendChild(el("div", "answer-tag", "Direct answer"));
		card.appendChild(el("div", "answer-body", text));
		return card;
	}

	function ensureList() {
		let list = readout.querySelector(".rows, .grid");
		if (!list) {
			list = el("div", category === "images" ? "grid" : "rows");
			readout.appendChild(list);
		}
		return list;
	}

	function resultRow(result, rank) {
		const row = el("div", "row");
		row.appendChild(el("div", "rank", String(rank).padStart(3, "0")));
		const main = el("div", "row-main");

		const href = safeUrl(result.url);
		const title = String(result.title || result.url || "Untitled").trim();
		if (href) {
			const link = el("a", "row-title", title);
			link.href = href;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			main.appendChild(link);
			main.appendChild(el("span", "row-url", prettyUrl(href)));
		} else {
			main.appendChild(el("span", "row-title", title));
		}

		const snippet = String(result.content || "").trim();
		if (snippet) main.appendChild(el("div", "row-snippet", snippet));

		const line = el("div", "row-engines");
		if (result.publishedDate) {
			line.appendChild(el("span", "row-published", shortDate(result.publishedDate)));
		}
		const engines = result.engines && result.engines.length ? result.engines : [result.engine];
		line.appendChild(document.createTextNode(engines.filter(Boolean).join(" · ")));
		main.appendChild(line);

		row.appendChild(main);
		return row;
	}

	function imageTile(result) {
		const src = safeUrl(result.thumbnail_src) || safeUrl(result.thumbnail) || safeUrl(result.img_src);
		const href = safeUrl(result.url) || safeUrl(result.img_src);
		if (!src) return null;
		const tile = el("a", "tile");
		if (href) {
			tile.href = href;
			tile.target = "_blank";
			tile.rel = "noopener noreferrer";
		}
		const img = document.createElement("img");
		img.src = src;
		img.loading = "lazy";
		img.alt = String(result.title || "");
		img.addEventListener("error", function () {
			tile.remove();
		});
		tile.appendChild(img);
		if (result.title) tile.appendChild(el("span", "tile-cap", String(result.title)));
		return tile;
	}

	function relatedRow(suggestions) {
		if (!Array.isArray(suggestions) || !suggestions.length) return document.createDocumentFragment();
		const box = el("div", "related");
		box.appendChild(el("span", "related-label", "Related"));
		suggestions.slice(0, 10).forEach(function (text) {
			const chip = el("button", "chip", String(text));
			chip.type = "button";
			chip.addEventListener("click", function () {
				input.value = text;
				cursorState();
				run(text, 1, true);
			});
			box.appendChild(chip);
		});
		return box;
	}

	function attachMore() {
		let more = readout.querySelector(".more");
		if (state.exhausted) {
			if (more) more.remove();
			return;
		}
		if (!more) {
			more = el("button", "more", "Load more");
			more.type = "button";
			more.addEventListener("click", function () {
				if (state.running) return;
				more.textContent = "Scanning…";
				more.disabled = true;
				run(state.query, state.pageno + 1, false).then(function () {
					const still = readout.querySelector(".more");
					if (still) {
						still.textContent = "Load more";
						still.disabled = false;
					}
				});
			});
		}
		readout.appendChild(more); // keep it last
	}

	/* ── notices ──────────────────────────────────────────────────────── */

	function loadingNotice() {
		const notice = el("div", "notice");
		const scan = el("div", "scan");
		scan.appendChild(el("span", null, copy().scanning));
		scan.appendChild(el("span", "scan-bar"));
		notice.appendChild(scan);
		return notice;
	}

	function showEmpty() {
		state.exhausted = true;
		const notice = el("div", "notice");
		notice.appendChild(el("div", "line", copy().empty1));
		notice.appendChild(el("div", null, copy().empty2));
		readout.appendChild(notice);
	}

	function showError() {
		const notice = el("div", "notice error");
		notice.appendChild(el("div", "line", copy().err1));
		notice.appendChild(el("div", null, copy().err2));
		readout.appendChild(notice);
	}

	function runSweep() {
		readout.classList.remove("sweep");
		void readout.offsetWidth; // restart the animation
		readout.classList.add("sweep");
	}

	function shortDate(value) {
		const date = new Date(value);
		if (isNaN(date.getTime())) return "";
		return date.toISOString().slice(0, 10);
	}

	/* ── autocomplete ─────────────────────────────────────────────────── */

	async function fetchSuggest(query) {
		try {
			const response = await fetch(
				"/autocompleter?" + new URLSearchParams({ q: query }).toString(),
				{ headers: { Accept: "application/json" } },
			);
			if (!response.ok) return [];
			const data = await response.json();
			// SearXNG replies ["query", ["s1", "s2", ...]] when a backend is set.
			if (Array.isArray(data) && Array.isArray(data[1])) return data[1];
			return [];
		} catch (_) {
			return [];
		}
	}

	function showSuggest(items) {
		suggestBox.innerHTML = "";
		suggestPick = -1;
		if (!items.length) {
			hideSuggest();
			return;
		}
		items.slice(0, 8).forEach(function (text) {
			const item = el("button", "suggest-item", String(text));
			item.type = "button";
			item.addEventListener("mousedown", function (event) {
				event.preventDefault(); // keep focus off the button
				input.value = text;
				cursorState();
				run(text, 1, true);
			});
			suggestBox.appendChild(item);
		});
		suggestBox.hidden = false;
	}

	function hideSuggest() {
		suggestBox.hidden = true;
		suggestBox.innerHTML = "";
		suggestPick = -1;
	}

	function moveSuggest(step) {
		const items = suggestBox.querySelectorAll(".suggest-item");
		if (!items.length) return;
		suggestPick = (suggestPick + step + items.length) % items.length;
		items.forEach(function (item, index) {
			const on = index === suggestPick;
			item.setAttribute("aria-selected", on ? "true" : "false");
			if (on) input.value = item.textContent;
		});
		cursorState();
	}

	/* ── input wiring ─────────────────────────────────────────────────── */

	input.addEventListener("input", function () {
		cursorState();
		const query = input.value.trim();
		clearTimeout(suggestTimer);
		if (query.length < 2) {
			hideSuggest();
			return;
		}
		suggestTimer = window.setTimeout(async function () {
			if (input.value.trim() !== query) return;
			showSuggest(await fetchSuggest(query));
		}, 180);
	});

	input.addEventListener("keydown", function (event) {
		if (suggestBox.hidden) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveSuggest(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			moveSuggest(-1);
		} else if (event.key === "Escape") {
			hideSuggest();
		}
	});

	input.addEventListener("blur", function () {
		window.setTimeout(hideSuggest, 120);
	});

	form.addEventListener("submit", function (event) {
		event.preventDefault();
		state.exhausted = false;
		run(input.value, 1, true);
		input.blur();
	});

	/* ── history & boot ───────────────────────────────────────────────── */

	function syncHistory(query) {
		const params = new URLSearchParams({ q: query });
		if (category !== "general") params.set("categories", category);
		history.replaceState({ query: query, category: category }, "", "?" + params.toString());
	}

	function start() {
		let storedTheme = null;
		let storedFx = null;
		try {
			storedTheme = localStorage.getItem(THEME_KEY);
			storedFx = localStorage.getItem(FX_KEY);
		} catch (_) {
			/* ignore */
		}
		applyTheme(storedTheme || "amber");
		applyImmersion(storedFx || "standard", true);
		cursorState();
		input.focus();
		const params = new URLSearchParams(location.search);
		const query = params.get("q");
		const cat = params.get("categories");
		if (cat) {
			category = cat;
			categoriesField.value = cat;
			for (const tab of channelsBox.querySelectorAll(".channel")) {
				const on = tab.getAttribute("data-cat") === cat;
				tab.classList.toggle("is-on", on);
				tab.setAttribute("aria-selected", on ? "true" : "false");
			}
		}
		if (query) {
			input.value = query;
			cursorState();
			state.exhausted = false;
			run(query, 1, true);
		}
	}

	start();
})();
