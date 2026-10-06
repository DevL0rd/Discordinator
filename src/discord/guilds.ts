import { z } from 'zod';
import { define, guild, channel, pagination, query, sensitive } from './operations.js';

export const guildOperations = [
    define('guild_get', 'Read guild metadata and approximate counts.', { scope: 'guild.read', target: 'guild' }, guild, (a, c) =>
        c.api.get(`/guilds/${a.guildId}`, query({ with_counts: true })),
    ),
    define(
        'guild_edit',
        'Change guild name, description or verification level, with confirmation.',
        { scope: 'guild.write', target: 'guild' },
        {
            ...guild,
            name: z.string().min(2).max(100).optional(),
            description: z.string().max(120).nullable().optional(),
            verificationLevel: z.number().int().min(0).max(4).optional(),
        },
        (a, c) =>
            c.api.patch(`/guilds/${a.guildId}`, { name: a.name, description: a.description, verification_level: a.verificationLevel }),
        sensitive,
    ),
    define(
        'audit_log',
        'Read a bounded page of guild audit entries.',
        { scope: 'audit.read', target: 'guild' },
        { ...guild, ...pagination, actionType: z.number().int().min(1).max(200).optional() },
        (a, c) => c.api.get(`/guilds/${a.guildId}/audit-logs`, query({ limit: a.limit, before: a.before, action_type: a.actionType })),
    ),
    define(
        'invites_list',
        'Read invites for the approved channel. Invite codes are access-bearing data.',
        { scope: 'invites.read', target: 'channel' },
        channel,
        (a, c) => c.api.get(`/channels/${a.channelId}/invites`),
    ),
    define(
        'invite_create',
        'Create a bounded channel invite, with confirmation. This is not a bot installation invite.',
        { scope: 'invites.write', target: 'channel' },
        {
            ...channel,
            maxAgeSeconds: z.number().int().min(60).max(604800).default(3600),
            maxUses: z.number().int().min(1).max(100).default(1),
            temporary: z.boolean().default(false),
        },
        (a, c) =>
            c.api.post(`/channels/${a.channelId}/invites`, {
                max_age: a.maxAgeSeconds,
                max_uses: a.maxUses,
                temporary: a.temporary,
                unique: true,
            }),
        sensitive,
    ),
    define(
        'invite_delete',
        'Revoke an invite belonging to the specified approved channel, with confirmation.',
        { scope: 'invites.write', target: 'channel' },
        { ...channel, code: z.string().regex(/^[A-Za-z0-9_-]{2,100}$/) },
        async (a, c) => {
            const invites = (await c.api.get(`/channels/${a.channelId}/invites`)) as { code: string }[];
            if (!invites.some((invite) => invite.code === a.code)) throw new Error('Invite does not belong to the approved channel');
            return c.api.delete(`/invites/${a.code}`);
        },
        sensitive,
    ),
    define(
        'command_register',
        'Register /dot with a text option in this guild, with confirmation. No global replacement.',
        { scope: 'commands.write', target: 'guild' },
        guild,
        (a, c) =>
            c.api.post(`/applications/${c.api.botId}/guilds/${a.guildId}/commands`, {
                name: 'discordinator',
                description: 'Ask Discordinator through its connected MCP client',
                type: 1,
                options: [{ name: 'text', description: 'Your request or approval', type: 3, required: true, max_length: 2000 }],
                default_member_permissions: '0',
            }),
        sensitive,
    ),
    define('commands_list', 'Read this bot’s guild application commands.', { scope: 'guild.read', target: 'guild' }, guild, (a, c) =>
        c.api.get(`/applications/${c.api.botId}/guilds/${a.guildId}/commands`),
    ),
    define(
        'command_delete',
        'Delete one of this bot’s guild commands, with confirmation.',
        { scope: 'commands.write', target: 'guild' },
        { ...guild, commandId: channel.channelId },
        (a, c) => c.api.delete(`/applications/${c.api.botId}/guilds/${a.guildId}/commands/${a.commandId}`),
        sensitive,
    ),
    define('emojis_list', 'Read guild emoji metadata.', { scope: 'expressions.read', target: 'guild' }, guild, (a, c) =>
        c.api.get(`/guilds/${a.guildId}/emojis`),
    ),
    define(
        'emoji_create',
        'Create an emoji from bounded image data, with confirmation; no URL fetching.',
        { scope: 'expressions.write', target: 'guild' },
        {
            ...guild,
            name: z.string().regex(/^[A-Za-z0-9_]{2,32}$/),
            image: z
                .string()
                .max(350_000)
                .regex(/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+={0,2}$/),
        },
        (a, c) => c.api.post(`/guilds/${a.guildId}/emojis`, { name: a.name, image: a.image }),
        sensitive,
    ),
    define(
        'emoji_rename',
        'Rename a guild emoji, with confirmation.',
        { scope: 'expressions.write', target: 'guild' },
        { ...guild, emojiId: channel.channelId, name: z.string().regex(/^[A-Za-z0-9_]{2,32}$/) },
        (a, c) => c.api.patch(`/guilds/${a.guildId}/emojis/${a.emojiId}`, { name: a.name }),
        sensitive,
    ),
    define(
        'emoji_delete',
        'Delete a guild emoji, with confirmation.',
        { scope: 'expressions.write', target: 'guild' },
        { ...guild, emojiId: channel.channelId },
        (a, c) => c.api.delete(`/guilds/${a.guildId}/emojis/${a.emojiId}`),
        sensitive,
    ),
    define(
        'stickers_list',
        'Read guild sticker metadata; uploads are not implemented.',
        { scope: 'expressions.read', target: 'guild' },
        guild,
        (a, c) => c.api.get(`/guilds/${a.guildId}/stickers`),
    ),
    define(
        'sticker_edit',
        'Change a guild sticker’s name, description or tags, with confirmation.',
        { scope: 'expressions.write', target: 'guild' },
        {
            ...guild,
            stickerId: channel.channelId,
            name: z.string().min(2).max(30),
            description: z.string().min(2).max(100).nullable(),
            tags: z.string().min(1).max(200),
        },
        (a, c) =>
            c.api.patch(`/guilds/${a.guildId}/stickers/${a.stickerId}`, {
                name: a.name,
                description: a.description,
                tags: a.tags,
            }),
        sensitive,
    ),
    define(
        'sticker_delete',
        'Delete a guild sticker, with confirmation.',
        { scope: 'expressions.write', target: 'guild' },
        { ...guild, stickerId: channel.channelId },
        (a, c) => c.api.delete(`/guilds/${a.guildId}/stickers/${a.stickerId}`),
        sensitive,
    ),
];
