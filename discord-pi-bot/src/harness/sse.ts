import type { Response } from "express";

export type SendEvent = (event: string, data: unknown) => void;

export function createSseSender(response: Response): SendEvent {
	return (event, data) => {
		response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};
}
