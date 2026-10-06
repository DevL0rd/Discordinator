import { z } from 'zod';
import { snowflake } from '../core/config.js';
import { define, guild, channel, shortName, text, origin, query, write, sensitive } from './operations.js';

const archive = z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]).default(1440);
const overwrite = {
    ...channel,
    overwriteId: snowflake,
    type: z.union([z.literal(0), z.literal(1)]),
    allow: z.string().regex(/^\d{1,25}$/),
    deny: z.string().regex(/^\d{1,25}$/),
};

export const channelOperations = [
    define('channels_list', 'List approved channels in a guild.', { scope: 'guild.read', target: 'guild' }, guild, async (a, c) => {
        const channels = (await c.api.get(`/guilds/${a.guildId}/channels`)) as { id: string }[];
        return channels.filter((item) => c.policy.channelAllowed(item.id));
    }),
    define('channel_get', 'Read channel metadata.', { scope: 'guild.read', target: 'channel' }, channel, (a, c) =>
        c.api.get(`/channels/${a.channelId}`),
    ),
    define(
        'channel_create',
        'Create a text, voice, category, announcement, stage or forum channel, with confirmation.',
        { scope: 'channels.write', target: 'guild' },
        {
            ...guild,
            name: shortName,
            type: z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(5), z.literal(13), z.literal(15)]),
            parentId: snowflake.optional(),
            topic: z.string().max(1024).optional(),
        },
        async (a, c) => {
            if (a.parentId) {
                const parent = await c.api.channel(a.parentId);
                if (parent.guild_id !== a.guildId) throw new Error('Parent category is in another guild');
            }
            return c.api.post(`/guilds/${a.guildId}/channels`, { name: a.name, type: a.type, parent_id: a.parentId, topic: a.topic });
        },
        sensitive,
    ),
    define(
        'channel_edit',
        'Change channel name, topic, slowmode or NSFW flag, with confirmation.',
        { scope: 'channels.write', target: 'channel' },
        {
            ...channel,
            name: shortName.optional(),
            topic: z.string().max(1024).optional(),
            slowmodeSeconds: z.number().int().min(0).max(21600).optional(),
            nsfw: z.boolean().optional(),
        },
        (a, c) =>
            c.api.patch(`/channels/${a.channelId}`, { name: a.name, topic: a.topic, rate_limit_per_user: a.slowmodeSeconds, nsfw: a.nsfw }),
        sensitive,
    ),
    define(
        'channel_delete',
        'Delete a channel or thread, with confirmation.',
        { scope: 'channels.write', target: 'channel' },
        channel,
        (a, c) => c.api.delete(`/channels/${a.channelId}`),
        sensitive,
    ),
    define(
        'channel_overwrite_set',
        'Set a typed member/role permission overwrite, with confirmation.',
        { scope: 'channels.write', target: 'channel' },
        overwrite,
        (a, c) => c.api.put(`/channels/${a.channelId}/permissions/${a.overwriteId}`, { type: a.type, allow: a.allow, deny: a.deny }),
        sensitive,
    ),
    define(
        'channel_overwrite_delete',
        'Delete a permission overwrite, with confirmation.',
        { scope: 'channels.write', target: 'channel' },
        { ...channel, overwriteId: snowflake },
        (a, c) => c.api.delete(`/channels/${a.channelId}/permissions/${a.overwriteId}`),
        sensitive,
    ),
    define('threads_active', 'List approved active guild threads.', { scope: 'guild.read', target: 'guild' }, guild, async (a, c) => {
        const result = (await c.api.get(`/guilds/${a.guildId}/threads/active`)) as { threads: { id: string }[] };
        return result.threads.filter((item) => c.policy.channelAllowed(item.id));
    }),
    define(
        'threads_archived',
        'Read a bounded page of public archived threads.',
        { scope: 'guild.read', target: 'channel' },
        { ...channel, limit: z.number().int().min(1).max(100).default(25), before: z.iso.datetime().optional() },
        async (a, c) => {
            const result = (await c.api.get(
                `/channels/${a.channelId}/threads/archived/public`,
                query({ limit: a.limit, before: a.before }),
            )) as { threads: { id: string }[]; has_more: boolean };
            return {
                threads: result.threads.filter((item) => c.policy.channelAllowed(item.id)),
                has_more: result.has_more,
            };
        },
    ),
    define(
        'thread_create',
        'Start a public thread from the captured triggering message.',
        { scope: 'threads.write', target: 'channel' },
        { ...channel, name: shortName, autoArchiveMinutes: archive },
        (a, c) => {
            const event = origin(c).event;
            c.policy.assertResponse(event, a.channelId);
            if (!event.messageId) throw new Error('A triggering message is required');
            return c.api.post(`/channels/${a.channelId}/messages/${event.messageId}/threads`, {
                name: a.name,
                auto_archive_duration: a.autoArchiveMinutes,
            });
        },
        write,
    ),
    define(
        'forum_post_create',
        'Create a forum post in the originating forum channel.',
        { scope: 'threads.write', target: 'channel' },
        { ...channel, name: shortName, content: text, autoArchiveMinutes: archive },
        async (a, c) => {
            c.policy.assertResponse(origin(c).event, a.channelId);
            return c.api.post(`/channels/${a.channelId}/threads`, {
                name: a.name,
                auto_archive_duration: a.autoArchiveMinutes,
                message: { content: a.content, allowed_mentions: { parse: [], replied_user: false } },
            });
        },
        write,
    ),
    define(
        'thread_edit',
        'Archive, reopen, lock or rename a thread, with confirmation.',
        { scope: 'threads.write', target: 'channel' },
        { ...channel, archived: z.boolean().optional(), locked: z.boolean().optional(), name: shortName.optional() },
        (a, c) => c.api.patch(`/channels/${a.channelId}`, { archived: a.archived, locked: a.locked, name: a.name }),
        sensitive,
    ),
    define(
        'thread_join',
        'Join an approved thread as the bot.',
        { scope: 'threads.write', target: 'channel' },
        channel,
        (a, c) => c.api.put(`/channels/${a.channelId}/thread-members/@me`),
        write,
    ),
    define(
        'thread_leave',
        'Leave an approved thread as the bot.',
        { scope: 'threads.write', target: 'channel' },
        channel,
        (a, c) => c.api.delete(`/channels/${a.channelId}/thread-members/@me`),
        write,
    ),
    define(
        'thread_member_add',
        'Add a whitelisted user to a thread, with confirmation.',
        { scope: 'threads.write', target: 'channel' },
        { ...channel, userId: snowflake },
        (a, c) => {
            c.policy.assertUser(a.userId);
            return c.api.put(`/channels/${a.channelId}/thread-members/${a.userId}`);
        },
        sensitive,
    ),
    define(
        'thread_member_remove',
        'Remove a thread member, with confirmation.',
        { scope: 'threads.write', target: 'channel' },
        { ...channel, userId: snowflake },
        (a, c) => c.api.delete(`/channels/${a.channelId}/thread-members/${a.userId}`),
        sensitive,
    ),
];
