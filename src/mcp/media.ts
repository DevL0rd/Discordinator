import type { McpServer } from '@modelcontextprotocol/server';
import type { Bridge } from '../core/bridge.js';
import { searchSchema } from '../media/index.js';
import { historySchema, readSchema } from '../media/service.js';
import { guarded } from './tools.js';

type Guarded = Awaited<ReturnType<typeof guarded>>;
type Attachment = Awaited<ReturnType<Bridge['media']['read']>>;

export function attachmentResult(response: Guarded) {
    if (response.isError) return response;
    const data = JSON.parse(response.content[0]!.text) as Attachment;
    if (!data.complete || !data.imageTypeVerified) return response;
    const { base64, ...described } = data;
    return {
        content: [
            { type: 'text' as const, text: JSON.stringify({ ...described, imageContent: true }) },
            { type: 'image' as const, data: base64, mimeType: data.mimeType },
        ],
    };
}

export function registerMedia(server: McpServer, bridge: Bridge, oauth: boolean): void {
    const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    const meta = oauth ? { securitySchemes: [{ type: 'oauth2', scopes: ['discordinator:control'] }] } : undefined;
    server.registerTool(
        'media_search',
        {
            title: 'Search Discord media',
            description:
                'Latest/specific/multiple attachments or images in the bounded observed local index. Same approved guild, or originating DM only. Filter user, channel, message, IDs and time; opaque cursor, newest first. Incomplete; no Discord-global search.',
            inputSchema: searchSchema,
            annotations: read,
            _meta: meta,
        },
        (args) => guarded(() => bridge.media.index.search(args)),
    );
    server.registerTool(
        'media_history',
        {
            title: 'Read Discord media history',
            description:
                'Scan one approved Discord channel history page or exact message for attachments. Filter user/message/time/kind. nextBefore pages messages; truncated attachment references permit exact follow-up. Use a captured request or authenticated owner context; no fresh message required.',
            inputSchema: historySchema,
            annotations: read,
            _meta: meta,
        },
        (args) => guarded(() => bridge.media.history(args)),
    );
    server.registerTool(
        'media_attachment_read',
        {
            title: 'Read Discord attachment',
            description:
                'Retrieve up to 128 KiB from a fresh source-bound attachment handle. Fixed Discord CDN only; no input URL/path. Complete small images are returned as MCP image content instead of base64 text (imageContent: true). Larger files need client chunk assembly.',
            inputSchema: readSchema,
            annotations: read,
            _meta: meta,
        },
        async (args) => attachmentResult(await guarded(() => bridge.media.read(args))),
    );
}
