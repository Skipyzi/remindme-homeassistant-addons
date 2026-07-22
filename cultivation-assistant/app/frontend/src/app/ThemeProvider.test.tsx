import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "./ThemeProvider";
import { useTheme } from "./theme-context";

function ThemeControl() {
	const { mode, setMode } = useTheme();
	return <button onClick={() => setMode("dark")}>Theme: {mode}</button>;
}

describe("ThemeProvider", () => {
	it("applies and persists dark mode", async () => {
		localStorage.clear();
		render(
			<ThemeProvider>
				<ThemeControl />
			</ThemeProvider>,
		);

		await userEvent.click(screen.getByRole("button"));

		expect(document.documentElement).toHaveAttribute("data-theme", "dark");
		expect(localStorage.getItem("cultivation-assistant-theme")).toBe("dark");
	});
});
