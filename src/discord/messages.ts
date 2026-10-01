import { z } from 'zod';
import { define, channel, message, pagination, text, mentions, origin, query, write, sensitive } from './operations.js';

export const emoji = z
    .string()
    .min(1)
    .max(100)
    .refine(
        (value) =>
            /^[a-zA-Z0-9_]{2,32}:\d{17,20}$/.test(value) ||
            /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200D|\uFE0F|\u20E3)*$/u.test(
                value,
            ),
    );
const poll = z
    .object({
        question: z.string().min(1).max(300),
        answers: z.array(z.string().min(1).max(55)).min(2).max(10),
        durationHours: z.number().int().min(1).max(768).default(24),
        multiselect: z.boolean().default(false),
    })
    .strict();

export const messageOperations = [
    define(
        'messages_list',
        'Read a bounded page of channel history.',
        { scope: 'messages.read', target: 'channel' },
        { ...channel, ...pagination },
        (a, c) => c.api.get(`/channels/${a.channelId}/messages`, query({ limit: a.limit, before: a.before })),
    ),
    define('message_get', 'Read one message.', { scope: 'messages.read', target: 'channel' }, message, (a, c) =>
        c.api.get(`/channels/${a.channelId}/messages/${a.messageId}`),
    ),
    define(
        'pins_list',
        'Read a bounded page of pinned messages.',
        { scope: 'messages.read', target: 'channel' },
        { ...channel, limit: z.number().int().min(1).max(50).default(25), before: z.iso.datetime().optional() },
        (a, c) => c.api.get(`/channels/${a.channelId}/messages/pins`, query({ limit: a.limit, before: a.before })),
    ),
    define(
        'message_edit',
        'Edit a message authored by this bot. Mentions stay disabled.',
        { scope: 'messages.write', target: 'channel' },
        { ...message, content: text },
        async (a, c) => {
            const existing = await c.api.message(a.channelId, a.messageId);
            if ((existing.author as { id: string }).id !== c.api.botId) throw new Error('Only bot-authored messages can be edited');
            return c.api.patch(`/channels/${a.channelId}/messages/${a.messageId}`, { content: a.content, allowed_mentions: mentions });
        },
        write,
    ),
    define(
        'message_delete',
        'Delete one message after explicit Discord confirmation.',
        { scope: 'moderation.write', target: 'channel' },
        message,
        (a, c) => c.api.delete(`/channels/${a.channelId}/messages/${a.messageId}`),
        sensitive,
    ),
    define(
        'messages_bulk_delete',
        'Delete 2–100 messages newer than 14 days, with confirmation.',
        { scope: 'moderation.write', target: 'channel' },
        { ...channel, messageIds: z.array(message.messageId).min(2).max(100) },
        (a, c) => c.api.post(`/channels/${a.channelId}/messages/bulk-delete`, { messages: a.messageIds }),
        sensitive,
    ),
    define(
        'message_pin',
        'Pin a whitelisted user or bot message.',
        { scope: 'messages.write', target: 'channel' },
        message,
        async (a, c) => {
            await c.api.message(a.channelId, a.messageId);
            return c.api.put(`/channels/${a.channelId}/messages/pins/${a.messageId}`);
        },
        write,
    ),
    define(
        'message_unpin',
        'Unpin a message with confirmation.',
        { scope: 'messages.write', target: 'channel' },
        message,
        (a, c) => c.api.delete(`/channels/${a.channelId}/messages/pins/${a.messageId}`),
        sensitive,
    ),
    define(
        'reaction_add',
        'Add a reaction to a whitelisted user or bot message.',
        { scope: 'reactions.write', target: 'channel' },
        { ...message, emoji },
        async (a, c) => {
            await c.api.message(a.channelId, a.messageId);
            return c.api.put(`/channels/${a.channelId}/messages/${a.messageId}/reactions/${encodeURIComponent(a.emoji)}/@me`);
        },
        write,
    ),
    define(
        'reaction_remove_own',
        'Remove only the bot’s own reaction.',
        { scope: 'reactions.write', target: 'channel' },
        { ...message, emoji },
        (a, c) => c.api.delete(`/channels/${a.channelId}/messages/${a.messageId}/reactions/${encodeURIComponent(a.emoji)}/@me`),
        write,
    ),
    define(
        'reaction_users',
        'Read a bounded page of users for one Unicode or name:id custom emoji reaction.',
        { scope: 'messages.read', target: 'channel' },
        { ...message, emoji, ...pagination },
        (a, c) =>
            c.api.get(
                `/channels/${a.channelId}/messages/${a.messageId}/reactions/${encodeURIComponent(a.emoji)}`,
                query({ limit: a.limit, after: a.before }),
            ),
    ),
    define(
        'poll_create',
        'Create a poll in the originating channel.',
        { scope: 'messages.write', target: 'channel' },
        { ...channel, poll },
        (a, c) => {
            c.policy.assertResponse(origin(c).event, a.channelId);
            return c.api.post(`/channels/${a.channelId}/messages`, {
                allowed_mentions: mentions,
                poll: {
                    question: { text: a.poll.question },
                    answers: a.poll.answers.map((text) => ({ poll_media: { text } })),
                    duration: a.poll.durationHours,
                    allow_multiselect: a.poll.multiselect,
                    layout_type: 1,
                },
            });
        },
        write,
    ),
    define(
        'poll_end',
        'End a bot-authored poll with confirmation.',
        { scope: 'messages.write', target: 'channel' },
        message,
        async (a, c) => {
            const existing = await c.api.message(a.channelId, a.messageId);
            if ((existing.author as { id: string }).id !== c.api.botId) throw new Error('Only bot-authored polls can be ended');
            return c.api.post(`/channels/${a.channelId}/polls/${a.messageId}/expire`, {});
        },
        sensitive,
    ),
    define(
        'poll_voters',
        'Read a bounded page of voters for one answer.',
        { scope: 'messages.read', target: 'channel' },
        { ...message, answerId: z.number().int().positive(), ...pagination },
        (a, c) =>
            c.api.get(`/channels/${a.channelId}/polls/${a.messageId}/answers/${a.answerId}`, query({ limit: a.limit, after: a.before })),
    ),
];
