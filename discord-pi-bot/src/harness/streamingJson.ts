/**
 * Reading a string field out of JSON that has not finished arriving.
 *
 * Tool-call arguments stream in as text, so `create_artifact`'s document
 * exists as a growing fragment of `{"title":"…","kind":"html","content":"<h1>`
 * long before it is parseable. JSON.parse cannot help until the final brace
 * lands, which on a Pi at ~5 tok/s is minutes after the first tag — so the
 * pane would have nothing to show for the whole write.
 *
 * This walks the fragment and decodes as much of one field as is there.
 */

const ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

export interface PartialField {
	/** What has been decoded so far. */
	value: string;
	/** True once the closing quote arrived, so the field will not grow. */
	complete: boolean;
}

/**
 * The value of `field` in a possibly-truncated JSON object, or undefined
 * when the field's opening quote has not arrived yet.
 *
 * A trailing partial escape (`\` or a clipped `\u00`) decodes to nothing
 * rather than to a stray backslash: the next chunk completes it, and half
 * an escape must never reach the page as literal text.
 */
export function partialStringField(
	json: string,
	field: string,
): PartialField | undefined {
	const key = `"${field}"`;
	let cursor = json.indexOf(key);
	if (cursor === -1) return undefined;
	cursor += key.length;
	while (cursor < json.length && /\s/.test(json[cursor])) cursor += 1;
	if (json[cursor] !== ":") return undefined;
	cursor += 1;
	while (cursor < json.length && /\s/.test(json[cursor])) cursor += 1;
	if (json[cursor] !== '"') return undefined;
	cursor += 1;

	let value = "";
	while (cursor < json.length) {
		const character = json[cursor];
		if (character === '"') return { value, complete: true };
		if (character !== "\\") {
			value += character;
			cursor += 1;
			continue;
		}
		const code = json[cursor + 1];
		if (code === undefined) break; // the backslash is the last byte so far
		if (code === "u") {
			const digits = json.slice(cursor + 2, cursor + 6);
			if (digits.length < 4) break; // clipped mid-escape
			value += String.fromCharCode(Number.parseInt(digits, 16));
			cursor += 6;
			continue;
		}
		value += ESCAPES[code] ?? code;
		cursor += 2;
	}
	return { value, complete: false };
}
