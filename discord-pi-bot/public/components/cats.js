/*
 * RemindMe's cats. Every conversation and job gets its own, picked from its
 * id: a coat (ginger tabby, tuxedo, calico, siamese, grey or black) and an
 * accessory. The face and pose say how it stands: focused while working, a
 * raised paw when it needs you, content when done, dizzy when it stopped.
 * Drawn as SVG from these shapes only; no text from a conversation goes in.
 */
(() => {
	const NS = "http://www.w3.org/2000/svg";
	const INK = "#1d1d1f";
	const NOSE = "#ff8fa3";
	const ASK = '<circle cx="36" cy="5" r="5" fill="#fff"/><path d="M36 2.2 L36 6" stroke="#000" stroke-width="1.7" stroke-linecap="round"/><circle cx="36" cy="8.3" r="0.95" fill="#000"/>';

	function hash(text) {
		let h = 2166136261;
		for (const char of String(text)) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
		return h >>> 0;
	}

	/* Eyes, nose, mouth and whiskers by state, centred on (cx, cy). */
	function face(cx, cy, state, ink, s) {
		const ex = 4.6 * s;
		let eyes;
		if (state === "done") eyes = `<path d="M${cx - ex - 2 * s} ${cy} Q${cx - ex} ${cy - 2.4 * s} ${cx - ex + 2 * s} ${cy} M${cx + ex - 2 * s} ${cy} Q${cx + ex} ${cy - 2.4 * s} ${cx + ex + 2 * s} ${cy}" stroke="${ink}" stroke-width="${1.5 * s}" fill="none" stroke-linecap="round"/>`;
		else if (state === "stopped") eyes = `<path d="M${cx - ex - 1.7 * s} ${cy - 1.7 * s} l${3.4 * s} ${3.4 * s} m0 ${-3.4 * s} l${-3.4 * s} ${3.4 * s} M${cx + ex - 1.7 * s} ${cy - 1.7 * s} l${3.4 * s} ${3.4 * s} m0 ${-3.4 * s} l${-3.4 * s} ${3.4 * s}" stroke="${ink}" stroke-width="${1.4 * s}" stroke-linecap="round"/>`;
		else if (state === "working") eyes = `<path d="M${cx - ex - 1.8 * s} ${cy} h${3.6 * s} M${cx + ex - 1.8 * s} ${cy} h${3.6 * s}" stroke="${ink}" stroke-width="${1.7 * s}" stroke-linecap="round"/>`;
		else eyes = `<circle cx="${cx - ex}" cy="${cy}" r="${2.3 * s}" fill="${ink}"/><circle cx="${cx + ex}" cy="${cy}" r="${2.3 * s}" fill="${ink}"/><circle cx="${cx - ex + 0.8 * s}" cy="${cy - 0.8 * s}" r="${0.7 * s}" fill="#fff"/><circle cx="${cx + ex + 0.8 * s}" cy="${cy - 0.8 * s}" r="${0.7 * s}" fill="#fff"/>`;
		const nose = `<path d="M${cx - 1.3 * s} ${cy + 3 * s} h${2.6 * s} l${-1.3 * s} ${1.5 * s} Z" fill="${NOSE}"/>`;
		const mouth =
			state === "stopped"
				? `<path d="M${cx - 2.2 * s} ${cy + 6.4 * s} h${4.4 * s}" stroke="${ink}" stroke-width="${1.2 * s}" stroke-linecap="round"/>`
				: `<path d="M${cx - 2.6 * s} ${cy + 5.2 * s} q${1.3 * s} ${1.6 * s} ${2.6 * s} 0 q${1.3 * s} ${1.6 * s} ${2.6 * s} 0" stroke="${ink}" stroke-width="${1.2 * s}" fill="none" stroke-linecap="round"/>`;
		const whiskers = `<path d="M${cx - 6 * s} ${cy + 3.6 * s} l${-6 * s} ${-1 * s} M${cx - 6 * s} ${cy + 5 * s} l${-6 * s} ${0.8 * s} M${cx + 6 * s} ${cy + 3.6 * s} l${6 * s} ${-1 * s} M${cx + 6 * s} ${cy + 5 * s} l${6 * s} ${0.8 * s}" stroke="${ink}" stroke-width="${0.8 * s}" stroke-linecap="round" opacity="0.55"/>`;
		return eyes + nose + mouth + whiskers;
	}

	/* Two ears on the head: rounded triangles tilted a little outward, bases in the head. */
	function ears(cx, top, colour, inner) {
		const one = (side) => {
			const x = (dx) => cx + side * dx;
			const outer = `M${x(13)} ${top + 9} L${x(11.6)} ${top - 2.6} Q${x(11.3)} ${top - 4.6} ${x(9.6)} ${top - 3.6} L${x(3.6)} ${top + 1.6} Z`;
			const pink = `M${x(11.4)} ${top + 4} L${x(10.7)} ${top - 1.4} Q${x(10.5)} ${top - 2.4} ${x(9.7)} ${top - 1.8} L${x(6.4)} ${top + 1.4} Z`;
			return `<path d="${outer}" fill="${colour}" stroke="${colour}" stroke-width="1.2" stroke-linejoin="round"/><path d="${pink}" fill="${inner}" opacity="0.75"/>`;
		};
		return one(-1) + one(1);
	}

	const ACCESSORIES = {
		bow: () => '<path d="M15.5 30 L20 27.5 L24.5 30 L24.5 25 L20 27.5 L15.5 25 Z" fill="#e5484d"/><circle cx="20" cy="27.5" r="1.2" fill="#b3262b"/>',
		beret: () => '<ellipse cx="18" cy="6" rx="9" ry="3.4" fill="#2b2b2b"/><circle cx="18" cy="2.6" r="1.3" fill="#2b2b2b"/>',
		glasses: () => `<circle cx="15.4" cy="17.5" r="3.9" fill="none" stroke="${INK}" stroke-width="1.3"/><circle cx="24.6" cy="17.5" r="3.9" fill="none" stroke="${INK}" stroke-width="1.3"/><path d="M19.3 17.5 h1.4" stroke="${INK}" stroke-width="1.3"/>`,
		headphones: () => '<path d="M7 20 Q7 5 20 5 Q33 5 33 20" stroke="#2b2b2b" stroke-width="2.2" fill="none"/><rect x="5" y="16" width="4.6" height="8" rx="2" fill="#2b2b2b"/><rect x="30.4" y="16" width="4.6" height="8" rx="2" fill="#2b2b2b"/>',
		hat: () => '<path d="M15 7 L20 -4 L25 7 Z" fill="#6cb8ff"/><circle cx="20" cy="-4" r="1.6" fill="#fff"/><path d="M17 3 l6 -1" stroke="#fff" stroke-width="1"/>',
		scarf: () => '<rect x="11" y="24.9" width="18" height="3.6" rx="1.8" fill="#5ed6a0"/><rect x="23" y="26.5" width="3.2" height="7" rx="1.4" fill="#5ed6a0"/>',
	};
	const ACCESSORY_KEYS = Object.keys(ACCESSORIES);

	/* The coats real cats have. A dark coat gets a thin outline so it stands out on black. */
	const COATS = [
		{ base: "#ff9e5e", marks: '<path d="M16 9.5 l1 4 M20 9 v4 M24 9.5 l-1 4" stroke="#d96b2b" stroke-width="1.6" stroke-linecap="round"/><path d="M8 27 h4 M8 31 h4" stroke="#d96b2b" stroke-width="1.6" stroke-linecap="round"/>' },
		{ base: "#2f3033", marks: '<ellipse cx="20" cy="22.5" rx="5.5" ry="4" fill="#fff"/><path d="M15 27 Q20 38 25 27 Z" fill="#fff"/>', ink: "#f2f2f2", outline: true },
		{ base: "#f6efe6", marks: '<path d="M8 12 Q12 7 17 10.5 Q14 15.5 9 15.5 Z" fill="#ff9e5e"/><path d="M24 9.5 Q31 8.5 32 15.5 Q27 16.5 24 13.5 Z" fill="#3b3b3d"/><path d="M27 28 Q31 26 32 32 Q29 35 26 33 Z" fill="#ff9e5e"/>' },
		{ base: "#f3e3c8", marks: '<ellipse cx="20" cy="21.5" rx="7" ry="5.6" fill="#7a5a44" opacity="0.85"/>', ears: "#5a4030" },
		{ base: "#a5adbd", marks: '<path d="M17 9 v3 M23 9 v3" stroke="#7f8899" stroke-width="1.5" stroke-linecap="round"/>' },
		{ base: "#2b2b2e", marks: "", ink: "#d8f5a2", outline: true },
	];

	/** One cat as SVG markup, the same every time for the same id and state. */
	function draw(seed, state = "done") {
		const h = hash(seed);
		const coat = state === "stopped" ? { base: "#8a8a8f", marks: "" } : COATS[h % COATS.length];
		const c = coat.base;
		const ink = coat.ink || INK;
		const outline = coat.outline ? ' stroke="#6b6b70" stroke-width="0.9"' : "";
		const tail = `<path class="rm-cat-tail" d="M28 37 Q39 37 37 26 Q36.4 22.5 34 23.5" stroke="${c}" stroke-width="3.6" fill="none" stroke-linecap="round"/>`;
		const body = `<path d="M9 38 Q7 28 13 25 L27 25 Q33 28 31 38 Z" fill="${c}"${outline}/>`;
		const paws = `<ellipse cx="15.5" cy="38" rx="3.2" ry="1.9" fill="${c}"${outline}/><ellipse cx="24.5" cy="38" rx="3.2" ry="1.9" fill="${c}"${outline}/>`;
		const head = ears(20, 7.5, coat.ears || c, coat.outline ? "#8a8a90" : NOSE) + `<ellipse cx="20" cy="17.5" rx="13" ry="11" fill="${c}"${outline}/>`;
		const accessory = ACCESSORIES[ACCESSORY_KEYS[(h >>> 5) % ACCESSORY_KEYS.length]]();
		const raisedPaw = state === "asking" ? `<ellipse cx="32.5" cy="25" rx="2.6" ry="3.4" fill="${c}"${outline}/>` + ASK : "";
		return `<svg xmlns="${NS}" viewBox="0 -6 41 46" aria-hidden="true" focusable="false">${tail}${body}${paws}${head}${coat.marks}${face(20, 17.5, state, ink, 0.95)}${accessory}${raisedPaw}</svg>`;
	}

	/** Draw a cat into an element, replacing what was there. */
	function render(element, seed, state) {
		if (!element) return;
		const key = `${seed}:${state}`;
		if (element.dataset.cat === key) return;
		const svg = new DOMParser().parseFromString(draw(seed, state), "image/svg+xml").documentElement;
		element.replaceChildren(document.importNode(svg, true));
		element.dataset.cat = key;
		element.dataset.state = state;
	}

	window.RemindMeCats = { draw, render };
})();
