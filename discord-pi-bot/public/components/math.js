(function exposeMath(globalScope) {
	/**
	 * Render a message body that may contain LaTeX.
	 *
	 * Security note: model output is never inserted as HTML. Literal text is
	 * added as text nodes, and only KaTeX's own output — generated from the
	 * LaTeX source by the library, which escapes markup in \text{} — is
	 * inserted as markup. That keeps a model that emits an <img onerror=...>
	 * from doing anything.
	 *
	 * KaTeX runs in MathML mode so the browser renders with its own maths
	 * fonts. That avoids shipping ~1 MB of KaTeX web fonts to a Pi.
	 */

	// Display first: $$…$$ and \[…\] before their inline counterparts, so a
	// display block is never mistaken for two inline spans.
	const PATTERNS = [
		{ open: "$$", close: "$$", display: true },
		{ open: "\\[", close: "\\]", display: true },
		{ open: "\\(", close: "\\)", display: false },
		{ open: "$", close: "$", display: false },
	];

	/**
	 * Split text into literal and maths segments. Hand-scanned rather than
	 * regex'd because `$` is ambiguous — "$5 and $7" is money, not maths.
	 */
	function segment(text) {
		const source = String(text || "");
		const segments = [];
		let literal = "";
		let index = 0;

		while (index < source.length) {
			const match = PATTERNS.find((pattern) =>
				source.startsWith(pattern.open, index),
			);
			if (!match) {
				literal += source[index];
				index += 1;
				continue;
			}
			const from = index + match.open.length;
			const closeAt = source.indexOf(match.close, from);
			if (closeAt < 0) {
				// Unterminated: treat as ordinary text rather than eating the rest.
				literal += source[index];
				index += 1;
				continue;
			}
			const body = source.slice(from, closeAt);
			// A single `$` only opens maths when it hugs its content, which is
			// what separates `$x$` from a price range.
			const hugging = !/^\s|\s$/.test(body);
			if (!body.trim() || (match.open === "$" && !hugging)) {
				literal += source[index];
				index += 1;
				continue;
			}
			if (literal) {
				segments.push({ type: "text", value: literal });
				literal = "";
			}
			segments.push({ type: "math", value: body, display: match.display });
			index = closeAt + match.close.length;
		}
		if (literal) segments.push({ type: "text", value: literal });
		return segments;
	}

	function hasMath(text) {
		return segment(text).some((part) => part.type === "math");
	}

	/** Replace an element's contents with the rendered message. */
	function render(element, text) {
		if (!element) return;
		const parts = segment(text);
		// Nothing to render: keep it a plain text node, which is cheapest and
		// keeps whitespace handling identical to before.
		if (!parts.some((part) => part.type === "math")) {
			element.textContent = String(text || "");
			return;
		}
		element.textContent = "";
		for (const part of parts) {
			if (part.type === "text") {
				element.appendChild(document.createTextNode(part.value));
				continue;
			}
			const host = document.createElement(part.display ? "div" : "span");
			host.className = part.display ? "math-display" : "math-inline";
			if (!globalScope.katex) {
				// Library missing: show the source rather than nothing.
				host.textContent = part.display
					? `$$${part.value}$$`
					: `$${part.value}$`;
			} else {
				host.innerHTML = globalScope.katex.renderToString(part.value, {
					output: "mathml",
					throwOnError: false,
					displayMode: part.display,
				});
			}
			element.appendChild(host);
		}
	}

	const api = { render, segment, hasMath };
	globalScope.RemindMeMath = api;
	if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
