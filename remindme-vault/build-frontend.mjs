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

await esbuild.build({
	entryPoints: ["frontend/src/entry.js"],
	bundle: true,
	format: "esm",
	target: ["es2020"],
	minify: true,
	legalComments: "none",
	outfile: "public/bundle.js",
	plugins: [threeAddons],
	logLevel: "info",
});

console.log("[build] wrote public/bundle.js");
