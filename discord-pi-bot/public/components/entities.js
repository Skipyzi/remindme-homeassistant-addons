(function exposeEntities(globalScope) {
	async function performEntityAction(entity, action, value) {
		const previous = { ...entity };
		if (action === "turn_on") entity.state = "on";
		if (action === "turn_off") entity.state = "off";
		if (action === "brightness") entity.brightness = Number(value);
		entity.pending = true;
		entity.error = "";
		try {
			const response = await fetch("./api/entities/action", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ entityId: entity.entityId, action, value }),
			});
			const result = await response.json();
			if (!response.ok)
				throw new Error(result.error || "Home Assistant rejected the action");
			if (result.confirmation_required)
				return { confirmation: result, previous };
			Object.assign(entity, result, { pending: false, applied: true });
			setTimeout(() => {
				entity.applied = false;
			}, 900);
			return { entity };
		} catch (error) {
			Object.assign(entity, previous, {
				pending: false,
				error: error.message || String(error),
			});
			return { error, previous };
		}
	}
	globalScope.RemindMeEntities = { performEntityAction };
})(window);
