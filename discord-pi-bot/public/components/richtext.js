(function exposeRichText(globalScope) {
	/**
	 * Markdown renderer that builds DOM nodes rather than HTML.
	 *
	 * The whole design turns on one rule: model output is never parsed as
	 * markup. Text becomes text nodes and structure becomes elements this
	 * module creates, so there is no path by which a reply containing
	 * "<img onerror=…>" can become an element. That also means no HTML
	 * sanitiser to keep correct, and no markdown library to ship.
	 *
	 * Maths is delegated to RemindMeMath, which is the only thing allowed to
	 * produce markup — and only from LaTeX it generated itself.
	 */

	const FENCE = /^```([\w+-]*)\s*$/;
	const HEADING = /^(#{1,6})\s+(.*)$/;
	const BULLET = /^\s*[-*+]\s+(.*)$/;
	const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
	const QUOTE = /^>\s?(.*)$/;
	const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
	const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

	/** Only schemes that cannot execute script. */
	function safeHref(url) {
		const trimmed = String(url || "").trim();
		if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
		// Protocol-relative and bare domains are treated as https.
		if (/^\/\//.test(trimmed)) return `https:${trimmed}`;
		return "";
	}

	/**
	 * Inline pass: code, bold, italic, links, then maths on what is left.
	 * Ordered so that code spans win — backticks protect their contents from
	 * every other rule, which is what stops `**` inside code being eaten.
	 */
	function appendInline(parent, text) {
		const source = String(text || "");
		let index = 0;
		let literal = "";

		const flush = () => {
			if (!literal) return;
			// Hand the remaining prose to the maths renderer, which appends
			// text nodes for anything that is not an equation.
			if (globalScope.RemindMeMath) {
				const holder = document.createElement("span");
				globalScope.RemindMeMath.render(holder, literal);
				while (holder.firstChild) parent.appendChild(holder.firstChild);
			} else {
				parent.appendChild(document.createTextNode(literal));
			}
			literal = "";
		};

		while (index < source.length) {
			const rest = source.slice(index);

			const code = /^`([^`]+)`/.exec(rest);
			if (code) {
				flush();
				const element = document.createElement("code");
				element.className = "rt-code";
				element.textContent = code[1];
				parent.appendChild(element);
				index += code[0].length;
				continue;
			}

			const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
			if (link) {
				const href = safeHref(link[2]);
				flush();
				if (href) {
					const anchor = document.createElement("a");
					anchor.href = href;
					anchor.target = "_blank";
					anchor.rel = "noopener noreferrer";
					appendInline(anchor, link[1] || href);
					parent.appendChild(anchor);
				} else {
					// Unsafe scheme: show the label, never the link.
					parent.appendChild(document.createTextNode(link[1] || ""));
				}
				index += link[0].length;
				continue;
			}

			const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
			if (strong) {
				flush();
				const element = document.createElement("strong");
				appendInline(element, strong[2]);
				parent.appendChild(element);
				index += strong[0].length;
				continue;
			}

			const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
			if (strike) {
				flush();
				const element = document.createElement("del");
				appendInline(element, strike[1]);
				parent.appendChild(element);
				index += strike[0].length;
				continue;
			}

			// Single * or _ , but not when it is part of ** or a snake_case word.
			const emphasis = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?!\w)/.exec(rest);
			if (emphasis && !/^(\*\*|__)/.test(rest)) {
				flush();
				const element = document.createElement("em");
				appendInline(element, emphasis[2]);
				parent.appendChild(element);
				index += emphasis[0].length;
				continue;
			}

			literal += source[index];
			index += 1;
		}
		flush();
	}

	/** A fenced block: language chip, copy button, and the code verbatim. */
	function codeBlock(language, code) {
		const wrapper = document.createElement("div");
		wrapper.className = "rt-pre";

		const head = document.createElement("div");
		head.className = "rt-pre-head";
		const label = document.createElement("span");
		label.className = "rt-lang";
		label.textContent = language || "text";
		const copy = document.createElement("button");
		copy.type = "button";
		copy.className = "rt-copy";
		copy.textContent = "COPY";
		copy.addEventListener("click", () => {
			navigator.clipboard?.writeText(code).then(
				() => {
					copy.textContent = "COPIED";
					setTimeout(() => {
						copy.textContent = "COPY";
					}, 1200);
				},
				() => {
					copy.textContent = "FAILED";
				},
			);
		});
		head.append(label, copy);

		const pre = document.createElement("pre");
		const element = document.createElement("code");
		const highlighter = globalScope.RemindMeHighlight;
		if (highlighter && highlighter.isSupported(language)) {
			// Tokens, not markup: each span gets textContent, so highlighted
			// code is still incapable of carrying an element.
			for (const token of highlighter.tokenize(code, language)) {
				if (token.type === "plain") {
					element.appendChild(document.createTextNode(token.value));
					continue;
				}
				const span = document.createElement("span");
				span.className = `tok-${token.type}`;
				span.textContent = token.value;
				element.appendChild(span);
			}
		} else {
			element.textContent = code;
		}
		pre.appendChild(element);
		wrapper.append(head, pre);
		return wrapper;
	}

	function listBlock(ordered, items) {
		const list = document.createElement(ordered ? "ol" : "ul");
		list.className = "rt-list";
		for (const item of items) {
			const entry = document.createElement("li");
			appendInline(entry, item);
			list.appendChild(entry);
		}
		return list;
	}

	function tableBlock(rows) {
		const table = document.createElement("table");
		table.className = "rt-table";
		const cells = (line) =>
			line
				.replace(/^\s*\|/, "")
				.replace(/\|\s*$/, "")
				.split("|")
				.map((cell) => cell.trim());
		const head = document.createElement("thead");
		const headRow = document.createElement("tr");
		for (const cell of cells(rows[0])) {
			const th = document.createElement("th");
			appendInline(th, cell);
			headRow.appendChild(th);
		}
		head.appendChild(headRow);
		table.appendChild(head);
		const body = document.createElement("tbody");
		for (const line of rows.slice(2)) {
			const row = document.createElement("tr");
			for (const cell of cells(line)) {
				const td = document.createElement("td");
				appendInline(td, cell);
				row.appendChild(td);
			}
			body.appendChild(row);
		}
		table.appendChild(body);
		return table;
	}

	/**
	 * Block pass. Deliberately line-driven and forgiving: replies stream in, so
	 * an unterminated fence is rendered as code rather than held back until its
	 * closing backticks arrive.
	 */
	function render(element, text) {
		if (!element) return;
		element.textContent = "";
		element.classList.add("rt");
		const lines = String(text || "").split("\n");
		let index = 0;
		let paragraph = [];

		const flushParagraph = () => {
			if (!paragraph.length) return;
			const block = document.createElement("p");
			block.className = "rt-p";
			appendInline(block, paragraph.join("\n"));
			element.appendChild(block);
			paragraph = [];
		};

		while (index < lines.length) {
			const line = lines[index];

			const fence = FENCE.exec(line);
			if (fence) {
				flushParagraph();
				const language = fence[1];
				const body = [];
				index += 1;
				while (index < lines.length && !FENCE.test(lines[index])) {
					body.push(lines[index]);
					index += 1;
				}
				index += 1; // consume the closing fence, if it arrived
				element.appendChild(codeBlock(language, body.join("\n")));
				continue;
			}

			if (RULE.test(line)) {
				flushParagraph();
				element.appendChild(document.createElement("hr"));
				index += 1;
				continue;
			}

			const heading = HEADING.exec(line);
			if (heading) {
				flushParagraph();
				const level = Math.min(6, heading[1].length);
				const node = document.createElement(`h${level}`);
				node.className = "rt-h";
				appendInline(node, heading[2]);
				element.appendChild(node);
				index += 1;
				continue;
			}

			if (
				line.includes("|") &&
				index + 1 < lines.length &&
				TABLE_DIVIDER.test(lines[index + 1])
			) {
				flushParagraph();
				const rows = [];
				while (index < lines.length && lines[index].includes("|")) {
					rows.push(lines[index]);
					index += 1;
				}
				element.appendChild(tableBlock(rows));
				continue;
			}

			if (QUOTE.test(line)) {
				flushParagraph();
				const body = [];
				while (index < lines.length && QUOTE.test(lines[index])) {
					body.push(QUOTE.exec(lines[index])[1]);
					index += 1;
				}
				const quote = document.createElement("blockquote");
				quote.className = "rt-quote";
				appendInline(quote, body.join("\n"));
				element.appendChild(quote);
				continue;
			}

			if (BULLET.test(line) || ORDERED.test(line)) {
				flushParagraph();
				const ordered = ORDERED.test(line);
				const items = [];
				while (index < lines.length) {
					const match = ordered
						? ORDERED.exec(lines[index])
						: BULLET.exec(lines[index]);
					if (!match) break;
					items.push(ordered ? match[2] : match[1]);
					index += 1;
				}
				element.appendChild(listBlock(ordered, items));
				continue;
			}

			if (!line.trim()) {
				flushParagraph();
				index += 1;
				continue;
			}

			paragraph.push(line);
			index += 1;
		}
		flushParagraph();
	}

	const api = { render, appendInline, safeHref };
	globalScope.RemindMeRichText = api;
	if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
