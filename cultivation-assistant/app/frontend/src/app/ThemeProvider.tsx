import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
	ThemeContext,
	type ThemeMode,
	type ResolvedTheme,
} from "./theme-context";
const STORAGE_KEY = "cultivation-assistant-theme";

function systemTheme(): ResolvedTheme {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [mode, setMode] = useState<ThemeMode>(() => {
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored === "light" || stored === "dark" || stored === "system"
			? stored
			: "system";
	});
	const [systemPreference, setSystemPreference] =
		useState<ResolvedTheme>(systemTheme);
	const resolvedTheme = mode === "system" ? systemPreference : mode;

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const updatePreference = () =>
			setSystemPreference(media.matches ? "dark" : "light");
		media.addEventListener("change", updatePreference);
		return () => media.removeEventListener("change", updatePreference);
	}, []);

	useEffect(() => {
		document.documentElement.dataset.theme = resolvedTheme;
		document.documentElement.style.colorScheme = resolvedTheme;
		localStorage.setItem(STORAGE_KEY, mode);
	}, [mode, resolvedTheme]);

	const value = useMemo(
		() => ({ mode, resolvedTheme, setMode }),
		[mode, resolvedTheme],
	);
	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}
