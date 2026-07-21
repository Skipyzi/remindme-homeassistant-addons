import {
	FRAME_RUNTIME,
	buildFrame,
	encodeForScript,
	inlineScriptBody,
	vendorScript,
} from "./frameShell";

/**
 * Runtimes that are libraries rather than drivers: three.js for scenes,
 * Fengari for Lua. Both are plain JavaScript, so they run under the
 * frame's existing policy — no wasm, no eval, nothing to relax.
 *
 * The cost is that each is inlined into the document, since the frame
 * cannot fetch and `script-src` names no origin it could fetch from.
 */

/**
 * A scene, a camera and a renderer, already sized and running.
 *
 * The model is asked for scene code rather than a whole program because
 * that is the part it can actually write: three.js is heavily represented
 * in training data, while the renderer-and-resize boilerplate around it is
 * where a small model reliably goes wrong.
 */
const THREE_SETUP = `
${FRAME_RUNTIME}
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
camera.position.set(0, 0, 5);
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
renderer.setClearColor(0x160f04, 1);
const clock = new THREE.Clock();
function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  renderer.setPixelRatio(ratio);
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
`;

/* Started after the scene code so a definition of update() is picked up. */
const THREE_START = `
resize();
(function loop() {
  requestAnimationFrame(loop);
  resize();
  const delta = clock.getDelta();
  if (typeof update === "function") {
    try { update(delta, clock.elapsedTime); }
    catch (error) { report("failed", error.message || String(error)); return; }
  }
  renderer.render(scene, camera);
})();
`;

export function threeDocument(source: string): string {
	const library = vendorScript("three.min.js");
	if (!library)
		return buildFrame([
			`${FRAME_RUNTIME}\nreport("runtime missing", "three.min.js is not installed in public/vendor.");`,
		]);
	/*
	 * Four scripts, not one. A syntax error in the scene code takes down
	 * only its own tag, so the reporting installed by the setup script is
	 * still there to catch it and say what happened.
	 */
	return buildFrame([
		library,
		THREE_SETUP,
		inlineScriptBody(source),
		THREE_START,
	]);
}

/**
 * Lua, interpreted in JavaScript. Output goes to the frame's console: a
 * Lua artifact is usually a program with something to say rather than
 * something to look at, so the canvas steps aside unless the script draws.
 */
const LUA_RUNNER = `
${FRAME_RUNTIME}
const source = __SOURCE__;
/* Lua here is usually a program that prints, not one that draws: hand the
 * frame to the console. A script that wants the canvas can still unhide it. */
stage.hidden = true;
out.hidden = false;
document.body.classList.add("console-only");
if (typeof fengari === "undefined") {
  report("runtime missing", "fengari-web.js is not installed in public/vendor.");
} else {
  try {
    /* load() throws SyntaxError before running a line, which is the error
     * worth separating: it means the chunk never started. */
    const chunk = fengari.load(source, "@artifact");
    chunk();
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    report(syntax ? "syntax error" : "failed", error.message || String(error));
  }
}
`;

export function luaDocument(source: string): string {
	const library = vendorScript("fengari-web.js");
	if (!library)
		return buildFrame([
			`${FRAME_RUNTIME}\nreport("runtime missing", "fengari-web.js is not installed in public/vendor.");`,
		]);
	return buildFrame([
		library,
		LUA_RUNNER.replace("__SOURCE__", encodeForScript(source)),
	]);
}
