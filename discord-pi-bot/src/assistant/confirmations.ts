import { randomBytes } from "node:crypto";
import type { ValidatedEntityAction } from "../harness/entityActions";

/** What the console and Discord show for an action that waits for a tap. */
export interface Confirmation {
	confirmation_required: true;
	token: string;
	destructive?: boolean;
	/** "Unlock Front door", "Send "Re: Ihre Rechnung" to kundenservice@stadtwerke.de". */
	message: string;
	/** What it acts on: an entity id, or "mail" for an email. */
	entityId: string;
	/** More to read before tapping, such as the text of an email. */
	detail?: string;
}

/** Something that waits for a tap: what it is, and how to carry it out. */
export interface Pending {
	label: string;
	entityId: string;
	destructive?: boolean;
	detail?: string;
	/** For a Home Assistant service call, the call itself. */
	action?: ValidatedEntityAction;
	perform(): Promise<void>;
}

interface Held {
	pending: Pending;
	expires: number;
	at: number;
}

const TTL_MS = 15 * 60_000;

/**
 * Actions the assistant may not carry out on its own (locks, doors, covers,
 * alarms, calendar events, sending an email): held under a one-time token
 * until the owner confirms in the console or taps the Discord button. Kept in
 * memory on purpose: a restart forgets them, which is the safe direction.
 */
export class ConfirmationStore {
	private readonly held = new Map<string, Held>();

	hold(pending: Pending, now = Date.now()): Confirmation {
		this.sweep(now);
		const token = randomBytes(12).toString("hex");
		this.held.set(token, { pending, expires: now + TTL_MS, at: now });
		return this.view(token, pending);
	}

	/** The held action, once. Expired or unknown tokens give undefined. */
	take(token: string, now = Date.now()): Pending | undefined {
		this.sweep(now);
		const held = this.held.get(token);
		if (!held) return undefined;
		this.held.delete(token);
		return held.pending;
	}

	cancel(token: string): boolean {
		return this.held.delete(token);
	}

	/** What is still waiting, oldest first, for the console's "Needs you". */
	list(now = Date.now()): Array<Confirmation & { at: string }> {
		this.sweep(now);
		return [...this.held.entries()].sort(([, a], [, b]) => a.at - b.at).map(([token, held]) => ({ ...this.view(token, held.pending), at: new Date(held.at).toISOString() }));
	}

	private view(token: string, pending: Pending): Confirmation {
		return {
			confirmation_required: true,
			token,
			destructive: pending.destructive || undefined,
			message: pending.label,
			entityId: pending.entityId,
			...(pending.detail ? { detail: pending.detail } : {}),
		};
	}

	private sweep(now: number) {
		for (const [token, held] of this.held) if (held.expires <= now) this.held.delete(token);
	}
}
