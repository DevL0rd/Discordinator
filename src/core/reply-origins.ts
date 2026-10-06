import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { replaceFile } from './replace-file.js';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { BotEvent } from './queue.js';
import { snowflake } from './config.js';

const eventSchema = z
    .object({
        id: z.uuid(),
        cursor: z.number().int().min(1),
        receivedAt: z.iso.datetime(),
        kind: z.literal('message'),
        actorId: snowflake,
        channelId: snowflake,
        guildId: snowflake.nullable(),
        messageId: snowflake,
        text: z.string().max(4000),
    })
    .strict();
const recordSchema = z.object({ event: eventSchema, revoked: z.boolean().default(false) }).strict();
const schema = z.record(z.uuid(), recordSchema);
type Records = z.infer<typeof schema>;

const retentionMs = 30 * 24 * 60 * 60_000;

function expire(records: Records, now: number): void {
    for (const [id, record] of Object.entries(records))
        if (record.revoked || Date.parse(record.event.receivedAt) < now - retentionMs) delete records[id];
}

export class ReplyOrigins {
    private records = Object.create(null) as Records;
    private tail = Promise.resolve();
    constructor(readonly file: string) {}
    async load(): Promise<void> {
        try {
            if ((await stat(this.file)).size > 16 * 1024 * 1024) throw new Error('Reply origin storage limit reached');
            this.records = schema.parse(JSON.parse(await readFile(this.file, 'utf8')));
            for (const [id, record] of Object.entries(this.records))
                if (id !== record.event.id) throw new Error('Reply origin ID mismatch');
            expire(this.records, Date.now());
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    findMessage(channelId: string, messageId: string): boolean {
        return Object.values(this.records).some((record) => record.event.channelId === channelId && record.event.messageId === messageId);
    }
    context(id: string): BotEvent {
        const record = this.records[id];
        if (!record || record.revoked) throw new Error('Reply origin unknown or revoked');
        return structuredClone(record.event);
    }
    has(id: string): boolean {
        return Object.hasOwn(this.records, id);
    }
    capture(event: BotEvent): Promise<void> {
        return this.change((records) => {
            const parsed = eventSchema.parse(event);
            if (records[event.id]) throw new Error('Reply origin already recorded');
            if (
                Object.values(records).some(
                    (record) => record.event.channelId === event.channelId && record.event.messageId === event.messageId,
                )
            )
                throw new Error('Source request already captured');
            records[event.id] = { event: parsed, revoked: false };
        });
    }
    private tracks(messageId: string): boolean {
        return Object.values(this.records).some((record) => record.event.messageId === messageId);
    }
    async revokeMessage(messageId: string): Promise<void> {
        if (!this.tracks(messageId)) return;
        return this.change((records) => {
            for (const record of Object.values(records)) if (record.event.messageId === messageId) record.revoked = true;
        });
    }
    async edit(messageId: string, content: string): Promise<void> {
        if (
            !Object.values(this.records).some(
                (record) => record.event.messageId === messageId && record.event.text !== content.slice(0, 4000),
            )
        )
            return;
        return this.change((records) => {
            for (const record of Object.values(records))
                if (record.event.messageId === messageId) record.event.text = content.slice(0, 4000);
        });
    }
    revokeActors(ids: string[]): Promise<void> {
        return this.change((records) => {
            for (const record of Object.values(records)) if (ids.includes(record.event.actorId)) record.revoked = true;
        });
    }
    private change(action: (records: Records) => void): Promise<void> {
        const next = this.tail.then(async () => {
            const candidate = structuredClone(this.records);
            action(candidate);
            expire(candidate, Date.now());
            const body = JSON.stringify(candidate);
            if (Object.keys(candidate).length > 25000 || Buffer.byteLength(body) > 16 * 1024 * 1024)
                throw new Error('Reply origin storage full; no authorizations discarded');
            await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
            const temporary = `${this.file}.tmp`;
            await writeFile(temporary, body, { mode: 0o600, flush: true });
            await replaceFile(temporary, this.file);
            this.records = candidate;
        });
        this.tail = next.catch(() => {});
        return next;
    }
}
