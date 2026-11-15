import type { Response } from "express";

export type SendEvent = (event: string, data: unknown) => void;

export function createSseSender(response: Response): SendEvent {
	return (event, data) => {
		// A turn outlives the app that asked: once its connection is gone, the events have nowhere to go.
		if (response.writableEnded || response.destroyed) return;
		response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};
}
