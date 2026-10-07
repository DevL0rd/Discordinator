import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Bridge } from '../core/bridge.js';
import { snowflake } from '../core/config.js';
import { Sender, type OutFile } from '../core/sender.js';
import { rich } from '../discord/operations.js';
import type { Principal } from '../events/security.js';
import { readLocalFile } from '../media/local-files.js';
import { chunkSchema, fileBucket, uploadSchema } from '../media/uploads.js';
import { localPrincipalId } from './local-key.js';
import { requireOwner } from './owner.js';
import { resolveUser, userRef } from './people.js';
import { mutation } from './mutation.js';
import { guarded } from './tools.js';

const file = z.union([
    z
        .object({ path: z.string().min(1).max(1024).describe('Absolute path of a local file in the temp folder (local clients only).') })
        .strict(),
    z.object({ uploadId: z.uuid().describe('A sealed upload from media_upload_seal.') }).strict(),
]);

const sendSchema = z
    .object({
        eventId: z
            .uuid()
            .optional()
            .describe('Reply to this request (its event_id, or a contextId) in its own conversation. Use this to answer anyone who asked.'),
        channelId: snowflake.optional().describe('Or post in this server channel or thread. Any channel Discordinator may respond in.'),
        userId: userRef.optional().describe('Or DM this approved person (ID or exact name).'),
        ...rich,
        files: z
            .array(file)
            .max(10)
            .default([])
            .describe('Up to 10 files or images: { path } for a local file (local clients), or { uploadId } from the media_upload tools.'),
        notify: userRef
            .optional()
            .describe(
                'Ping this approved person. In a reply, only the person who asked can be pinged. Roles and everyone are never pinged.',
            ),
        progress: z
            .boolean()
            .optional()
            .describe(
                'A short status update for a request ("On it, checking the logs..."). Updates replace each other in one status message, which is removed when you send the answer or about 6 seconds after the last update.',
            ),
        idempotencyKey: mutation.idempotencyKey,
    })
    .strict();

async function files(bridge: Bridge, principal: Principal | undefined, list: z.infer<typeof file>[]): Promise<OutFile[]> {
    if (!list.length) return [];
    bridge.policy.assertScope('media.write');
    if (!bridge.policy.config.media.enabled) throw new Error('Media is disabled in settings');
    const ids = list.flatMap((item) => ('uploadId' in item ? [item.uploadId] : []));
    const uploaded = ids.length ? bridge.media.uploads.ready(fileBucket, ids) : [];
    return Promise.all(
        list.map((item) => {
            if ('uploadId' in item) return Promise.resolve(uploaded[ids.indexOf(item.uploadId)]!);
            if (principal?.id !== localPrincipalId)
                throw new Error('Files by path can only be sent from this computer; use the media_upload tools');
            return readLocalFile(item.path, bridge.policy.config.media.maxFileBytes);
        }),
    );
}

export function registerSend(server: McpServer, bridge: Bridge, principal: Principal | undefined, meta: unknown): void {
    const sender = new Sender(bridge);
    const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    const _meta = meta as Record<string, unknown> | undefined;
    server.registerTool(
        'discord_send',
        {
            title: 'Send a Discord message',
            description:
                'Send text, embeds and files anywhere you are allowed: reply to a request with eventId, post in a channel with channelId, or DM an approved person with userId (exactly one). Answer requests with eventId so the reply stays in their conversation. Use progress: true for short updates while working. Text over 2000 characters is split.',
            inputSchema: sendSchema,
            annotations: write,
            _meta,
        },
        (args) =>
            guarded(async () => {
                if (!args.eventId) requireOwner(principal);
                const userId = args.userId ? await resolveUser(bridge, args.userId) : undefined;
                const notifyUserId = args.notify ? await resolveUser(bridge, args.notify) : undefined;
                return sender.send({
                    ...(args.eventId ? { eventId: args.eventId } : {}),
                    ...(args.channelId ? { channelId: args.channelId } : {}),
                    ...(userId ? { userId } : {}),
                    content: args.content,
                    ...(args.embeds ? { embeds: args.embeds } : {}),
                    files: await files(bridge, principal, args.files),
                    ...(notifyUserId ? { notifyUserId } : {}),
                    ...(args.progress ? { progress: true } : {}),
                    idempotencyKey: args.idempotencyKey,
                });
            }),
    );
    registerUploads(server, bridge, write, _meta);
}

function registerUploads(
    server: McpServer,
    bridge: Bridge,
    annotations: Record<string, boolean>,
    _meta: Record<string, unknown> | undefined,
): void {
    server.registerTool(
        'media_upload_begin',
        {
            title: 'Begin a file upload',
            description:
                'For clients that cannot pass a local path: reserve an upload, send its bytes with media_upload_chunk, check it with media_upload_seal, then pass { uploadId } in discord_send files. Safe file name and MIME; SHA-256 optional.',
            inputSchema: uploadSchema.omit({ eventId: true }),
            annotations,
            _meta,
        },
        (args) => guarded(() => Promise.resolve(bridge.media.uploads.begin({ ...args, eventId: fileBucket }))),
    );
    server.registerTool(
        'media_upload_chunk',
        {
            title: 'Upload file bytes',
            description:
                'Append the next canonical base64 chunk (at most 128 KiB) at the exact byte offset. Identical retries are accepted.',
            inputSchema: chunkSchema.omit({ eventId: true }),
            annotations,
            _meta,
        },
        (args) => guarded(() => Promise.resolve(bridge.media.uploads.chunk({ ...args, eventId: fileBucket }))),
    );
    server.registerTool(
        'media_upload_seal',
        {
            title: 'Finish a file upload',
            description:
                'Check the complete size, SHA-256 if given, format and image dimensions. A sealed upload can be sent with discord_send.',
            inputSchema: z.object({ uploadId: z.uuid() }).strict(),
            annotations,
            _meta,
        },
        (args) => guarded(() => bridge.media.uploads.seal(fileBucket, args.uploadId)),
    );
}
