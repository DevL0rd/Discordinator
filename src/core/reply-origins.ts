import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { replaceFile } from './replace-file.js';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { BotEvent } from './queue.js';
import { snowflake } from './config.js';
import { personSchema } from './directory.js';

const eventSchema = z
    .object({
        id: z.uuid(),
        cursor: z.number().int().min(1),
        receivedAt: z.iso.datetime(),
        kind: z.enum(['message', 'interaction', 'voice']),
        name: z.string().max(200).optional(),
        sourceEventId: z.uuid().optional(),
        actorId: snowflake,
        channelId: snowflake,
        guildId: snowflake.nullable(),
        messageId: snowflake.optional(),
        text: z.string().max(4000),
        author: personSchema.optional(),
        mentions: z.array(personSchema).max(20).optional(),
    })
    .strict();
const recordSchema = z.object({ event: eventSchema, revoked: z.boolean().default(false) }).strict();
const schema = z.record(z.uuid(), recordSchema);
type Records = z.infer<typeof schema>;

const maxRecords = 25000;
const maxBytes = 16 * 1024 * 1024;

function discardRevoked(records: Records): void {
    for (const [id, record] of Object.entries(records)) if (record.revoked) delete records[id];
}

function trim(records: Records): string {
    let body = JSON.stringify(records);
    while (Object.keys(records).length > maxRecords || Buffer.byteLength(body) > maxBytes) {
        const oldest = Object.entries(records)
            .sort(([, left], [, right]) => Date.parse(left.event.receivedAt) - Date.parse(right.event.receivedAt))
            .slice(0, Math.max(1, Math.ceil(Object.keys(records).length / 20)));
        for (const [id] of oldest) delete records[id];
        body = JSON.stringify(records);
    }
    return body;
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
            discardRevoked(this.records);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    findMessage(channelId: string, messageId: string): boolean {
        return Object.values(this.records).some((record) => record.event.channelId === channelId && record.event.messageId === messageId);
    }
    context(id: string): BotEvent {
        const record = this.records[id];
        if (!record) throw new Error('Reply origin unknown');
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
                event.messageId &&
                Object.values(records).some(
                    (record) => record.event.channelId === event.channelId && record.event.messageId === event.messageId,
                )
            )
                throw new Error('Source request already captured');
            records[event.id] = { event: parsed, revoked: false };
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
    private change(action: (records: Records) => void): Promise<void> {
        const next = this.tail.then(async () => {
            const candidate = structuredClone(this.records);
            action(candidate);
            const body = trim(candidate);
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
