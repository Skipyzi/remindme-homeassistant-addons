import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

const storage = new Map<string, string>();
const localStorageMock: Storage = {
	get length() {
		return storage.size;
	},
	clear: () => storage.clear(),
	getItem: (key) => storage.get(key) ?? null,
	key: (index) => [...storage.keys()][index] ?? null,
	removeItem: (key) => storage.delete(key),
	setItem: (key, value) => storage.set(key, value),
};
Object.defineProperty(window, "localStorage", {
	configurable: true,
	value: localStorageMock,
});
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: localStorageMock,
});

Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
});
