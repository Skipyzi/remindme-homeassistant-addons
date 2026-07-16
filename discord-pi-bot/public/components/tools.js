(function exposeTools(globalScope) {
	const labels = {
		get_entity_state: "Reading the house ledger…",
		list_entities: "Reading the house ledger…",
		control_entity: "Setting the house machinery…",
		web_search: "Tuning the long-range receiver…",
		list_reminders: "Consulting the appointment book…",
	};
	function toolActivity(name) {
		return labels[name] || "Operating the house relay…";
	}
	globalScope.RemindMeTools = { toolActivity };
})(window);
