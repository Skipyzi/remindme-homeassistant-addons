(function exposeEntityControls(globalScope) {
	/**
	 * Approximate blackbody colour for a temperature, so the warm slider's
	 * track shows what it is actually selecting rather than a flat bar.
	 * Tanner Helland's piecewise fit — close enough over 1000-12000K, and it
	 * costs nothing next to a real spectrum table.
	 */
	function kelvinHex(kelvin) {
		const temperature = Math.min(12000, Math.max(1000, Number(kelvin) || 2700)) / 100;
		let red;
		let green;
		let blue;
		if (temperature <= 66) {
			red = 255;
			green = 99.47 * Math.log(temperature) - 161.12;
		} else {
			red = 329.7 * (temperature - 60) ** -0.1332;
			green = 288.12 * (temperature - 60) ** -0.0755;
		}
		if (temperature >= 66) blue = 255;
		else if (temperature <= 19) blue = 0;
		else blue = 138.52 * Math.log(temperature - 10) - 305.04;
		const channel = (value) =>
			Math.round(Math.min(255, Math.max(0, value)))
				.toString(16)
				.padStart(2, "0");
		return `#${channel(red)}${channel(green)}${channel(blue)}`;
	}

	function hsvToRgb(hue, saturation, value) {
		const h = (((Number(hue) || 0) % 360) + 360) % 360;
		const s = Math.min(1, Math.max(0, (Number(saturation) || 0) / 100));
		const v = Math.min(1, Math.max(0, (Number(value) || 0) / 100));
		const chroma = v * s;
		const secondary = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
		const match = v - chroma;
		const sextant = Math.floor(h / 60) % 6;
		const table = [
			[chroma, secondary, 0],
			[secondary, chroma, 0],
			[0, chroma, secondary],
			[0, secondary, chroma],
			[secondary, 0, chroma],
			[chroma, 0, secondary],
		][sextant];
		return table.map((component) => Math.round((component + match) * 255));
	}

	function rgbToHsv(rgb) {
		if (!Array.isArray(rgb) || rgb.length !== 3) return null;
		const [red, green, blue] = rgb.map((component) =>
			Math.min(255, Math.max(0, Number(component) || 0)) / 255,
		);
		const high = Math.max(red, green, blue);
		const low = Math.min(red, green, blue);
		const chroma = high - low;
		let hue = 0;
		if (chroma) {
			if (high === red) hue = ((green - blue) / chroma) % 6;
			else if (high === green) hue = (blue - red) / chroma + 2;
			else hue = (red - green) / chroma + 4;
			hue *= 60;
			if (hue < 0) hue += 360;
		}
		return {
			hue: Math.round(hue),
			saturation: Math.round(high ? (chroma / high) * 100 : 0),
			value: Math.round(high * 100),
		};
	}

	function rgbHex(rgb) {
		return `#${rgb
			.map((component) =>
				Math.round(Math.min(255, Math.max(0, component)))
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")}`;
	}

	/* Bulbs report their own range; these are the fallbacks when they do not. */
	const MIN_KELVIN = 2000;
	const MAX_KELVIN = 6500;

	function kelvinRange(entity) {
		return {
			min: Number(entity?.minKelvin) || MIN_KELVIN,
			max: Number(entity?.maxKelvin) || MAX_KELVIN,
		};
	}

	/**
	 * Every adjustable thing on a card, described once: where the live value
	 * comes from, and what service call a new value turns into. The markup
	 * then only names a channel, and the drag handling is shared.
	 */
	const CHANNELS = {
		brightness: {
			label: "BRIGHTNESS",
			min: 0,
			max: 100,
			step: 1,
			format: (value) => `${Math.round(value)}%`,
			read: (entity) =>
				typeof entity.brightness === "number"
					? Math.round((entity.brightness / 255) * 100)
					: 0,
			commit: (value) => ["brightness", Math.round((value / 100) * 255)],
			apply: (entity, value) => {
				entity.brightness = Math.round((value / 100) * 255);
			},
		},
		kelvin: {
			label: "WARMTH",
			min: (entity) => kelvinRange(entity).min,
			max: (entity) => kelvinRange(entity).max,
			step: 50,
			format: (value) => `${Math.round(value)}K`,
			read: (entity) =>
				Number(entity.colorTemperature) || kelvinRange(entity).min,
			commit: (value) => ["color_temperature", Math.round(value)],
			apply: (entity, value) => {
				entity.colorTemperature = Math.round(value);
				/* Warm white is not a colour; drop the stale rgb reading so
				 * the card does not read as still being in colour mode. */
				entity.rgbColor = undefined;
			},
		},
		hue: {
			label: "HUE",
			min: 0,
			max: 360,
			step: 1,
			format: (value) => `${Math.round(value)}°`,
			read: (entity) => rgbToHsv(entity.rgbColor)?.hue ?? 0,
			/* Hue and saturation are one service call: send both, always. */
			commit: (value, entity, draft) => [
				"rgb_color",
				hsvToRgb(value, draft.saturation, 100),
			],
			apply: (entity, value, draft) => {
				entity.rgbColor = hsvToRgb(value, draft.saturation, 100);
			},
		},
		saturation: {
			label: "SATURATION",
			min: 0,
			max: 100,
			step: 1,
			format: (value) => `${Math.round(value)}%`,
			read: (entity) => rgbToHsv(entity.rgbColor)?.saturation ?? 100,
			commit: (value, entity, draft) => [
				"rgb_color",
				hsvToRgb(draft.hue, value, 100),
			],
			apply: (entity, value, draft) => {
				entity.rgbColor = hsvToRgb(draft.hue, value, 100);
			},
		},
		position: {
			label: "POSITION",
			min: 0,
			max: 100,
			step: 1,
			format: (value) => `${Math.round(value)}% OPEN`,
			read: (entity) => Number(entity.position) || 0,
			commit: (value) => ["set_position", Math.round(value)],
			apply: (entity, value) => {
				entity.position = Math.round(value);
			},
		},
		speed: {
			label: "SPEED",
			min: 0,
			max: 100,
			step: (entity) => Number(entity.fanStep) || 1,
			/* "2 of 3" beats "66%" when the hardware has three settings. */
			format: (value, entity) => {
				const step = Number(entity?.fanStep) || 0;
				const percent = Math.round(value);
				if (step > 0 && step < 100)
					return `${percent}% · ${Math.round(percent / step)} OF ${Math.round(100 / step)}`;
				return `${percent}%`;
			},
			read: (entity) => Number(entity.fanPercentage) || 0,
			commit: (value) => ["set_fan_speed", Math.round(value)],
			apply: (entity, value) => {
				entity.fanPercentage = Math.round(value);
			},
		},
	};

	function bound(channel, key, entity) {
		const value = CHANNELS[channel]?.[key];
		return typeof value === "function" ? value(entity) : value;
	}

	/** Where along the track a pointer landed, in the channel's own units. */
	function valueFromPointer(track, clientX, channel, entity) {
		const box = track.getBoundingClientRect();
		if (!box.width) return bound(channel, "min", entity);
		const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
		const min = bound(channel, "min", entity);
		const max = bound(channel, "max", entity);
		const step = bound(channel, "step", entity) || 1;
		return Math.round((min + ratio * (max - min)) / step) * step;
	}

	function percentOf(value, channel, entity) {
		const min = bound(channel, "min", entity);
		const max = bound(channel, "max", entity);
		if (max === min) return 0;
		return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
	}

	/**
	 * A light is in colour mode when it is actually showing a colour. An
	 * unsaturated rgb reading is what a warm-white bulb reports, so it is not
	 * evidence of colour mode on its own.
	 */
	function isColorMode(entity) {
		const hsv = rgbToHsv(entity.rgbColor);
		return Boolean(hsv && hsv.saturation > 8);
	}

	/** Track background for the channel: the slider shows what it selects. */
	function trackGradient(channel, entity, draft) {
		if (channel === "kelvin") {
			const { min, max } = kelvinRange(entity);
			const stops = [min, (min + max) / 2, max]
				.map((kelvin) => kelvinHex(kelvin))
				.join(", ");
			return `linear-gradient(90deg, ${stops})`;
		}
		if (channel === "hue")
			return "linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";
		if (channel === "saturation") {
			const full = rgbHex(hsvToRgb(draft?.hue ?? 0, 100, 100));
			return `linear-gradient(90deg, #f4f4f4, ${full})`;
		}
		return "";
	}

	const api = {
		CHANNELS,
		bound,
		kelvinHex,
		hsvToRgb,
		rgbToHsv,
		rgbHex,
		kelvinRange,
		valueFromPointer,
		percentOf,
		isColorMode,
		trackGradient,
	};
	globalScope.RemindMeEntityControls = api;
	if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
