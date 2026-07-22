import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createHashHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { AppShell } from "../components/layout/AppShell";
import { ThemeProvider } from "./ThemeProvider";
import { ComingSoonPage } from "../routes/ComingSoonPage";
import { GrowSpacesPage } from "../routes/GrowSpacesPage";
import { OverviewPage } from "../routes/OverviewPage";
import { SettingsPage } from "../routes/SettingsPage";

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: OverviewPage,
});
const growSpacesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/grow-spaces",
	component: GrowSpacesPage,
});
const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings",
	component: SettingsPage,
});
const placeholderPaths = [
	"/plants",
	"/timeline",
	"/environment",
	"/reservoirs",
	"/feeding",
	"/tasks",
	"/costs",
	"/library",
	"/reports",
] as const;
const placeholderRoutes = placeholderPaths.map((path) =>
	createRoute({
		getParentRoute: () => rootRoute,
		path,
		component: ComingSoonPage,
	}),
);
const routeTree = rootRoute.addChildren([
	indexRoute,
	growSpacesRoute,
	settingsRoute,
	...placeholderRoutes,
]);
const router = createRouter({ routeTree, history: createHashHistory() });
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

export function App() {
	return (
		<ThemeProvider>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</ThemeProvider>
	);
}
