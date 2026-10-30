import type { Embed } from "./embeds";

/**
 * Places from OpenStreetMap (Nominatim): a shop, a pharmacy, a restaurant,
 * with its address, opening hours read for right now, phone and website.
 * Nominatim asks for at most one request a second and a real user agent.
 */

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type Ranges = Array<[number, number]>;

/** "Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off" → minutes open per weekday (Monday first), or nothing when it's beyond this reader. */
export function weekHours(spec: string): Ranges[] | undefined {
	const text = spec.trim();
	if (!text) return undefined;
	if (/^24\/7$/.test(text)) return DAYS.map(() => [[0, 24 * 60]]);
	const week: Ranges[] = DAYS.map(() => []);
	for (const raw of text.split(";")) {
		const rule = raw.trim();
		if (!rule) continue;
		// Public and school holidays can't be known here; their rules are left out.
		if (/^(PH|SH)\b/.test(rule)) continue;
		const match = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(?:,\s*PH)?\s*(.*)$/.exec(rule);
		if (!match) return undefined;
		const days = new Set<number>();
		if (match[1]) {
			for (const part of match[1].split(",")) {
				const [from, to] = part.split("-").map((day) => DAYS.indexOf(day));
				if (to === undefined) days.add(from);
				else for (let day = from; ; day = (day + 1) % 7) {
					days.add(day);
					if (day === to) break;
				}
			}
		} else DAYS.forEach((_day, index) => days.add(index));
		const times = match[2].trim();
		const ranges: Ranges = [];
		if (!/^(off|closed)$/i.test(times)) {
			if (!times) return undefined;
			for (const span of times.split(",")) {
				const found = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(span.trim());
				if (!found) return undefined;
				const start = Number(found[1]) * 60 + Number(found[2]);
				let end = Number(found[3]) * 60 + Number(found[4]);
				if (end <= start) end += 24 * 60;
				ranges.push([start, end]);
			}
		}
		// A later rule replaces what an earlier one said about the same days.
		for (const day of days) week[day] = ranges;
	}
	return week;
}

const clock = (minutes: number) => {
	const value = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
	return value === 0 && minutes > 0 ? "midnight" : `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};

/** Whether it's open at `now`, in a few words: "Open now, until 20:00", "Closed, opens tomorrow at 09:00". */
export function openingStatus(spec: string, now = new Date()): { text: string; open: boolean } | undefined {
	const week = weekHours(spec);
	if (!week) return undefined;
	const today = (now.getDay() + 6) % 7;
	const minute = now.getHours() * 60 + now.getMinutes();
	// Yesterday's evening can run past midnight.
	for (const [start, end] of week[(today + 6) % 7]) if (end > 24 * 60 && minute < end - 24 * 60) return { text: `Open now, until ${clock(end)}`, open: true };
	for (const [start, end] of week[today]) if (minute >= start && minute < end) return { text: `Open now, until ${clock(end)}`, open: true };
	const later = week[today].filter(([start]) => start > minute).sort((a, b) => a[0] - b[0])[0];
	if (later) return { text: `Closed, opens at ${clock(later[0])}`, open: false };
	for (let ahead = 1; ahead <= 7; ahead++) {
		const day = (today + ahead) % 7;
		const first = [...week[day]].sort((a, b) => a[0] - b[0])[0];
		if (first) return { text: `Closed, opens ${ahead === 1 ? "tomorrow" : DAY_NAMES[day]} at ${clock(first[0])}`, open: false };
	}
	return { text: "Closed", open: false };
}

/** Metres between two points. */
export function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const rad = (value: number) => (value * Math.PI) / 180;
	const dLat = rad(b.lat - a.lat);
	const dLon = rad(b.lon - a.lon);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
	return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export interface Place {
	name: string;
	kind?: string;
	lat: number;
	lon: number;
	address?: string;
	hours?: string;
	status?: { text: string; open: boolean };
	phone?: string;
	website?: string;
	/** Metres from home (or from the user, when searched around them), when that's known. */
	away?: number;
	/** What `away` is measured from. */
	from?: "home" | "you";
	/** A doctor's or dentist's speciality, as OpenStreetMap has it ("orthodontics"). */
	speciality?: string;
}

/*
 * Kinds of place a nearby search knows: the words Nominatim maps to
 * OpenStreetMap's tags, and the tags a result must have.
 */
interface Kind {
	phrase: string;
	tags: Array<[string, string]>;
	speciality?: string;
}
export const KINDS: Record<string, Kind> = {
	doctor: { phrase: "doctors", tags: [["amenity", "doctors"], ["healthcare", "doctor"]] },
	dentist: { phrase: "dentist", tags: [["amenity", "dentist"], ["healthcare", "dentist"]] },
	orthodontist: { phrase: "dentist", tags: [["amenity", "dentist"], ["healthcare", "dentist"]], speciality: "orthodontics" },
	pharmacy: { phrase: "pharmacy", tags: [["amenity", "pharmacy"], ["healthcare", "pharmacy"]] },
	hospital: { phrase: "hospital", tags: [["amenity", "hospital"], ["healthcare", "hospital"]] },
	vet: { phrase: "veterinary", tags: [["amenity", "veterinary"]] },
	physiotherapist: { phrase: "physiotherapist", tags: [["healthcare", "physiotherapist"]] },
	supermarket: { phrase: "supermarket", tags: [["shop", "supermarket"]] },
	bakery: { phrase: "bakery", tags: [["shop", "bakery"]] },
	drugstore: { phrase: "chemist", tags: [["shop", "chemist"]] },
	cafe: { phrase: "cafe", tags: [["amenity", "cafe"]] },
	restaurant: { phrase: "restaurant", tags: [["amenity", "restaurant"]] },
	atm: { phrase: "atm", tags: [["amenity", "atm"]] },
	bank: { phrase: "bank", tags: [["amenity", "bank"]] },
	fuel: { phrase: "fuel", tags: [["amenity", "fuel"]] },
	charging_station: { phrase: "charging station", tags: [["amenity", "charging_station"]] },
	post_office: { phrase: "post office", tags: [["amenity", "post_office"]] },
	hairdresser: { phrase: "hairdresser", tags: [["shop", "hairdresser"]] },
};

/*
 * Specialities, as the model may ask for them (`ask`), as OpenStreetMap and
 * German practice names write them (`match`), and the name words to search
 * for, since many practices only say it in their name ("Kieferorthopädie …").
 */
const SPECIALITIES: Record<string, { ask: RegExp; match: RegExp; words: string[] }> = {
	orthodontics: { ask: /orthodont|kieferorthop|braces/i, match: /orthodont|kieferorthop/i, words: ["Kieferorthopädie", "Kieferorthopäde"] },
	paediatrics: { ask: /paediatr|pediatr|child|kid|kinder/i, match: /paediatr|pediatr|kinderarzt|kinderärzt|kinder- und jugend/i, words: ["Kinderarzt", "Kinderärztin"] },
	general: { ask: /general|family|\bgp\b|hausarzt|allgemein/i, match: /general|allgemeinmed|hausarzt|hausärzt/i, words: ["Hausarzt", "Allgemeinmedizin"] },
	dermatology: { ask: /dermat|skin|haut/i, match: /dermatolog|hautarzt|hautärzt/i, words: ["Hautarzt", "Dermatologie"] },
	gynaecology: { ask: /gyn|women|frauen/i, match: /gyn|frauenarzt|frauenärzt/i, words: ["Frauenarzt", "Gynäkologie"] },
	ophthalmology: { ask: /ophthalm|\beye|augen/i, match: /ophthalm|augenarzt|augenärzt|augenheilk/i, words: ["Augenarzt", "Augenheilkunde"] },
	orthopaedics: { ask: /^(?!.*(dont|kiefer)).*orthop/i, match: /(?<!kiefer)orthop(ae|ä|e)d/i, words: ["Orthopäde", "Orthopädie"] },
	otolaryngology: { ask: /otolaryng|\bent\b|\bear|throat|\bhno\b/i, match: /otolaryng|\bhno\b|hals-nasen/i, words: ["HNO"] },
	internal: { ask: /internal|internist|innere/i, match: /internal|innere med|internist/i, words: ["Internist", "Innere Medizin"] },
	psychiatry: { ask: /psychiat/i, match: /psychiat/i, words: ["Psychiatrie"] },
	psychotherapy: { ask: /psychotherap|therapist/i, match: /psychotherap/i, words: ["Psychotherapie"] },
	neurology: { ask: /neurolog/i, match: /neurolog/i, words: ["Neurologie"] },
	cardiology: { ask: /cardio|kardio|heart/i, match: /cardiolog|kardiolog/i, words: ["Kardiologie"] },
	urology: { ask: /urolog/i, match: /urolog/i, words: ["Urologie"] },
	radiology: { ask: /radiolog|x-ray|mrt|mri/i, match: /radiolog/i, words: ["Radiologie"] },
	oral_surgery: { ask: /oral|kieferchirurg|wisdom/i, match: /oral|mund-|kieferchirurg/i, words: ["Kieferchirurgie", "Oralchirurgie"] },
};

/** The speciality a request means, as one of ours, or the request's own words when we don't know it. */
export function specialityOf(asked: string | undefined): { key?: string; match: RegExp; words: string[] } | undefined {
	const text = (asked || "").trim();
	if (!text) return undefined;
	for (const [key, entry] of Object.entries(SPECIALITIES)) if (entry.ask.test(text) || key === text.toLowerCase()) return { key, match: entry.match, words: entry.words };
	const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return { match: new RegExp(escaped, "i"), words: [text] };
}

/* Search boxes, smallest first: kilometres from the middle to the edge. */
const RINGS_KM = [1.5, 4, 10, 25];

interface NominatimHit {
	lat: string;
	lon: string;
	name?: string;
	display_name?: string;
	type?: string;
	category?: string;
	address?: Record<string, string>;
	extratags?: Record<string, string>;
	namedetails?: Record<string, string>;
}

/** One search result as a place, its hours read for `now`. */
export function placeFrom(hit: NominatimHit, now = new Date(), home?: { lat: number; lon: number }, from: "home" | "you" = "home"): Place {
	const address = hit.address || {};
	const tags = hit.extratags || {};
	const street = [address.road || address.pedestrian || address.footway, address.house_number].filter(Boolean).join(" ");
	const town = address.city || address.town || address.village || address.municipality || "";
	const lat = Number(hit.lat);
	const lon = Number(hit.lon);
	const hours = tags.opening_hours;
	const status = hours ? openingStatus(hours, now) : undefined;
	const website = tags.website || tags["contact:website"];
	const phone = tags.phone || tags["contact:phone"];
	return {
		name: hit.name || hit.namedetails?.name || (hit.display_name || "").split(",")[0] || "A place",
		...(hit.type ? { kind: hit.type.replace(/_/g, " ") } : {}),
		lat,
		lon,
		...(street || town ? { address: [street, [address.postcode, town].filter(Boolean).join(" ")].filter(Boolean).join(", ") } : {}),
		...(hours ? { hours } : {}),
		...(status ? { status } : {}),
		...(phone ? { phone: phone.split(";")[0].trim() } : {}),
		...(website && /^https?:\/\//i.test(website) ? { website } : {}),
		...(home ? { away: Math.round(distance(home, { lat, lon })), from } : {}),
	};
}

const away = (metres: number, from: "home" | "you" = "home") => {
	const where = from === "you" ? "from you" : "from home";
	return metres < 1000 ? `${Math.round(metres / 10) * 10} m ${where}` : `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km ${where}`;
};

/** A place as a card: the map, whether it's open, the address, and what to tap. */
export function placeEmbed(place: Place): Embed {
	const lines = [
		place.address,
		place.away !== undefined ? away(place.away, place.from) : undefined,
		place.hours && !place.status ? `Hours: ${place.hours}` : undefined,
	].filter((line): line is string => Boolean(line));
	const links = [
		{ label: "Directions", url: `https://maps.apple.com/?daddr=${place.lat},${place.lon}&q=${encodeURIComponent(place.name)}` },
		...(place.website ? [{ label: "Website", url: place.website }] : []),
		...(place.phone ? [{ label: "Call", url: `tel:${place.phone.replace(/[^\d+]/g, "")}` }] : []),
	];
	return { kind: "place", name: place.name, lat: place.lat, lon: place.lon, ...(place.status ? { status: place.status } : {}), lines, links };
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Nominatim's search, one request a second, near home when that's known. */
export class PlaceSearch {
	private chain: Promise<unknown> = Promise.resolve();
	private last = 0;

	constructor(private readonly options: { home?(): Promise<{ lat: number; lon: number } | undefined>; fetch?: FetchLike; spacingMs?: number; endpoint?: string } = {}) {}

	/** Places for a query, near home; or near `around` (where the user is) when given. */
	async find(query: string, now = new Date(), around?: { lat: number; lon: number }): Promise<Place[]> {
		const home = around || (await this.options.home?.().catch(() => undefined));
		const url = new URL(this.options.endpoint || "https://nominatim.openstreetmap.org/search");
		url.searchParams.set("q", query);
		url.searchParams.set("format", "jsonv2");
		url.searchParams.set("addressdetails", "1");
		url.searchParams.set("extratags", "1");
		url.searchParams.set("namedetails", "1");
		url.searchParams.set("limit", "5");
		url.searchParams.set("accept-language", "en");
		// Near home first (about 30 km around), without leaving the rest out.
		if (home) url.searchParams.set("viewbox", [home.lon - 0.4, home.lat + 0.25, home.lon + 0.4, home.lat - 0.25].map((value) => value.toFixed(4)).join(","));
		const hits = await this.get<NominatimHit[]>(url);
		// Places, not the streets and districts that share a word with them ("Saturnstraße" for Saturn).
		const places = (Array.isArray(hits) ? hits : []).filter((hit) => !["highway", "boundary", "landuse", "natural", "waterway"].includes(String(hit.category)));
		return places.map((hit) => placeFrom(hit, now, home, around ? "you" : "home"));
	}

	/**
	 * Places of a kind around the user (or home), closest first. Nominatim
	 * searches the kind's phrase, and a speciality's name words, inside a box
	 * that grows until a few turn up; results outside the circle are dropped.
	 */
	async nearby(kind: string, options: { around?: { lat: number; lon: number }; speciality?: string; now?: Date; limit?: number } = {}): Promise<{ places: Place[]; km: number; from: "home" | "you" } | undefined> {
		const entry = KINDS[kind];
		if (!entry) throw new Error(`I can't search for "${kind}" nearby. Kinds: ${Object.keys(KINDS).join(", ")}.`);
		const center = options.around || (await this.options.home?.().catch(() => undefined));
		if (!center) return undefined;
		const from = options.around ? "you" : "home";
		const speciality = specialityOf(options.speciality || entry.speciality);
		const queries = [entry.phrase, ...(speciality?.words || [])];
		const wanted = (hit: NominatimHit) => {
			const tags = hit.extratags || {};
			const isKind = entry.tags.some(([key, value]) => (hit.category === key && hit.type === value) || tags[key] === value);
			const text = `${tags["healthcare:speciality"] || ""} ${hit.name || ""} ${tags.description || ""}`;
			if (!speciality) return isKind;
			// A practice found by its name ("Kieferorthopädie Lindenau") counts even when it's tagged as something near enough.
			return speciality.match.test(text) && (isKind || ["amenity", "healthcare", "office"].includes(String(hit.category)));
		};
		const found: Place[] = [];
		// The same practice can come back from two searches, or as a building and a point inside it.
		const seen = (place: Place) => found.some((other) => other.name.toLowerCase() === place.name.toLowerCase() && distance(other, place) < 150);
		let km = RINGS_KM[0];
		for (km of RINGS_KM) {
			const dLat = km / 111;
			const dLon = km / (111 * Math.cos((center.lat * Math.PI) / 180));
			for (const query of queries) {
				const url = this.searchUrl(query);
				url.searchParams.set("limit", "40");
				url.searchParams.set("bounded", "1");
				url.searchParams.set("viewbox", [center.lon - dLon, center.lat + dLat, center.lon + dLon, center.lat - dLat].map((value) => value.toFixed(4)).join(","));
				const hits = await this.get<NominatimHit[]>(url).catch(() => [] as NominatimHit[]);
				for (const hit of Array.isArray(hits) ? hits : []) {
					if (!wanted(hit)) continue;
					const place = placeFrom(hit, options.now || new Date(), center, from);
					const tagged = hit.extratags?.["healthcare:speciality"];
					if (place.away !== undefined && place.away <= km * 1000 && !seen(place)) found.push({ ...place, ...(tagged ? { speciality: tagged.replace(/;/g, ", ") } : {}) });
				}
			}
			if (found.length >= 3) break;
		}
		const places = found.sort((a, b) => (a.away ?? 0) - (b.away ?? 0)).slice(0, options.limit ?? 5);
		return { places, km, from };
	}

	private searchUrl(query: string): URL {
		const url = new URL(this.options.endpoint || "https://nominatim.openstreetmap.org/search");
		url.searchParams.set("q", query);
		url.searchParams.set("format", "jsonv2");
		url.searchParams.set("addressdetails", "1");
		url.searchParams.set("extratags", "1");
		url.searchParams.set("namedetails", "1");
		url.searchParams.set("accept-language", "en");
		return url;
	}

	/** The address at a spot: "Riebeckstraße 12, Reudnitz-Thonberg, 04317 Leipzig". */
	async address(lat: number, lon: number): Promise<string | undefined> {
		const search = new URL(this.options.endpoint || "https://nominatim.openstreetmap.org/search");
		const url = new URL(search.pathname.replace(/search$/, "reverse"), search);
		url.searchParams.set("lat", lat.toFixed(6));
		url.searchParams.set("lon", lon.toFixed(6));
		url.searchParams.set("format", "jsonv2");
		url.searchParams.set("zoom", "18");
		url.searchParams.set("addressdetails", "1");
		url.searchParams.set("accept-language", "en");
		const hit = await this.get<NominatimHit>(url);
		const address = hit?.address || {};
		const street = [address.road || address.pedestrian || address.footway, address.house_number].filter(Boolean).join(" ");
		const area = address.suburb || address.neighbourhood || address.quarter;
		const town = [address.postcode, address.city || address.town || address.village || address.municipality].filter(Boolean).join(" ");
		const place = hit?.name && hit.name !== address.road ? hit.name : "";
		return [place, street, area, town].filter(Boolean).join(", ") || hit?.display_name || undefined;
	}

	/* One request a second, as Nominatim asks. */
	private get<T>(url: URL): Promise<T> {
		const run = this.chain.then(async () => {
			const wait = this.last + (this.options.spacingMs ?? 1_100) - Date.now();
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
			this.last = Date.now();
			const response = await (this.options.fetch || fetch)(url, { headers: { "User-Agent": "RemindMe/4 (Home Assistant app; personal assistant)", Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
			if (!response.ok) throw new Error(`OpenStreetMap's search answered ${response.status}.`);
			return (await response.json()) as T;
		});
		this.chain = run.catch(() => undefined);
		return run;
	}
}
