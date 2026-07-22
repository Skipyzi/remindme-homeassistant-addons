import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

const healthSchema = z.object({
	status: z.literal("healthy"),
	version: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthSchema>;

export async function fetchHealth(
	fetcher: typeof fetch = fetch,
): Promise<HealthResponse> {
	const response = await fetcher("api/v1/health", {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`Health request failed with status ${response.status}`);
	}
	const payload: unknown = await response.json();
	const result = healthSchema.safeParse(payload);
	if (!result.success) {
		throw new Error("Invalid health response");
	}
	return result.data;
}

export function useHealthQuery() {
	return useQuery({
		queryKey: ["system", "health"],
		queryFn: () => fetchHealth(),
		refetchInterval: 30_000,
	});
}
