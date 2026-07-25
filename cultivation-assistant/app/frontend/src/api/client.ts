import { z } from "zod";

export const errorEnvelopeSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.record(z.string(), z.unknown()),
	}),
});

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export const jsonHeaders = {
	Accept: "application/json",
	"Content-Type": "application/json",
};

export const acceptJson = { Accept: "application/json" };

export async function parseResponse<T>(
	response: Response,
	schema: z.ZodType<T>,
	invalidMessage: string,
): Promise<T> {
	const payload: unknown = await response.json();
	if (!response.ok) {
		const parsedError = errorEnvelopeSchema.safeParse(payload);
		throw new ApiError(
			parsedError.success ? parsedError.data.error.message : "Request failed",
			response.status,
			parsedError.success ? parsedError.data.error.code : "request_failed",
		);
	}
	const parsed = schema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(invalidMessage);
	}
	return parsed.data;
}

export async function expectOk(
	response: Response,
	message: string,
	code: string,
): Promise<void> {
	if (!response.ok) {
		let apiCode = code;
		let apiMessage = message;
		try {
			const payload: unknown = await response.json();
			const parsed = errorEnvelopeSchema.safeParse(payload);
			if (parsed.success) {
				apiCode = parsed.data.error.code;
				apiMessage = parsed.data.error.message;
			}
		} catch {
			// Non-JSON error body; keep the provided fallback message.
		}
		throw new ApiError(apiMessage, response.status, apiCode);
	}
}
