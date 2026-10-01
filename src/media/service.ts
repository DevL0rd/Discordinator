import { z } from 'zod';
import { createHash } from 'node:crypto';
import { snowflake } from '../core/config.js';
import { MediaAccess } from './access.js';
import { AttachmentIndex, messageSchema, matches, searchSchema, type Entry } from './index.js';
import { Uploads } from './uploads.js';
import { attachmentUrl, downloader, type Downloader } from './download.js';
import { inspectFile } from './formats.js';

export const historySchema = searchSchema
    .omit({ cursor: true })
    .extend({
        before: snowflake.optional(),
        pageSize: z.number().int().min(1).max(100).default(25),
    })
    .strict();
export const readSchema = z
    .object({
        eventId: z.uuid(),
        sourceId: z.uuid(),
        offset: z.number().int().min(0).default(0),
        length: z.number().int().min(1).max(131072).default(131072),
    })
    .strict();

export class MediaService {
    readonly index: AttachmentIndex;
    readonly uploads: Uploads;
    private downloads = 0;
    constructor(
        readonly access: MediaAccess,
        readonly download: Downloader = downloader(),
    ) {
        this.index = new AttachmentIndex(access);
        this.uploads = new Uploads(access);
    }
    async history(value: z.infer<typeof historySchema>) {
        const input = historySchema.parse(value);
        const channelId = input.channelId ?? this.access.event(input.eventId).event.channelId;
        const guildId = await this.access.channel(input.eventId, channelId);
        const route = `/channels/${channelId}/messages`;
        const page = input.messageId
            ? [await this.access.api.get(`${route}/${input.messageId}`)]
            : await this.access.api.get(
                  route,
                  new URLSearchParams({ limit: String(input.pageSize), ...(input.before ? { before: input.before } : {}) }),
              );
        const messages = z.array(messageSchema).max(100).parse(page);
        if (messages.some((message) => message.channel_id !== channelId)) throw new Error('Discord history source mismatch');
        const entries = messages.flatMap((message) => this.index.records(message, guildId)).filter((entry) => matches(entry, input));
        this.access.event(input.eventId);
        return {
            attachments: entries.slice(0, input.limit).map((entry) => this.index.expose(input.eventId, entry)),
            coverage: 'discord-channel-history-page',
            incomplete: true,
            scannedMessages: messages.length,
            truncatedAttachments: entries.length > input.limit,
            remaining: entries.slice(input.limit).map((entry) => ({ messageId: entry.messageId, attachmentId: entry.attachment.id })),
            nextBefore: input.messageId ? null : (messages.at(-1)?.id ?? null),
        };
    }
    async fresh(eventId: string, sourceId: string): Promise<Entry> {
        const source = this.index.source(eventId, sourceId);
        await this.access.channel(eventId, source.channelId);
        const message = messageSchema.parse(await this.access.api.get(`/channels/${source.channelId}/messages/${source.messageId}`));
        if (message.id !== source.messageId || message.channel_id !== source.channelId || message.author.id !== source.userId)
            throw new Error('Attachment source identity changed');
        const attachment = message.attachments.find((item) => item.id === source.attachment.id);
        if (!attachment || attachment.size !== source.attachment.size || attachment.filename !== source.attachment.filename)
            throw new Error('Attachment was removed or changed');
        this.access.event(eventId);
        return { ...source, attachment };
    }
    async read(value: z.infer<typeof readSchema>) {
        const input = readSchema.parse(value);
        if (this.downloads >= 3) throw new Error('Too many attachment downloads');
        this.downloads++;
        try {
            return await this.downloadRead(input);
        } finally {
            this.downloads--;
        }
    }
    private async downloadRead(input: z.infer<typeof readSchema>) {
        const source = await this.fresh(input.eventId, input.sourceId);
        const attachment = source.attachment;
        if (attachment.size > this.access.policy.config.media.maxFileBytes) throw new Error('Attachment exceeds local file limit');
        const url = attachmentUrl(attachment.url, source.channelId, attachment.id);
        const bytes = await this.download(url, attachment.size);
        if (bytes.length !== attachment.size) throw new Error('Attachment byte count mismatch');
        const mimeType = await inspectFile(bytes, attachment.filename, attachment.content_type);
        this.access.event(input.eventId);
        if (input.offset >= bytes.length) throw new Error('Offset is outside attachment');
        const chunk = bytes.subarray(input.offset, input.offset + input.length);
        return {
            sourceId: input.sourceId,
            fileName: attachment.filename,
            mimeType,
            size: bytes.length,
            offset: input.offset,
            nextOffset: input.offset + chunk.length < bytes.length ? input.offset + chunk.length : null,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            base64: chunk.toString('base64'),
            complete: chunk.length === bytes.length,
            imageTypeVerified: mimeType.startsWith('image/'),
        };
    }
}
