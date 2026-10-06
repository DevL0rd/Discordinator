import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Bridge } from '../core/bridge.js';
import type { Principal } from '../events/security.js';
import { snowflake } from '../core/config.js';
import { chunkSchema, uploadSchema } from '../media/uploads.js';
import { guarded, mutation } from './tools.js';

export function requireOwner(principal?: Principal): void {
    if (!principal) throw new Error('Authenticated owner required for proactive messages/media');
}
export function registerProactiveMedia(server: McpServer, bridge: Bridge, principal: Principal | undefined, oauth: boolean): void {
    const annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    const meta = oauth ? { securitySchemes: [{ type: 'oauth2', scopes: ['discordinator:control'] }] } : undefined;
    const owner = <T>(action: () => Promise<T> | T) =>
        guarded(async () => {
            requireOwner(principal);
            return action();
        });
    server.registerTool(
        'media_proactive_upload_begin',
        {
            title: 'Begin approved-channel media upload',
            description:
                'Authenticated owner only. Stage bounded safe media for an approved anytime destination; no trigger required. Returns scopeId, not a triggering event. Buffer expiry only frees upload memory; completion permission does not expire.',
            inputSchema: uploadSchema.omit({ eventId: true }).extend({ channelId: snowflake }),
            annotations,
            _meta: meta,
        },
        (args) => owner(() => bridge.proactiveUploads.begin(args)),
    );
    server.registerTool(
        'media_proactive_upload_chunk',
        {
            title: 'Upload approved-channel media chunk',
            description: 'Authenticated owner only; scope-bound canonical base64 chunks. Destination cannot change.',
            inputSchema: chunkSchema.omit({ eventId: true }).extend({ scopeId: z.uuid() }),
            annotations,
            _meta: meta,
        },
        (args) =>
            owner(() => {
                const { scopeId, ...chunk } = args;
                return bridge.proactiveUploads.uploads.chunk({ ...chunk, eventId: scopeId });
            }),
    );
    registerSeal(server, bridge, principal, oauth);
    server.registerTool(
        'discord_proactive_media_send',
        {
            title: 'Send media to approved anytime channel',
            description:
                'Authenticated owner only. Send up to three sealed safe files to their approved destination. No recent trigger; whitelist-only optional notification. No arbitrary files, paths, URLs, roles or everyone mentions.',
            inputSchema: z
                .object({
                    channelId: snowflake,
                    scopeId: z.uuid(),
                    uploadIds: z.array(z.uuid()).min(1).max(3),
                    content: z.string().max(2000).default(''),
                    idempotencyKey: mutation.idempotencyKey,
                    notifyUserId: snowflake.optional(),
                })
                .strict(),
            annotations,
            _meta: meta,
        },
        (args) => owner(() => bridge.proactiveMedia(args)),
    );
}
function registerSeal(server: McpServer, bridge: Bridge, principal: Principal | undefined, oauth: boolean): void {
    server.registerTool(
        'media_proactive_upload_seal',
        {
            title: 'Seal approved-channel media',
            description: 'Authenticated owner only. Verify declared bytes, SHA-256, MIME/extension and dimensions before sending.',
            inputSchema: z.object({ scopeId: z.uuid(), uploadId: z.uuid() }).strict(),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
            _meta: oauth ? { securitySchemes: [{ type: 'oauth2', scopes: ['discordinator:control'] }] } : undefined,
        },
        (args) =>
            guarded(async () => {
                requireOwner(principal);
                return bridge.proactiveUploads.uploads.seal(args.scopeId, args.uploadId);
            }),
    );
}
