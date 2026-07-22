import esbuild from "esbuild";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

// three and its addons are bundled in — Obsidian plugins ship a single main.js,
// and this is where the render core's bare `three` / `three/addons/*` imports
// get resolved, exactly as the render core's header anticipates.
const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", ...builtins],
	format: "cjs",
	target: "es2020",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	minify: production,
	outfile: "main.js",
	loader: { ".js": "js" },
});

if (production) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
