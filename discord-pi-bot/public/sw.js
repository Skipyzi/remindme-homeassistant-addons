/*
 * The phone app's service worker. The page and its files come from the Pi
 * first and from this cache only when the Pi can't be reached, so an update
 * shows on the next open. The API is never cached. Push messages become
 * notifications; tapping one opens the thread it is about.
 */
const CACHE = "remindme-shell";
const SHELL = ["./", "./styles.css", "./app.js", "./components/richtext.js", "./components/highlight.js", "./vendor/alpine.min.js", "./fonts/geist-mono.woff2", "./manifest.webmanifest", "./icons/icon-192.png"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL))
			.catch(() => {})
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/") || url.pathname.includes("/internal/")) return;
	event.respondWith(
		fetch(request)
			.then((response) => {
				if (response.ok) {
					const copy = response.clone();
					caches.open(CACHE).then((cache) => cache.put(request, copy));
				}
				return response;
			})
			.catch(() => caches.match(request).then((hit) => hit || caches.match("./"))),
	);
});

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { body: event.data ? event.data.text() : "" };
	}
	// The app icon's count of what waits for a decision, where the phone shows one.
	if (typeof data.badge === "number" && "setAppBadge" in self.navigator) (data.badge ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {});
	event.waitUntil(
		self.registration.showNotification(data.title || "RemindMe", {
			body: data.body || "",
			tag: data.tag,
			renotify: Boolean(data.tag),
			icon: "./icons/icon-192.png",
			badge: "./icons/badge-96.png",
			data: { url: data.url || "./" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
			for (const client of windows) {
				if (!client.url.startsWith(self.registration.scope)) continue;
				await client.focus();
				if (client.url !== target && "navigate" in client) await client.navigate(target).catch(() => {});
				return;
			}
			await self.clients.openWindow(target);
		}),
	);
});
