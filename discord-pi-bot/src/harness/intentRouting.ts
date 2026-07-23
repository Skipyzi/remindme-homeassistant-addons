const homeTerms =
	/\b(lights?|lamps?|switch(?:es)?|sensors?|temperatures?|thermostats?|climate|fans?|doors?|locks?|covers?|blinds?|media|speakers?|entities?|rooms?|home assistant|turn on|turn off|brightness|colour|color)\b/i;
const reminderTerms =
	/\b(remind|reminders?|appointments?|schedule|due|upcoming)\b/i;
const webTerms =
	/\b(search (?:the )?web|look (?:it )?up|latest|news|online|internet|weather forecast|source|sources)\b/i;

const artifactTerms =
	/(draw|chart|graph|diagram|plot|render|visuali[sz]e|artifact|page|dashboard|svg|html|mock ?up|write (?:me )?an? (?:app|page|script|program))/i;

export interface ToolContext {
	/** A document is open in the console, so edits have something to act on. */
	hasArtifact?: boolean;
}

export function allowedToolNames(
	prompt: string,
	context: ToolContext = {},
): Set<string> {
	const allowed = new Set<string>();
	if (homeTerms.test(prompt)) {
		allowed.add("get_entity_state");
		allowed.add("list_entities");
		allowed.add("control_entity");
	}
	if (reminderTerms.test(prompt)) {
		allowed.add("list_reminders");
		allowed.add("create_reminder");
	}
	if (webTerms.test(prompt)) allowed.add("web_search");
	if (artifactTerms.test(prompt)) allowed.add("create_artifact");
	/*
	 * Long-term memory is always in reach, not gated behind memory words: the
	 * point of it is that the model recalls and saves on its own judgement, so
	 * a stray "I'm allergic to peanuts" can be written without the user asking.
	 * The three tools are cheap, and proactive recall already rides in the
	 * system prompt.
	 */
	allowed.add("search_memory");
	allowed.add("read_memory");
	allowed.add("write_memory");
	/*
	 * Editing needs something to edit, and the wording rarely says so.
	 * "Make the heading bigger" names no artifact and matches no keyword,
	 * but with a document open on the bench it is plainly an edit — so the
	 * open document, not the phrasing, is what puts these tools in reach.
	 */
	if (context.hasArtifact) {
		allowed.add("read_artifact");
		allowed.add("edit_artifact");
		allowed.add("rewrite_artifact");
		allowed.add("create_artifact");
	}
	return allowed;
}

export function toolCallKey(name: string, argumentsText: string): string {
	return `${name}:${argumentsText.replace(/\s+/g, "")}`;
}
