(function exposeTools(globalScope) {
	/*
	 * What a tool row says while it runs and once it is done. Written the way
	 * the console would say it, not the action's wire name.
	 */
	const running = {
		home_assistant: "Asking Home Assistant…",
		home_control: "Working the switches…",
		home_status: "Checking the house…",
		reminder_add: "Reading the calendar…",
		reminder_list: "Opening the appointment book…",
		web_search: "Tuning the long-range receiver…",
		memory_recall: "Leafing through your notes…",
		memory_save: "Writing it down…",
		parcel_track: "Calling the courier…",
		parcel_list: "Checking on your parcels…",
		document_write: "Drafting…",
		document_edit: "Revising…",
		mcp: "Calling an outside tool…",
	};
	const done = {
		home_assistant: "Home Assistant handled it",
		home_control: "Changed the house",
		home_status: "Checked the house",
		reminder_add: "Drafted a reminder",
		reminder_list: "Read your reminders",
		web_search: "Searched the web",
		memory_recall: "Looked through your notes",
		memory_save: "Saved to memory",
		parcel_track: "Tracking the parcel",
		parcel_list: "Checked your parcels",
		document_write: "Wrote a document",
		document_edit: "Revised the document",
		mcp: "Used an outside tool",
	};
	/* "home_control · Front Door" — one confirmation row per device. */
	function split(name) {
		const [action, target] = String(name || "").split(" · ");
		return { action, target };
	}
	function toolActivity(name) {
		const { action, target } = split(name);
		const label = running[action] || "Working…";
		return target ? `${label} ${target}` : label;
	}
	function toolDone(name) {
		const { action, target } = split(name);
		if (target) return `Waiting on you · ${target}`;
		return done[action] || String(action || "Tool").replaceAll("_", " ");
	}
	globalScope.RemindMeTools = { toolActivity, toolDone };
})(window);
