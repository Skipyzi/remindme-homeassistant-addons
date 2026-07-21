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

/**
 * Replace `oldString` with `newString`.
 *
 * An ambiguous quote is an error, not a coin toss: "2025" appears in the
 * footer and the copyright and the meta tag, and picking one at random is
 * how a document quietly becomes wrong. The model is told how many it hit
 * so it can quote more of the surrounding lines.
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
	const hits = countOccurrences(content, oldString);
	if (hits === 0)
		return {
			error:
				"old_string was not found in the artifact. Quote it exactly, including whitespace and indentation.",
		};
	if (hits > 1 && !replaceAll)
		return {
			error: `old_string matched ${hits} times. Quote more of the surrounding lines to make it unique, or set replace_all.`,
		};
	return {
		content: replaceAll
			? content.split(oldString).join(newString)
			: content.replace(oldString, newString),
		replacements: replaceAll ? hits : 1,
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
