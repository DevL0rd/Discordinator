import { readFileSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { replaceFile } from '../core/replace-file.js';

type Post = (eventId: string, text: string, key: string) => Promise<unknown>;
type Entry = { resetsAt?: string; announced: number };

const usageThresholds = [95, 75, 50, 25];
const resetJump = 60 * 60_000;

function load(file: string): Map<string, Entry> {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
        return new Map(Object.entries(raw).filter(([, entry]) => typeof entry?.announced === 'number'));
    } catch {
        return new Map();
    }
}

function baseline(entry: Entry, reached: number, resetsAt: string | undefined): Entry {
    const moved =
        resetsAt && entry.resetsAt ? Date.parse(resetsAt) - Date.parse(entry.resetsAt) > resetJump : !resetsAt && reached < entry.announced;
    const known = resetsAt ?? entry.resetsAt;
    return { announced: moved ? 0 : entry.announced, ...(known ? { resetsAt: known } : {}) };
}

export class UsageAnnouncer {
    private readonly entries: Map<string, Entry>;
    private saving: Promise<void> = Promise.resolve();

    constructor(
        readonly post: Post,
        readonly file = '.data/usage-announced.json',
    ) {
        this.entries = load(file);
    }

    record(label: string, percent: number, resetsAt: string | undefined, eventId: string | undefined, text: string): void {
        const entry = this.entries.get(label);
        const reached = usageThresholds.find((threshold) => percent >= threshold) ?? 0;
        const base = baseline(entry ?? { announced: 0 }, reached, resetsAt);
        const announce = Boolean(eventId) && reached > base.announced;
        const next = announce ? { ...base, announced: reached } : base;
        if (announce) void this.post(eventId!, text, `usage-${label}-${reached}-${next.resetsAt ?? 'open'}`).catch(() => undefined);
        if (entry && next.announced === entry.announced && next.resetsAt === entry.resetsAt) return;
        this.entries.set(label, next);
        this.save();
    }

    private save(): void {
        const body = JSON.stringify(Object.fromEntries(this.entries));
        this.saving = this.saving
            .then(async () => {
                await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
                const temporary = `${this.file}.${randomUUID()}.tmp`;
                try {
                    await writeFile(temporary, body, { flag: 'wx', mode: 0o600, flush: true });
                    await replaceFile(temporary, this.file);
                } finally {
                    await unlink(temporary).catch(() => undefined);
                }
            })
            .catch(() => undefined);
    }

    flush(): Promise<void> {
        return this.saving;
    }
}
