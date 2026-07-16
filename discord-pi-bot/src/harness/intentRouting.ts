const homeTerms =
	/\b(lights?|lamps?|switch(?:es)?|sensors?|temperatures?|thermostats?|climate|fans?|doors?|locks?|covers?|blinds?|media|speakers?|entities?|rooms?|home assistant|turn on|turn off|brightness|colour|color)\b/i;
const reminderTerms =
	/\b(remind|reminders?|appointments?|schedule|due|upcoming)\b/i;
const webTerms =
	/\b(search (?:the )?web|look (?:it )?up|latest|news|online|internet|weather forecast|source|sources)\b/i;

export function allowedToolNames(prompt: string): Set<string> {
	const allowed = new Set<string>();
	if (homeTerms.test(prompt)) {
		allowed.add("get_entity_state");
		allowed.add("list_entities");
		allowed.add("control_entity");
	}
	if (reminderTerms.test(prompt)) allowed.add("list_reminders");
	if (webTerms.test(prompt)) allowed.add("web_search");
	return allowed;
}

export function toolCallKey(name: string, argumentsText: string): string {
	return `${name}:${argumentsText.replace(/\s+/g, "")}`;
}
