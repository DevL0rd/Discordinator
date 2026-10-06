import { createHash, randomUUID } from 'node:crypto';
import type { Origin, Policy } from './policy.js';

interface Approval {
    actorId: string;
    channelId: string;
    fingerprint: string;
    confirmed: boolean;
    expiresAt: number;
}

const lifetimeMs = 7 * 24 * 60 * 60_000;

export class Approvals {
    private items = new Map<string, Approval>();
    constructor(
        readonly policy: Policy,
        readonly now = Date.now,
    ) {}

    private fingerprint(input: unknown): string {
        return createHash('sha256').update(JSON.stringify(input)).digest('hex');
    }

    private prune(): void {
        for (const [id, item] of this.items) if (item.expiresAt <= this.now()) this.items.delete(id);
    }

    private pending(origin: Origin, fingerprint: string): string | undefined {
        for (const [id, item] of this.items)
            if (
                !item.confirmed &&
                item.actorId === origin.actorId &&
                item.channelId === origin.channelId &&
                item.fingerprint === fingerprint
            )
                return id;
    }

    prepare(origin: Origin, input: unknown) {
        this.policy.assertOrigin(origin);
        this.prune();
        const fingerprint = this.fingerprint(input);
        const approvalId = this.pending(origin, fingerprint) ?? randomUUID();
        if (!this.items.has(approvalId) && this.items.size >= 100) throw new Error('Approval queue is full');
        this.items.set(approvalId, {
            actorId: origin.actorId,
            channelId: origin.channelId,
            fingerprint,
            confirmed: false,
            expiresAt: this.now() + lifetimeMs,
        });
        return {
            approvalId,
            expiresInSeconds: lifetimeMs / 1000,
            preview: input,
            instruction:
                'Show this exact preview to the originating user. They must mention/name the bot and say approve followed by approvalId in the same Discord channel. Then repeat the exact tool input with approvalId.',
        };
    }

    confirm(origin: Origin, id: string): boolean {
        this.policy.assertOrigin(origin);
        this.prune();
        const item = this.items.get(id);
        if (!item) return false;
        if (item.actorId !== origin.actorId || item.channelId !== origin.channelId) return false;
        item.confirmed = true;
        return true;
    }

    assert(id: string, origin: Origin, input: unknown): void {
        this.policy.assertOrigin(origin);
        this.prune();
        const item = this.items.get(id);
        if (!item || !item.confirmed) throw new Error('Fresh Discord confirmation is required for this exact pending action');
        if (item.actorId !== origin.actorId || item.channelId !== origin.channelId) throw new Error('Approval origin mismatch');
        if (item.fingerprint !== this.fingerprint(input)) throw new Error('Approval input mismatch');
    }

    consume(id: string): void {
        this.items.delete(id);
    }
}
