export type LocalEndpointKind = "inference" | "manager";

export const CANONICAL_INFERENCE_URL =
	"http://homeassistant:8080/v1/chat/completions";
export const CANONICAL_MANAGER_URL = "http://homeassistant:8080/manager/v1";

const endpointPaths: Record<LocalEndpointKind, string> = {
	inference: "/v1/chat/completions",
	manager: "/manager/v1",
};

export function canonicalLocalEndpoint(
	value: string,
	kind: LocalEndpointKind,
	allowLegacyLoopback = false,
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${kind} endpoint must be a valid URL`);
	}
	const allowedHosts = allowLegacyLoopback
		? ["homeassistant", "localhost", "127.0.0.1"]
		: ["homeassistant"];
	if (
		url.protocol !== "http:" ||
		url.port !== "8080" ||
		!allowedHosts.includes(url.hostname) ||
		url.pathname !== endpointPaths[kind] ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	)
		throw new Error(`${kind} endpoint must target the local add-on network`);
	return kind === "inference"
		? CANONICAL_INFERENCE_URL
		: CANONICAL_MANAGER_URL;
}
