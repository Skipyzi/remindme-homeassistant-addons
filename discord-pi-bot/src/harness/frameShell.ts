import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The document every executable artifact is served inside.
 *
 * The frame allows inline script and nothing else — no network, no eval,
 * no wasm — so a runtime cannot be fetched and cannot be unpacked from a
 * string. It has to arrive as inline script text, which is why the
 * libraries are read off disk here and written into the document.
 *
 * Failures are reported into the frame and posted to the console around
 * it, so a broken shader or a Lua syntax error shows up under the editor
 * rather than only as a blank rectangle.
 */

/** Escaping every `<` keeps source data from closing the script tag. */
export function encodeForScript(source: string): string {
	return JSON.stringify(source).replace(/</g, "\\u003c");
}

/**
 * For code that has to execute rather than be read as data. It cannot be
 * a JSON string — there is no eval to unpack it with — so it goes in
 * verbatim, with only the sequence that would end the script neutralised.
 * `<\/script` is valid inside a JavaScript string or regex, which is the
 * only place it can legitimately appear.
 */
export function inlineScriptBody(source: string): string {
	return source.replace(/<\/script/gi, "<\\/script");
}

const FRAME_STYLE = `html,body{margin:0;height:100%;background:#160f04;
color:#e8dcc0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
canvas{display:block;width:100%;height:100%}
/* After the canvas rule and marked important: an author-level display
 * beats the user agent's [hidden] whatever its specificity, so without
 * this the canvas stayed full height over a failed run and pushed the
 * message out of the frame. */
[hidden]{display:none!important}
pre{margin:0;padding:12px;font-size:11.5px;line-height:1.5;color:#ffb200;
white-space:pre-wrap;overflow-wrap:anywhere}
pre b{display:block;margin-bottom:6px;color:#8a7d5c;font-weight:normal;
letter-spacing:1.2px;text-transform:uppercase;font-size:9px}
#out{position:absolute;left:0;right:0;bottom:0;max-height:45%;overflow:auto;
color:#e8dcc0;background:rgba(0,0,0,0.45);border-top:1px solid #5c4416}
body{position:relative}
/* A program that only prints has no canvas to sit under, so the console
 * takes the whole frame rather than a strip pinned to the bottom of an
 * empty rectangle. */
body.console-only #out{position:static;max-height:none;height:100%;
background:none;border-top:0}`;

/** A canvas, a failure pane, and a console for anything the code prints. */
export const STAGE = `<canvas id="stage"></canvas><pre id="log" hidden></pre><pre id="out" hidden></pre>`;

/**
 * Shared frame plumbing: failure reporting, print capture, canvas sizing
 * and pointer tracking. Every runtime below builds on this.
 */
export const FRAME_RUNTIME = `
const stage = document.getElementById("stage");
const log = document.getElementById("log");
const out = document.getElementById("out");
function tell(message) {
  /* The console around the frame shows this under the editor. Opaque
   * origin, so the parent checks the source window rather than the origin. */
  try { parent.postMessage({ artifactStatus: message }, "*"); } catch (_) {}
}
function report(title, detail) {
  /* Driver logs arrive NUL-terminated and often ragged; tidy before showing. */
  const clean = String(detail).replace(/\\u0000/g, "").replace(/^\\s+/gm, "").trim();
  log.hidden = false;
  stage.hidden = true;
  log.textContent = "";
  const heading = document.createElement("b");
  heading.textContent = title;
  log.append(heading, document.createTextNode(clean));
  tell(title + ": " + clean);
}
function write(line) {
  out.hidden = false;
  out.append(document.createTextNode(line + "\\n"));
  out.scrollTop = out.scrollHeight;
}
/* Anything the code prints lands in the frame instead of a devtools pane
 * nobody has open. */
const nativeLog = console.log.bind(console);
console.log = (...args) => {
  write(args.map((value) => (typeof value === "string" ? value : String(value))).join(" "));
  nativeLog(...args);
};
console.error = (...args) => write("! " + args.map(String).join(" "));
console.warn = (...args) => write("? " + args.map(String).join(" "));
window.addEventListener("error", (event) => {
  report("failed", event.message || String(event.error || "Unknown error"));
});
window.addEventListener("unhandledrejection", (event) => {
  report("failed", String(event.reason));
});
function fitCanvas() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(stage.clientWidth * ratio));
  const height = Math.max(1, Math.floor(stage.clientHeight * ratio));
  if (stage.width !== width || stage.height !== height) {
    stage.width = width;
    stage.height = height;
    return true;
  }
  return false;
}
const pointer = { x: 0, y: 0 };
stage.addEventListener("pointermove", (event) => {
  const box = stage.getBoundingClientRect();
  pointer.x = (event.clientX - box.left) / Math.max(1, box.width);
  pointer.y = 1 - (event.clientY - box.top) / Math.max(1, box.height);
});
`;

export function buildFrame(scripts: string[]): string {
	return (
		`<!doctype html><html><head><meta charset="utf-8">` +
		`<style>${FRAME_STYLE}</style></head><body>${STAGE}` +
		scripts.map((code) => `<script>${code}</script>`).join("") +
		`</body></html>`
	);
}

/*
 * Runtimes are read once and held. They are hundreds of kilobytes and the
 * frame has no way to fetch them, so every document that needs one carries
 * a copy — reading that off an SD card per request would be the slowest
 * part of opening an artifact.
 */
const cache = new Map<string, string>();

export function vendorScript(file: string): string {
	const hit = cache.get(file);
	if (hit !== undefined) return hit;
	try {
		const text = readFileSync(resolve(process.cwd(), "public/vendor", file), "utf8");
		cache.set(file, text);
		return text;
	} catch (error) {
		console.error(`Artifact runtime ${file} is missing:`, error);
		cache.set(file, "");
		return "";
	}
}
