// Bundles the constellation view (three.js + render core + adapter) into one
// self-hosted ES module at ./constellation.js. Run after `npm install`:
//
//   cd searxng/frontend && npm install && node build.mjs
//
// The committed constellation.js is the shipped artifact — the Docker image
// carries no toolchain, so rebuild here and commit the output when the source
// under src/ changes.

import * as esbuild from "esbuild";

// three ships its example modules under examples/jsm; the "three/addons/…"
// alias is only an import-map convention, so rewrite it for the bundler.
const threeAddons = {
	name: "three-addons",
	setup(build) {
		build.onResolve({ filter: /^three\/addons\// }, (args) =>
			build.resolve(args.path.replace(/^three\/addons\//, "three/examples/jsm/"), {
				kind: args.kind,
				resolveDir: args.resolveDir,
			})
		);
	},
};

await esbuild.build({
	entryPoints: ["src/constellation-entry.js"],
	bundle: true,
	format: "esm",
	target: ["es2020"],
	minify: true,
	legalComments: "none",
	outfile: "constellation.js",
	plugins: [threeAddons],
	logLevel: "info",
});

console.log("[build] wrote constellation.js");
