import { createHash, randomUUID } from 'node:crypto';
import type { Origin, Policy } from './policy.js';

interface Approval {
    actorId: string;
    channelId: string;
    fingerprint: string;
    expires: number;
    confirmed: boolean;
}

export class Approvals {
    private items = new Map<string, Approval>();
    constructor(
        readonly policy: Policy,
        readonly now = Date.now,
    ) {}

    private fingerprint(input: unknown): string {
        return createHash('sha256').update(JSON.stringify(input)).digest('hex');
    }

    prepare(origin: Origin, input: unknown) {
        this.policy.assertOrigin(origin);
        for (const [key, item] of this.items) if (item.expires <= this.now()) this.items.delete(key);
        if (this.items.size >= 100) throw new Error('Approval queue is full');
        const approvalId = randomUUID();
        this.items.set(approvalId, {
            actorId: origin.actorId,
            channelId: origin.channelId,
            fingerprint: this.fingerprint(input),
            expires: this.now() + 120_000,
            confirmed: false,
        });
        return {
            approvalId,
            expiresInSeconds: 120,
            preview: input,
            instruction:
                'Show this exact preview to the originating user. They must mention/name the bot and say approve followed by approvalId in the same Discord channel. Then repeat the exact tool input with approvalId.',
        };
    }

    confirm(origin: Origin, id: string): boolean {
        this.policy.assertOrigin(origin);
        const item = this.items.get(id);
        if (!item || item.expires <= this.now()) return false;
        if (item.actorId !== origin.actorId || item.channelId !== origin.channelId) return false;
        item.confirmed = true;
        return true;
    }

    assert(id: string, origin: Origin, input: unknown): void {
        this.policy.assertOrigin(origin);
        const item = this.items.get(id);
        if (!item || !item.confirmed || item.expires <= this.now()) throw new Error('Fresh Discord confirmation is required');
        if (item.actorId !== origin.actorId || item.channelId !== origin.channelId) throw new Error('Approval origin mismatch');
        if (item.fingerprint !== this.fingerprint(input)) throw new Error('Approval input mismatch');
    }

    consume(id: string): void {
        this.items.delete(id);
    }
}
