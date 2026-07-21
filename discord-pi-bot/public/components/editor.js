(function exposeEditor(globalScope) {
	/**
	 * The artifact source editor.
	 *
	 * A bare textarea is a poor place to read a shader: no line to point an
	 * error at, no colour to separate a keyword from a swizzle, and Tab
	 * leaves the field instead of indenting. This adds the three things that
	 * cost least and matter most — a gutter, highlighting, and keys that
	 * behave like an editor — without pulling in a code-editor library that
	 * would outweigh everything else the console ships.
	 *
	 * Highlighting is a layer *behind* a transparent textarea. The textarea
	 * keeps focus, selection, undo and IME; the layer only paints. They stay
	 * aligned because both use the same font, padding and wrapping, and the
	 * layer is scrolled to follow.
	 */

	const INDENT = "  ";

	/** Which grammar to colour a kind with. */
	const LANGUAGES = {
		glsl: "glsl",
		wgsl: "wgsl",
		lua: "lua",
		three: "javascript",
		html: "html",
		svg: "svg",
		markdown: "markdown",
	};

	function languageFor(artifact) {
		if (!artifact) return "";
		return LANGUAGES[artifact.kind] || artifact.language || "";
	}

	/**
	 * Paint the highlight layer.
	 *
	 * Tokens become spans with textContent, never innerHTML — the same rule
	 * the transcript renderer follows, and the reason the highlighter emits
	 * tokens rather than markup.
	 */
	function paint(element, source, language) {
		if (!element) return;
		element.textContent = "";
		const text = String(source || "");
		const highlighter = globalScope.RemindMeHighlight;
		if (!highlighter || !language || !highlighter.isSupported(language)) {
			element.textContent = text;
			return;
		}
		const fragment = document.createDocumentFragment();
		for (const token of highlighter.tokenize(text, language)) {
			if (token.type === "plain") {
				fragment.append(document.createTextNode(token.value));
				continue;
			}
			const span = document.createElement("span");
			span.className = `tok-${token.type}`;
			span.textContent = token.value;
			fragment.append(span);
		}
		/* A trailing newline leaves the last line unrendered in a <pre>. */
		fragment.append(document.createTextNode("\n"));
		element.append(fragment);
	}

	function lineCount(source) {
		return String(source || "").split("\n").length;
	}

	/** The gutter is plain text: one number per line, right aligned by CSS. */
	function gutterText(source) {
		const total = lineCount(source);
		const lines = [];
		for (let line = 1; line <= total; line += 1) lines.push(String(line));
		return lines.join("\n");
	}

	function replaceSelection(field, text, selectionStart, selectionEnd) {
		field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
		if (selectionStart !== undefined)
			field.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
	}

	/** The line boundaries covering the current selection. */
	function selectedLines(field) {
		const value = field.value;
		const start = value.lastIndexOf("\n", field.selectionStart - 1) + 1;
		let end = value.indexOf("\n", field.selectionEnd);
		if (end === -1) end = value.length;
		return { start, end };
	}

	function indentBlock(field, outdent) {
		const { start, end } = selectedLines(field);
		const block = field.value.slice(start, end);
		const changed = block
			.split("\n")
			.map((line) =>
				outdent
					? line.replace(new RegExp(`^ {1,${INDENT.length}}`), "")
					: INDENT + line,
			)
			.join("\n");
		field.setSelectionRange(start, end);
		field.setRangeText(changed, start, end, "select");
	}

	/**
	 * Editor key handling. Returns true when the event was consumed, so the
	 * caller knows to stop it reaching the browser's own behaviour.
	 */
	function handleKey(event, field) {
		if (event.key === "Tab") {
			event.preventDefault();
			const spansLines =
				field.selectionStart !== field.selectionEnd &&
				field.value.slice(field.selectionStart, field.selectionEnd).includes("\n");
			if (event.shiftKey || spansLines) indentBlock(field, event.shiftKey);
			else replaceSelection(field, INDENT);
			return true;
		}
		if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
			/* Carry the current line's indentation onto the next one, and add
			 * a level after a line that opens a block. */
			const value = field.value;
			const lineStart = value.lastIndexOf("\n", field.selectionStart - 1) + 1;
			const before = value.slice(lineStart, field.selectionStart);
			const indent = (before.match(/^[ \t]*/) || [""])[0];
			const opens = /[{([]\s*$/.test(before);
			if (!indent && !opens) return false;
			event.preventDefault();
			replaceSelection(field, `\n${indent}${opens ? INDENT : ""}`);
			return true;
		}
		return false;
	}

	/** Keep the painted layer and the gutter under the textarea's scroll. */
	function syncScroll(field) {
		const wrap = field.closest(".editor-input");
		const layer = wrap?.querySelector(".editor-highlight");
		const gutter = field
			.closest(".editor-body")
			?.querySelector(".editor-gutter");
		if (layer) {
			layer.scrollTop = field.scrollTop;
			layer.scrollLeft = field.scrollLeft;
		}
		if (gutter) gutter.scrollTop = field.scrollTop;
	}

	globalScope.RemindMeEditor = {
		INDENT,
		languageFor,
		paint,
		gutterText,
		lineCount,
		handleKey,
		syncScroll,
	};
	if (typeof module !== "undefined" && module.exports)
		module.exports = globalScope.RemindMeEditor;
})(typeof window !== "undefined" ? window : globalThis);
