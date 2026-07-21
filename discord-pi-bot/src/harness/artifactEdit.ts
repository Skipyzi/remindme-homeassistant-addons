/**
 * Partial edits to an artifact, and the view of the result the model is
 * given back.
 *
 * The model quotes the chunk it wants changed rather than pointing at line
 * numbers: a 1.7B model miscounts lines, and an off-by-one there silently
 * overwrites the wrong code. A quote that does not match fails loudly
 * instead, which the model can see and correct.
 */

export interface EditResult {
	content: string;
	replacements: number;
	/** True when the call was a whole-document rewrite wearing an edit's clothes. */
	rewrote?: boolean;
	/** True when the quote only matched once whitespace was normalised. */
	loose?: boolean;
}

export interface EditFailure {
	error: string;
}

export function isEditFailure(
	result: EditResult | EditFailure,
): result is EditFailure {
	return "error" in result;
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/* The elements a document is allowed exactly one of. */
const ROOTS = [/<html[\s>]/gi, /<\/html\s*>/gi, /<body[\s>]/gi, /<\/body\s*>/gi];

function duplicatesRoot(text: string): boolean {
	return ROOTS.some((pattern) => (text.match(pattern) || []).length > 1);
}

const firstLine = (text: string) => text.split("\n")[0].trim();

/**
 * Is this an edit at all, or a rewrite in an edit's clothing?
 *
 * A small model asked to change a document will very often quote its first
 * tag — `<html>` — and pass a whole rewritten document as the replacement.
 * Splicing that literally welds the new document onto the tail of the old
 * one: two `<body>` elements, two `</html>`, and a page that renders as
 * gibberish. The model's intent is not in doubt, only its aim.
 *
 * Rather than guess from the shape of the arguments, this splices the edit
 * and asks whether the result is a broken document. That distinguishes the
 * case that matters from the one it must not catch — adding a large
 * `<section>` before `</body>` is enormous, and still leaves one of each
 * root, so it stays an edit.
 */
export function looksLikeRewrite(
	content: string,
	oldString: string,
	newString: string,
): boolean {
	if (!content || !newString) return false;
	// A quote covering half the document is a legitimate wholesale edit.
	if (oldString.length >= content.length * 0.5) return false;
	// A replacement far smaller than the document is a fragment, not a draft.
	if (newString.length < content.length * 0.5) return false;
	if (duplicatesRoot(content)) return false; // already malformed; leave it alone
	if (duplicatesRoot(content.replace(oldString, () => newString))) return true;
	/*
	 * Documents with no root element to duplicate — markdown, code, svg
	 * fragments. There the tell is that the replacement begins the way the
	 * document already begins, so it is a new draft of the same thing.
	 */
	return Boolean(
		firstLine(newString) && firstLine(newString) === firstLine(content),
	);
}

/** Collapse runs of whitespace so indentation cannot decide a match. */
function loosePattern(text: string): RegExp {
	const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(escaped.replace(/\s+/g, "\\s+"), "g");
}

/**
 * Replace `oldString` with `newString`.
 *
 * An ambiguous quote is an error, not a coin toss: "2025" appears in the
 * footer and the copyright and the meta tag, and picking one at random is
 * how a document quietly becomes wrong. The model is told how many it hit
 * so it can quote more of the surrounding lines.
 *
 * Matching is tried exactly first and then with whitespace collapsed. A
 * model that retypes a chunk rather than copying it gets the indentation
 * wrong far more often than it gets the words wrong, and failing that call
 * teaches it nothing it can act on.
 */
export function applyEdit(
	content: string,
	oldString: string,
	newString: string,
	replaceAll = false,
): EditResult | EditFailure {
	if (!oldString)
		return { error: "old_string is required and cannot be empty" };
	if (oldString === newString)
		return { error: "old_string and new_string are identical" };

	if (looksLikeRewrite(content, oldString, newString))
		return { content: newString, replacements: 1, rewrote: true };

	const hits = countOccurrences(content, oldString);
	if (hits > 1 && !replaceAll)
		return {
			error: `old_string matched ${hits} times. Quote more of the surrounding lines to make it unique, or set replace_all.`,
		};
	/*
	 * Replacements go through a function, never a string. `String.replace`
	 * reads `$&` and `$1` out of a literal replacement, and an artifact is
	 * exactly the kind of document — a snippet of regex, a jQuery example,
	 * a CSS `content` rule — that contains them verbatim.
	 */
	if (hits === 1 || (hits > 1 && replaceAll))
		return {
			content: replaceAll
				? content.split(oldString).join(newString)
				: content.replace(oldString, () => newString),
			replacements: replaceAll ? hits : 1,
		};

	const loose = loosePattern(oldString);
	const looseHits = content.match(loose)?.length || 0;
	if (looseHits === 0)
		return {
			error:
				"old_string was not found in the artifact. Copy the text exactly as it appears, or use rewrite_artifact to replace the whole document.",
		};
	if (looseHits > 1 && !replaceAll)
		return {
			error: `old_string matched ${looseHits} times. Quote more of the surrounding lines to make it unique, or set replace_all.`,
		};
	loose.lastIndex = 0;
	return {
		content: replaceAll
			? content.replace(loose, () => newString)
			: content.replace(new RegExp(loose.source), () => newString),
		replacements: replaceAll ? looseHits : 1,
		loose: true,
	};
}

/**
 * Roughly a quarter of an 8k window. The model has to be able to see what
 * it just changed, but a document echoed in full after every edit would
 * crowd out the conversation that asked for the edit.
 */
export const MODEL_VIEW_BUDGET = 6000;

export interface ModelView {
	content: string;
	bytes: number;
	lines: number;
	/** True when `content` is a window rather than the whole document. */
	windowed: boolean;
}

/**
 * What the document looks like now, bounded so it cannot swamp the window.
 *
 * Small documents come back whole — that is the common case and the most
 * useful answer. A large one comes back as a window around `focus`, with
 * the elided parts counted rather than hidden, so the model knows there is
 * more and roughly how much.
 */
export function modelView(content: string, focus = -1): ModelView {
	const bytes = content.length;
	const lines = content ? content.split("\n").length : 0;
	if (bytes <= MODEL_VIEW_BUDGET)
		return { content, bytes, lines, windowed: false };

	const centre = focus >= 0 ? focus : Math.floor(bytes / 2);
	const half = Math.floor(MODEL_VIEW_BUDGET / 2);
	let start = Math.max(0, centre - half);
	let end = Math.min(bytes, start + MODEL_VIEW_BUDGET);
	start = Math.max(0, end - MODEL_VIEW_BUDGET);
	/* Snap to line boundaries so the window never starts mid-tag. */
	if (start > 0) {
		const nextLine = content.indexOf("\n", start);
		if (nextLine !== -1 && nextLine < end) start = nextLine + 1;
	}
	if (end < bytes) {
		const previousLine = content.lastIndexOf("\n", end);
		if (previousLine > start) end = previousLine;
	}
	const head = start > 0 ? `…${start} characters above…\n` : "";
	const tail = end < bytes ? `\n…${bytes - end} characters below…` : "";
	return {
		content: head + content.slice(start, end) + tail,
		bytes,
		lines,
		windowed: true,
	};
}
