import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const recordSchema = z.object({
  fingerprint: z.string(), state: z.enum(['pending', 'done']),
  createdAt: z.number(), result: z.unknown().optional(),
});
type RecordEntry = z.infer<typeof recordSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class Journal {
  private records: Record<string, RecordEntry> = Object.create(null);
  private busy = false;

  constructor(readonly file: string, readonly capacity = 4096, readonly now = Date.now) {}

  async load(): Promise<void> {
    try {
      this.records = z.record(z.string(), recordSchema).parse(JSON.parse(await readFile(this.file, 'utf8')));
      if (Object.keys(this.records).length > this.capacity) throw new Error('Journal exceeds capacity');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot load idempotency journal');
    }
  }

  private prune(): void {
    for (const [key, record] of Object.entries(this.records)) {
      if (record.state === 'done' && record.createdAt < this.now() - 24 * 60 * 60_000) delete this.records[key];
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.records), { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async execute(key: string, input: unknown, action: () => Promise<unknown>, preflight?: () => void): Promise<unknown> {
    if (this.busy) throw new Error('Another mutation is running; retry with the same key');
    this.busy = true;
    try { return await this.run(key, input, action, preflight); }
    finally { this.busy = false; }
  }

  private async run(key: string, input: unknown, action: () => Promise<unknown>, preflight?: () => void): Promise<unknown> {
    this.prune();
    const hashedKey = createHash('sha256').update(key).digest('hex');
    const fingerprint = createHash('sha256').update(canonical(input)).digest('hex');
    const previous = this.records[hashedKey];
    if (previous) return this.replay(previous, fingerprint);
    if (Object.keys(this.records).length >= this.capacity) throw new Error('Idempotency journal is full');
    preflight?.();
    this.records[hashedKey] = { fingerprint, state: 'pending', createdAt: this.now() };
    await this.save();
    const result = await action();
    this.records[hashedKey] = { fingerprint, state: 'done', createdAt: this.now(), result };
    await this.save();
    return result;
  }

  private replay(record: RecordEntry, fingerprint: string): unknown {
    if (record.fingerprint !== fingerprint) throw new Error('Idempotency key was used for different input');
    if (record.state === 'pending') throw new Error('Outcome uncertain; inspect Discord before any new operation');
    return record.result;
  }
}
