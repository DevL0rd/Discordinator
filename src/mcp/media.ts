import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Bridge } from '../core/bridge.js';
import { searchSchema } from '../media/index.js';
import { historySchema, readSchema } from '../media/service.js';
import { chunkSchema, uploadSchema } from '../media/uploads.js';
import { guarded, mutation } from './tools.js';

export function registerMedia(server: McpServer, bridge: Bridge): void {
    const read = { readOnlyHint: true, openWorldHint: true };
    server.registerTool(
        'media_search',
        {
            description:
                'Latest/specific/multiple attachments or images in the bounded observed local index. Same approved guild, or originating DM only. Filter user, channel, message, IDs and time; opaque cursor, newest first. Incomplete; no Discord-global search.',
            inputSchema: searchSchema,
            annotations: read,
        },
        (args) => guarded(() => bridge.media.index.search(args)),
    );
    server.registerTool(
        'media_history',
        {
            description:
                'Scan one approved Discord channel history page or exact message for attachments. Filter user/message/time/kind. nextBefore pages messages; truncated attachment references permit exact follow-up. Requires a live trigger.',
            inputSchema: historySchema,
            annotations: read,
        },
        (args) => guarded(() => bridge.media.history(args)),
    );
    server.registerTool(
        'media_attachment_read',
        {
            description:
                'Retrieve up to 128 KiB from a fresh source-bound attachment handle. Fixed Discord CDN only; no input URL/path. Complete small images also yield MCP image content. Larger files need client chunk assembly.',
            inputSchema: readSchema,
            annotations: read,
        },
        async (args) => {
            const response = await guarded(() => bridge.media.read(args));
            if (response.isError) return response;
            const data = JSON.parse(response.content[0]!.text) as Awaited<ReturnType<typeof bridge.media.read>>;
            if (data.complete && data.imageTypeVerified)
                return {
                    ...response,
                    content: [...response.content, { type: 'image' as const, data: data.base64, mimeType: data.mimeType }],
                };
            return response;
        },
    );
    registerUploads(server, bridge);
}

function registerUploads(server: McpServer, bridge: Bridge): void {
    const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
    server.registerTool(
        'media_upload_begin',
        {
            description:
                'Reserve a bounded in-memory upload bound to a live request. Safe filename/MIME, declared size and SHA-256. No URLs or filesystem paths.',
            inputSchema: uploadSchema,
            annotations: write,
        },
        (args) => guarded(async () => bridge.media.uploads.begin(args)),
    );
    server.registerTool(
        'media_upload_chunk',
        {
            description:
                'Append a canonical base64 chunk of at most 128 KiB at the exact offset. Identical retries accepted; changed bytes and gaps rejected.',
            inputSchema: chunkSchema,
            annotations: write,
        },
        (args) => guarded(async () => bridge.media.uploads.chunk(args)),
    );
    server.registerTool(
        'media_upload_seal',
        {
            description: 'Verify complete size, SHA-256, format/extension/MIME and image dimensions before a file can be sent.',
            inputSchema: z.object({ eventId: mutation.eventId, uploadId: z.uuid() }).strict(),
            annotations: write,
        },
        (args) => guarded(() => bridge.media.uploads.seal(args.eventId, args.uploadId)),
    );
    server.registerTool(
        'discord_media_reply',
        {
            description:
                'Reply only to the original authorized request with up to three sealed files/images/GIFs and verified source message links. Mentions suppressed; source links do not authorize writes.',
            inputSchema: z
                .object({
                    ...mutation,
                    content: z.string().max(2000).default(''),
                    uploadIds: z.array(z.uuid()).max(3).default([]),
                    sourceIds: z.array(z.uuid()).max(3).default([]),
                })
                .strict(),
            annotations: write,
        },
        (args) => guarded(() => bridge.mediaReply(args)),
    );
}
