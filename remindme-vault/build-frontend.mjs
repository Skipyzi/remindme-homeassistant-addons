// Bundles the vault frontend (three.js + render core + adapter + editor) into
// one self-hosted ES module at public/bundle.js. Run by `npm run build` after
// `tsc`; the Docker image runs both at build time.

import * as esbuild from "esbuild";

// three ships its example modules under examples/jsm; "three/addons/…" is only
// an import-map convention, so rewrite it for the bundler (same shim SearXNG's
// build uses).
const threeAddons = {
	name: "three-addons",
	setup(build) {
		build.onResolve({ filter: /^three\/addons\// }, (args) =>
			build.resolve(
				args.path.replace(/^three\/addons\//, "three/examples/jsm/"),
				{ kind: args.kind, resolveDir: args.resolveDir },
			),
		);
	},
};

// Code splitting keeps mermaid (large, only needed when a note has a diagram)
// out of the main bundle: it becomes a chunk fetched on demand. Splitting needs
// an outdir rather than a single outfile; entryNames pins the main entry to the
// stable public/bundle.js the page loads, chunks land under public/chunks/.
await esbuild.build({
	entryPoints: ["frontend/src/entry.js"],
	bundle: true,
	format: "esm",
	target: ["es2020"],
	minify: true,
	legalComments: "none",
	splitting: true,
	outdir: "public",
	entryNames: "bundle",
	chunkNames: "chunks/[name]-[hash]",
	plugins: [threeAddons],
	logLevel: "info",
});

console.log("[build] wrote public/bundle.js");
