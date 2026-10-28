import { randomBytes } from "node:crypto";
import type { ValidatedEntityAction } from "../harness/entityActions";

/** What the console and Discord show for an action that waits for a tap. */
export interface Confirmation {
	confirmation_required: true;
	token: string;
	destructive?: boolean;
	/** "Unlock Front door". */
	message: string;
	entityId: string;
}

interface Held {
	action: ValidatedEntityAction;
	label: string;
	expires: number;
	at: number;
}

const TTL_MS = 15 * 60_000;

/**
 * Device actions the assistant may not carry out on its own (locks, doors,
 * covers, alarms): held under a one-time token until the owner confirms in
 * the console or taps the Discord button. Kept in memory on purpose: a
 * restart forgets them, which is the safe direction.
 */
export class ConfirmationStore {
	private readonly held = new Map<string, Held>();

	hold(action: ValidatedEntityAction, label: string, now = Date.now()): Confirmation {
		this.sweep(now);
		const token = randomBytes(12).toString("hex");
		this.held.set(token, { action, label, expires: now + TTL_MS, at: now });
		return {
			confirmation_required: true,
			token,
			destructive: action.destructive || undefined,
			message: label,
			entityId: action.entityId,
		};
	}

	/** The held action, once. Expired or unknown tokens give undefined. */
	take(token: string, now = Date.now()): { action: ValidatedEntityAction; label: string } | undefined {
		this.sweep(now);
		const held = this.held.get(token);
		if (!held) return undefined;
		this.held.delete(token);
		return { action: held.action, label: held.label };
	}

	cancel(token: string): boolean {
		return this.held.delete(token);
	}

	/** What is still waiting, oldest first, for the console's "Waiting on you". */
	list(now = Date.now()): Array<Confirmation & { at: string }> {
		this.sweep(now);
		return [...this.held.entries()]
			.sort(([, a], [, b]) => a.at - b.at)
			.map(([token, held]) => ({
				confirmation_required: true as const,
				token,
				destructive: held.action.destructive || undefined,
				message: held.label,
				entityId: held.action.entityId,
				at: new Date(held.at).toISOString(),
			}));
	}

	private sweep(now: number) {
		for (const [token, held] of this.held) if (held.expires <= now) this.held.delete(token);
	}
}
