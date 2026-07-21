(function exposeEntityCards(globalScope) {
	const ICONS = {
		light:
			'<circle cx="12" cy="10" r="6"/><line x1="9.5" y1="16" x2="14.5" y2="16"/><line x1="10.5" y1="19" x2="13.5" y2="19"/>',
		lock: '<rect x="5" y="11" width="14" height="9"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
		climate: '<path d="M10 14V5a2 2 0 0 1 4 0v9"/><circle cx="12" cy="17" r="3.4"/>',
		temperature:
			'<path d="M10 14V5a2 2 0 0 1 4 0v9"/><circle cx="12" cy="17" r="3.4"/>',
		cover:
			'<rect x="4" y="4" width="16" height="16"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="14" x2="20" y2="14"/>',
		switch: '<rect x="4" y="7" width="16" height="10" rx="1"/><line x1="8" y1="7" x2="8" y2="17"/>',
		fan: '<circle cx="12" cy="12" r="3"/><path d="M12 5v-2M12 21v-2M5 12h-2M21 12h-2"/><circle cx="12" cy="12" r="8"/>',
		humidity: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
		moisture: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
		power: '<polyline points="13 3 5 14 11 14 10 21 19 10 13 10 13 3"/>',
		energy: '<polyline points="13 3 5 14 11 14 10 21 19 10 13 10 13 3"/>',
		battery:
			'<rect x="3" y="8" width="16" height="9" rx="1"/><line x1="21" y1="11" x2="21" y2="14"/>',
		motion:
			'<circle cx="12" cy="12" r="3"/><path d="M5 12a7 7 0 0 1 14 0"/><path d="M2 12a10 10 0 0 1 20 0"/>',
		door: '<rect x="6" y="3" width="12" height="18"/><circle cx="15" cy="12" r="1" fill="currentColor"/>',
		sensor: '<circle cx="12" cy="12" r="7"/><line x1="12" y1="8" x2="12" y2="13"/>',
	};

	function iconPaths(entity) {
		return (
			ICONS[entity.deviceClass] || ICONS[entity.domain] || ICONS.sensor
		);
	}

	/** amber = live/actionable, cool = cold or moisture, dim = at rest. */
	function iconTone(entity) {
		const kind = entity.deviceClass;
		if (kind === "humidity" || kind === "moisture") return "cool";
		if (kind === "temperature" || entity.domain === "climate") return "hot";
		if (isActive(entity)) return "live";
		return "";
	}

	function isActive(entity) {
		return ["on", "open", "heat", "cool", "detected", "unlocked"].includes(
			String(entity.state).toLowerCase(),
		);
	}

	function statePill(entity) {
		const state = String(entity.state || "").toLowerCase();
		if (entity.domain === "lock")
			return state === "locked"
				? { text: "LOCKED", tone: "good" }
				: { text: "UNLOCKED", tone: "bad" };
		if (entity.deviceClass === "battery" && Number(entity.numericState) <= 20)
			return { text: "LOW", tone: "bad" };
		if (entity.domain === "binary_sensor") {
			const kind = entity.deviceClass;
			if (kind === "motion")
				return state === "on"
					? { text: "DETECTED", tone: "on" }
					: { text: "CLEAR", tone: "good" };
			return state === "on"
				? { text: "OPEN", tone: "bad" }
				: { text: "CLOSED", tone: "good" };
		}
		if (!state || state === "unavailable" || state === "unknown")
			return { text: "OFFLINE", tone: "" };
		return { text: state.toUpperCase(), tone: isActive(entity) ? "on" : "" };
	}

	/**
	 * Read-only cards lead with the value as the hero, so repeating it in a
	 * pill is noise. Show one only when it carries something the hero does
	 * not — an alert state such as a low battery.
	 */
	function showPill(entity) {
		if (entity.message) return true;
		if (entity.tier !== "readout") return true;
		return statePill(entity).tone === "bad";
	}

	/** Bars are semantic: low battery is rust, moisture is cool, rest is amber. */
	function fillTone(entity) {
		const kind = entity.deviceClass;
		if (kind === "battery")
			return Number(entity.numericState) <= 20 ? "bad" : "good";
		if (kind === "humidity" || kind === "moisture") return "cool";
		return "";
	}

	function barPercent(entity) {
		if (entity.domain === "cover" && typeof entity.position === "number")
			return entity.position;
		if (entity.domain === "light" && typeof entity.brightness === "number")
			return Math.round((entity.brightness / 255) * 100);
		if (typeof entity.numericState === "number" && entity.unit === "%")
			return entity.numericState;
		return null;
	}

	function formatRelative(iso) {
		if (!iso) return "";
		const elapsed = Date.now() - new Date(iso).getTime();
		if (!Number.isFinite(elapsed) || elapsed < 0) return "";
		const minutes = Math.floor(elapsed / 60000);
		if (minutes < 1) return `${Math.floor(elapsed / 1000)} SECONDS AGO`;
		if (minutes < 60) return `${minutes}M AGO`;
		const hours = Math.floor(minutes / 60);
		return `${hours}H ${minutes % 60}M AGO`;
	}

	/** Binary sensors report dwell — how long they have held the current state. */
	function formatDwell(entity) {
		const since = formatRelative(entity.lastChanged).replace(" AGO", "");
		if (!since) return "NO STATE HISTORY";
		const label = statePill(entity).text;
		return `${label} FOR ${since}`;
	}

	/**
	 * Name a fan speed the way a person would: the device's preset if it has
	 * one, otherwise the step out of however many steps it actually supports.
	 * "2 of 3" beats "66%" when the hardware only has three settings.
	 */
	function fanSpeedLabel(entity) {
		const percentage = Number(entity.fanPercentage || 0);
		const step = Number(entity.fanStep || 0);
		const preset = entity.presetMode
			? String(entity.presetMode).toUpperCase()
			: "";
		if (step > 0 && step < 100) {
			const steps = Math.round(100 / step);
			const current = Math.round(percentage / step);
			return `${preset || `${percentage}%`} · ${current} OF ${steps}`;
		}
		return preset ? `${preset} · ${percentage}%` : `${percentage}%`;
	}

	/** Next speed up, clamped to the device's own step and ceiling. */
	function nextFanSpeed(entity) {
		const step = Number(entity.fanStep) > 0 ? Number(entity.fanStep) : 25;
		return Math.min(100, Math.round(Number(entity.fanPercentage || 0) + step));
	}

	/**
	 * Trailing value on a compact row — the number that makes the state
	 * meaningful (a light's brightness, a sensor's unit).
	 */
	function compactDetail(entity) {
		if (entity.domain === "light" && isActive(entity)) {
			const percent = barPercent(entity);
			if (percent !== null) return `${percent}%`;
		}
		if (entity.domain === "fan" && entity.fanPercentage != null)
			return `${entity.fanPercentage}%`;
		if (entity.domain === "cover" && entity.position != null)
			return `${entity.position}% OPEN`;
		return entity.unit || "—";
	}

	function metaLine(entity) {
		const when = formatRelative(entity.lastChanged);
		if (entity.domain === "climate" && entity.currentTemperature != null) {
			const doing = entity.hvacAction
				? ` · ${String(entity.hvacAction).toUpperCase()}`
				: "";
			return `CURRENTLY ${entity.currentTemperature}° · TARGET ${
				entity.targetTemperature ?? "—"
			}°${doing} · ${when}`;
		}
		if (entity.domain === "fan" && entity.oscillating)
			return `OSCILLATING · ${when}`;
		if (entity.domain === "switch" && entity.power != null)
			return `DRAWING ${entity.power} W · ${when}`;
		return when ? `LAST CHANGED — ${when}` : "NO STATE HISTORY";
	}

	/**
	 * Map a history series into a polyline for a 200x34 viewBox. Flat series
	 * are drawn mid-height rather than divided by a zero range.
	 */
	function sparklinePoints(points) {
		if (!points || points.length < 2) return "";
		const values = points.map((point) => point.value);
		const low = Math.min(...values);
		const high = Math.max(...values);
		const range = high - low;
		return values
			.map((value, index) => {
				const x = (index / (values.length - 1)) * 200;
				const y = range ? 32 - ((value - low) / range) * 30 : 17;
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(" ");
	}

	function summarizeTrend(points, unit) {
		if (!points || points.length < 2) return "";
		const values = points.map((point) => point.value);
		const delta = values[values.length - 1] - values[0];
		const sign = delta >= 0 ? "+" : "";
		const suffix = unit ? `${unit}` : "";
		return `${sign}${delta.toFixed(1)}${suffix} OVER WINDOW · MIN ${Math.min(
			...values,
		).toFixed(1)} · MAX ${Math.max(...values).toFixed(1)}`;
	}

	async function loadHistory(entity, hours = 6) {
		try {
			const response = await fetch(
				`./api/entities/${encodeURIComponent(entity.entityId)}/history?hours=${hours}`,
			);
			if (!response.ok) return null;
			return await response.json();
		} catch {
			return null;
		}
	}

	const api = {
		iconPaths,
		iconTone,
		isActive,
		statePill,
		showPill,
		fanSpeedLabel,
		nextFanSpeed,
		compactDetail,
		fillTone,
		barPercent,
		formatRelative,
		formatDwell,
		metaLine,
		sparklinePoints,
		summarizeTrend,
		loadHistory,
	};
	globalScope.RemindMeEntityCards = api;
	if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
