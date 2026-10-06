import { randomUUID } from 'node:crypto';
import type { Policy } from '../core/policy.js';
import { Uploads, uploadSchema } from './uploads.js';
import type { z } from 'zod';

type Input = Omit<z.infer<typeof uploadSchema>, 'eventId'> & { channelId: string; scopeId?: string };
interface Session {
    id: string;
    channelId: string;
    key: string;
    expires: number;
}
export class ProactiveUploads {
    private sessions = new Map<string, Session>();
    readonly uploads: Uploads;
    constructor(
        readonly policy: Policy,
        readonly now = Date.now,
    ) {
        this.uploads = new Uploads({ policy, event: (id) => this.authorize(id) }, now);
    }
    private authorize(id: string) {
        const session = this.sessions.get(id);
        if (!session || session.expires <= this.now()) throw new Error('Upload buffer session unavailable; begin a new upload');
        this.policy.assertProactive(session.channelId);
        this.policy.assertScope('media.write');
        if (!this.policy.config.media.enabled) throw new Error('Media is disabled');
        return { expiresAt: session.expires };
    }
    begin(input: Input) {
        this.policy.assertProactive(input.channelId);
        this.policy.assertScope('media.write');
        for (const [id, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(id);
        const session = input.scopeId ? this.joined(input.scopeId) : this.opened(input.idempotencyKey, input.channelId);
        if (session.channelId !== input.channelId) throw new Error('Upload destination cannot change');
        const { channelId: _channel, scopeId: _scope, ...upload } = input;
        return { scopeId: session.id, ...this.uploads.begin({ ...upload, eventId: session.id }) };
    }
    private joined(scopeId: string): Session {
        const session = this.sessions.get(scopeId);
        if (!session) throw new Error('Upload buffer session unavailable; begin a new upload');
        return session;
    }
    private opened(key: string, channelId: string): Session {
        const existing = [...this.sessions.values()].find((item) => item.key === key);
        if (existing) return existing;
        if (this.sessions.size >= 16) throw new Error('Upload session limit reached');
        const session = { id: randomUUID(), channelId, key, expires: this.now() + 10 * 60_000 };
        this.sessions.set(session.id, session);
        return session;
    }
    ready(channelId: string, scopeId: string, ids: string[]) {
        this.authorize(scopeId);
        if (this.sessions.get(scopeId)!.channelId !== channelId) throw new Error('Upload destination mismatch');
        return this.uploads.ready(scopeId, ids);
    }
}
