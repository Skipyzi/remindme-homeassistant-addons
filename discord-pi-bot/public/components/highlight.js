(function exposeHighlight(globalScope) {
	/**
	 * Small syntax highlighter that emits tokens, not markup.
	 *
	 * Every highlighter in common use returns an HTML string, which would mean
	 * feeding model output through innerHTML and trusting the library's
	 * escaping. This one returns {type, value} pairs so richtext.js can build
	 * spans and set textContent, keeping the same rule as the rest of the
	 * renderer: nothing the model wrote ever becomes markup.
	 *
	 * It is deliberately shallow — strings, comments, numbers, keywords and
	 * punctuation. That is most of the readability gain; full grammars are not
	 * worth the weight on a Pi.
	 */

	const KEYWORDS = {
		javascript:
			"await async break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined",
		typescript:
			"await async break case catch class const continue declare default delete do else enum export extends finally for from function if implements import in instanceof interface let new of private protected public readonly return static super switch this throw try type typeof var void while yield true false null undefined",
		python:
			"and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self",
		bash: "if then else elif fi for while do done case esac function return export local readonly source alias echo cd exit set unset trap",
		json: "true false null",
		yaml: "true false null yes no on off",
		css: "important media supports keyframes import charset font-face",
		go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
		rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while",
		sql: "select from where group by order having insert update delete into values join left right inner outer on as and or not null limit offset create table drop alter index",
	};

	const ALIASES = {
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		node: "javascript",
		ts: "typescript",
		tsx: "typescript",
		py: "python",
		python3: "python",
		sh: "bash",
		shell: "bash",
		zsh: "bash",
		console: "bash",
		yml: "yaml",
		rs: "rust",
		golang: "go",
	};

	/** Line-comment prefix and block-comment pair per family. */
	const COMMENTS = {
		javascript: { line: "//", block: ["/*", "*/"] },
		typescript: { line: "//", block: ["/*", "*/"] },
		go: { line: "//", block: ["/*", "*/"] },
		rust: { line: "//", block: ["/*", "*/"] },
		css: { line: null, block: ["/*", "*/"] },
		python: { line: "#", block: null },
		bash: { line: "#", block: null },
		yaml: { line: "#", block: null },
		sql: { line: "--", block: ["/*", "*/"] },
		json: { line: null, block: null },
	};

	function normalize(language) {
		const key = String(language || "").toLowerCase();
		return ALIASES[key] || key;
	}

	function isSupported(language) {
		return Boolean(KEYWORDS[normalize(language)]);
	}

	/**
	 * Tokenise into a flat list. Order matters: comments and strings are
	 * consumed whole so a keyword inside them is never highlighted.
	 */
	function tokenize(code, language) {
		const name = normalize(language);
		const keywords = new Set((KEYWORDS[name] || "").split(" "));
		const comment = COMMENTS[name] || { line: null, block: null };
		const source = String(code || "");
		const tokens = [];
		let plain = "";
		let index = 0;

		const push = (type, value) => {
			if (plain) {
				tokens.push({ type: "plain", value: plain });
				plain = "";
			}
			tokens.push({ type, value });
		};

		while (index < source.length) {
			const rest = source.slice(index);

			if (comment.line && rest.startsWith(comment.line)) {
				const end = source.indexOf("\n", index);
				const stop = end < 0 ? source.length : end;
				push("comment", source.slice(index, stop));
				index = stop;
				continue;
			}
			if (comment.block && rest.startsWith(comment.block[0])) {
				const end = source.indexOf(comment.block[1], index + 2);
				const stop = end < 0 ? source.length : end + comment.block[1].length;
				push("comment", source.slice(index, stop));
				index = stop;
				continue;
			}

			const quote = rest[0];
			if (quote === '"' || quote === "'" || quote === "`") {
				let cursor = index + 1;
				while (cursor < source.length) {
					if (source[cursor] === "\\") {
						cursor += 2;
						continue;
					}
					if (source[cursor] === quote) {
						cursor += 1;
						break;
					}
					cursor += 1;
				}
				push("string", source.slice(index, cursor));
				index = cursor;
				continue;
			}

			const number = /^0[xXbBoO][0-9a-fA-F_]+|^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
			if (number) {
				push("number", number[0]);
				index += number[0].length;
				continue;
			}

			const word = /^[A-Za-z_$][\w$]*/.exec(rest);
			if (word) {
				const value = word[0];
				// A word followed by "(" reads as a call, which is worth marking
				// even though this is not a real parser.
				const after = rest.slice(value.length).match(/^\s*\(/);
				if (keywords.has(value)) push("keyword", value);
				else if (after) push("function", value);
				else plain += value;
				index += value.length;
				continue;
			}

			if (/^[{}[\]().,;:+\-*/%<>=!&|^~?]/.test(rest)) {
				push("punct", rest[0]);
				index += 1;
				continue;
			}

			plain += source[index];
			index += 1;
		}
		if (plain) tokens.push({ type: "plain", value: plain });
		return tokens;
	}

	const api = { tokenize, isSupported, normalize };
	globalScope.RemindMeHighlight = api;
	if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
