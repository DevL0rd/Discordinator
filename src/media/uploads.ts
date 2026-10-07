import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fileName, mimeType, inspectFile } from './formats.js';
import type { Policy } from '../core/policy.js';

export interface UploadAccess {
    readonly policy: Policy;
    event(id: string, write: boolean): { expiresAt: number };
}

/** All uploads share one owner bucket; where a file goes is decided when it is sent. */
export const fileBucket = '00000000-0000-4000-8000-000000000001';

export function fileAccess(policy: Policy): UploadAccess {
    return {
        policy,
        event: () => {
            policy.assertScope('media.write');
            if (!policy.config.media.enabled) throw new Error('Media is disabled in settings');
            return { expiresAt: Number.POSITIVE_INFINITY };
        },
    };
}

export const uploadSchema = z
    .object({
        eventId: z.uuid(),
        fileName,
        mimeType,
        size: z
            .number()
            .int()
            .positive()
            .max(8 * 1024 * 1024),
        sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional()
            .describe('Optional. When given, the sealed bytes must match it.'),
        idempotencyKey: z.string().min(8).max(128),
    })
    .strict();
export const chunkSchema = z
    .object({ eventId: z.uuid(), uploadId: z.uuid(), offset: z.number().int().min(0), base64: z.string().min(4).max(174764) })
    .strict();
type UploadInput = z.infer<typeof uploadSchema>;
interface Upload {
    input: UploadInput;
    id: string;
    expires: number;
    bytes: Buffer;
    length: number;
    sha256?: string;
}

export class Uploads {
    private items = new Map<string, Upload>();
    constructor(
        readonly access: UploadAccess,
        readonly now = Date.now,
    ) {}
    private prune(): void {
        for (const [id, item] of this.items) if (item.expires <= this.now()) this.items.delete(id);
    }
    begin(value: UploadInput) {
        const input = uploadSchema.parse(value);
        const event = this.access.event(input.eventId, true);
        this.prune();
        const previous = [...this.items.values()].find((item) => item.input.idempotencyKey === input.idempotencyKey);
        if (previous) {
            if (JSON.stringify(previous.input) !== JSON.stringify(input)) throw new Error('Upload key reused with different input');
            return this.describe(previous);
        }
        const reserved = [...this.items.values()].reduce((sum, item) => sum + item.input.size, 0);
        if (
            input.size > this.access.policy.config.media.maxFileBytes ||
            reserved + input.size > 16 * 1024 * 1024 ||
            this.items.size >= 16
        ) {
            throw new Error('Upload memory or file limit reached');
        }
        const item: Upload = {
            input,
            id: randomUUID(),
            expires: Math.min(event.expiresAt, this.now() + 10 * 60_000),
            bytes: Buffer.alloc(input.size),
            length: 0,
        };
        this.items.set(item.id, item);
        return this.describe(item);
    }
    private describe(item: Upload) {
        return {
            uploadId: item.id,
            offset: item.length,
            sealed: item.sha256 !== undefined,
            expiresAt: new Date(item.expires).toISOString(),
        };
    }
    get(eventId: string, id: string): Upload {
        this.access.event(eventId, true);
        this.prune();
        const item = this.items.get(id);
        if (!item || item.input.eventId !== eventId) throw new Error('Upload is expired or bound to another event');
        return item;
    }
    chunk(value: z.infer<typeof chunkSchema>) {
        const input = chunkSchema.parse(value);
        const item = this.get(input.eventId, input.uploadId);
        const bytes = Buffer.from(input.base64, 'base64');
        if (bytes.length > 131072 || bytes.toString('base64') !== input.base64) throw new Error('Invalid or oversized base64 chunk');
        if (input.offset < item.length) {
            if (input.offset + bytes.length > item.length || !item.bytes.subarray(input.offset, input.offset + bytes.length).equals(bytes))
                throw new Error('Changed retry chunk');
            return this.describe(item);
        }
        if (item.sha256 !== undefined || input.offset !== item.length || item.length + bytes.length > item.input.size)
            throw new Error('Chunks must be contiguous and within declared size');
        bytes.copy(item.bytes, item.length);
        item.length += bytes.length;
        return this.describe(item);
    }
    async seal(eventId: string, id: string) {
        const item = this.get(eventId, id);
        if (item.length !== item.input.size) throw new Error('Incomplete upload');
        const sha256 = createHash('sha256').update(item.bytes).digest('hex');
        if (item.input.sha256 !== undefined && sha256 !== item.input.sha256) throw new Error('Upload hash mismatch');
        await inspectFile(item.bytes, item.input.fileName, item.input.mimeType);
        this.get(eventId, id);
        item.sha256 = sha256;
        return { ...this.describe(item), sha256 };
    }
    ready(eventId: string, ids: string[]) {
        return ids.map((id) => {
            const item = this.get(eventId, id);
            if (item.sha256 === undefined) throw new Error('Upload must be sealed first');
            return {
                data: Buffer.from(item.bytes),
                name: item.input.fileName,
                contentType: item.input.mimeType,
                sha256: item.sha256,
            };
        });
    }
}
