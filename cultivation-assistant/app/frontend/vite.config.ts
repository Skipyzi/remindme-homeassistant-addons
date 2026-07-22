import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	base: "./",
	plugins: [react(), tailwindcss()],
	server: {
		proxy: { "/api": "http://localhost:8000" },
	},
	test: {
		environment: "jsdom",
		setupFiles: "./src/test/setup.ts",
	},
});
