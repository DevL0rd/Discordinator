import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { snowflake } from '../core/config.js';
import { personSchema, type Person } from '../core/directory.js';
import { replaceFile } from '../core/replace-file.js';

const lineSchema = z
    .object({ at: z.iso.datetime(), userId: snowflake, speaker: personSchema, text: z.string().max(4000), bot: z.boolean() })
    .strict();
const callSchema = z
    .object({
        id: z.string().regex(/^\d{13}-[0-9a-f-]{36}$/),
        guildId: snowflake,
        channelId: snowflake,
        channelName: z.string().max(100).nullable(),
        startedAt: z.iso.datetime(),
        endedAt: z.iso.datetime().nullable(),
        participants: z.array(personSchema).max(500),
        lines: z.array(lineSchema).max(20_000),
    })
    .strict();
export type TranscriptLine = z.infer<typeof lineSchema>;
export type CallRecord = z.infer<typeof callSchema>;

const maxLines = 20_000;
const maxListed = 200;

export class TranscriptStore {
    private readonly calls = new Map<string, CallRecord>();
    private readonly saving = new Map<string, Promise<void>>();
    private readonly dirty = new Set<string>();

    constructor(
        readonly directory = join('.data', 'voice'),
        readonly now = Date.now,
    ) {}

    start(guildId: string, channelId: string, channelName: string | null): CallRecord {
        const startedAt = this.now();
        const call: CallRecord = {
            id: `${startedAt}-${randomUUID()}`,
            guildId,
            channelId,
            channelName: channelName?.slice(0, 100) ?? null,
            startedAt: new Date(startedAt).toISOString(),
            endedAt: null,
            participants: [],
            lines: [],
        };
        this.calls.set(call.id, call);
        this.schedule(call.id);
        return call;
    }

    live(id: string): CallRecord | undefined {
        return this.calls.get(id);
    }

    present(id: string, who: Person): void {
        const call = this.calls.get(id);
        if (!call) return;
        const index = call.participants.findIndex((item) => item.id === who.id);
        if (index >= 0) call.participants[index] = who;
        else if (call.participants.length < 500) call.participants.push(who);
        this.schedule(id);
    }

    add(id: string, line: TranscriptLine): void {
        const call = this.calls.get(id);
        if (!call || !line.text.trim()) return;
        const entry = { ...line, text: line.text.trim().slice(0, 4000) };
        let index = call.lines.length;
        while (index > 0 && call.lines[index - 1]!.at > entry.at) index--;
        call.lines.splice(index, 0, entry);
        if (call.lines.length > maxLines) call.lines.splice(0, call.lines.length - maxLines);
        this.present(id, line.speaker);
    }

    async end(id: string): Promise<void> {
        const call = this.calls.get(id);
        if (!call) return;
        call.endedAt = new Date(this.now()).toISOString();
        this.schedule(id);
        await this.flush(id);
        this.calls.delete(id);
    }

    private schedule(id: string): void {
        this.dirty.add(id);
        if (this.saving.has(id)) return;
        const run = Promise.resolve()
            .then(() => this.write(id))
            .catch(() => console.error('Voice transcript could not be saved'))
            .finally(() => {
                this.saving.delete(id);
                if (this.dirty.has(id) && this.calls.has(id)) this.schedule(id);
            });
        this.saving.set(id, run);
    }

    private async write(id: string): Promise<void> {
        const call = this.calls.get(id);
        this.dirty.delete(id);
        if (!call) return;
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = join(this.directory, `${id}.json`);
        await writeFile(`${path}.tmp`, JSON.stringify(call), { mode: 0o600 });
        await replaceFile(`${path}.tmp`, path);
    }

    async flush(id?: string): Promise<void> {
        const ids = id ? [id] : [...this.calls.keys()];
        for (const key of ids) {
            while (this.saving.has(key)) await this.saving.get(key);
            if (this.dirty.has(key)) await this.write(key);
        }
    }

    async read(id: string): Promise<CallRecord | undefined> {
        if (!callSchema.shape.id.safeParse(id).success) return undefined;
        const live = this.calls.get(id);
        if (live) return live;
        const raw = await readFile(join(this.directory, `${id}.json`), 'utf8').catch(() => undefined);
        const parsed = raw === undefined ? undefined : callSchema.safeParse(JSON.parse(raw));
        return parsed?.success ? parsed.data : undefined;
    }

    async list(): Promise<CallRecord[]> {
        const names = (await readdir(this.directory).catch(() => [] as string[]))
            .filter((name) => name.endsWith('.json'))
            .sort()
            .reverse()
            .slice(0, maxListed);
        const calls = await Promise.all(names.map((name) => this.read(name.slice(0, -5))));
        return calls.filter((call): call is CallRecord => Boolean(call));
    }

    async prune(retentionDays: number): Promise<number> {
        const cutoff = this.now() - retentionDays * 86_400_000;
        let removed = 0;
        for (const name of await readdir(this.directory).catch(() => [] as string[])) {
            const started = Number(/^(\d{13})-/.exec(name)?.[1]);
            if (!started || started >= cutoff || this.calls.has(name.replace(/\.json(\.tmp)?$/, ''))) continue;
            await rm(join(this.directory, name), { force: true });
            removed++;
        }
        return removed;
    }

    async remove(id: string): Promise<boolean> {
        if (!callSchema.shape.id.safeParse(id).success || this.calls.has(id)) return false;
        const path = join(this.directory, `${id}.json`);
        const existed = await readFile(path).then(
            () => true,
            () => false,
        );
        await rm(path, { force: true });
        return existed;
    }
}
