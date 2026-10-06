import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { eventNames, filtersSchema, secretSchema } from './schema.js';
import { sanitizedError } from '../core/errors.js';

const subscriptionSchema = z
    .object({
        id: z.string(),
        owner: z.string(),
        ownerExpires: z.number().optional(),
        url: z.url().max(2048),
        name: eventNames,
        arguments: filtersSchema,
        secret: secretSchema,
        previous: z.object({ secret: secretSchema, until: z.number() }).optional(),
        expires: z.number(),
        verifiedAt: z.number(),
        suspended: z.boolean().default(false),
    })
    .strict();
const jobSchema = z
    .object({
        subscriptionId: z.string(),
        eventId: z.string(),
        body: z.string().max(262144),
        attempts: z.number().int().min(0).max(6),
        nextAt: z.number(),
        expires: z.number(),
    })
    .strict();
const stateSchema = z
    .object({
        version: z.literal(1),
        subscriptions: z.array(subscriptionSchema).max(100),
        jobs: z.array(jobSchema).max(500),
        dropped: z.number().int().min(0),
    })
    .strict();
export type Subscription = z.infer<typeof subscriptionSchema>;
export type Job = z.infer<typeof jobSchema>;
export type State = z.infer<typeof stateSchema>;

/** One runtime owns the store; mutations are serialized and atomically replaced. */
export class SubscriptionStore {
    state: State = { version: 1, subscriptions: [], jobs: [], dropped: 0 };
    private tail = Promise.resolve();
    private pending = 0;
    constructor(readonly file: string) {}
    async load(): Promise<void> {
        try {
            if ((await stat(this.file)).size > 8 * 1024 * 1024) throw new Error('Subscription store exceeds bounds');
            this.state = stateSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw sanitizedError('Subscription store invalid; do not discard unreconciled state');
        }
    }
    onChange?: (state: State) => void;
    change<T>(action: (state: State) => T): Promise<T> {
        if (this.pending >= 64) return Promise.reject(new Error('Subscription state busy'));
        this.pending++;
        const next = this.tail.then(async () => {
            const candidate = structuredClone(this.state);
            const result = action(candidate);
            await this.save(candidate);
            this.state = candidate;
            this.onChange?.(candidate);
            return result;
        });
        this.tail = next.then(
            () => {
                this.pending--;
            },
            () => {
                this.pending--;
            },
        );
        return next;
    }
    private async save(state: State): Promise<void> {
        const body = JSON.stringify(state);
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Subscription storage byte limit exhausted');
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.tmp`;
        await writeFile(temporary, body, { mode: 0o600, flush: true });
        await rename(temporary, this.file);
    }
}
