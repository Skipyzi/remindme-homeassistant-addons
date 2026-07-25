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
import { GrowDetailPage } from "../routes/GrowDetailPage";
import { GrowSpaceDetailPage } from "../routes/GrowSpaceDetailPage";
import { GrowSpacesPage } from "../routes/GrowSpacesPage";
import { OverviewPage } from "../routes/OverviewPage";
import { PlantCreatePage } from "../routes/PlantCreatePage";
import { PlantDetailPage } from "../routes/PlantDetailPage";
import { PlantsPage } from "../routes/PlantsPage";
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
const growSpaceDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/grow-spaces/$growSpaceId",
	component: GrowSpaceDetailPage,
});
const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings",
	component: SettingsPage,
});
const plantsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/plants",
	component: PlantsPage,
});
const growDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/grows/$growId",
	component: GrowDetailPage,
});
const plantCreateRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/grows/$growId/plants/new",
	component: PlantCreatePage,
});
const plantDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/plants/$plantId",
	component: PlantDetailPage,
});
const placeholderPaths = [
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
	growSpaceDetailRoute,
	settingsRoute,
	plantsRoute,
	growDetailRoute,
	plantCreateRoute,
	plantDetailRoute,
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
