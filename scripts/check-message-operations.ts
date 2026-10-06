import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, ids } from './fixtures.js';
import { RecordingApi, expectCalls, operationRunner } from './discord-fakes.js';
import { origin, query, rich } from '../src/discord/operations.js';
import { operations } from '../src/discord/catalog.js';

const c = ids.channel;
const m = ids.message;
const thumbsUp = '\u{1F44D}';
const custom = 'party_blob:123456789012345678';
const mentions = { parse: [], replied_user: false };

function setup(file: string) {
    const f = fixture(file);
    const api = new RecordingApi(f.policy);
    const access = { event: f.event, expiresAt: Number.POSITIVE_INFINITY };
    return { f, api, run: operationRunner(api, f.policy, access), bare: operationRunner(api, f.policy) };
}

async function checkMessageRequests(file: string): Promise<void> {
    const { api, run } = setup(file);
    await expectCalls(run, api, [
        ['messages_list', { channelId: c }, { method: 'GET', route: `/channels/${c}/messages`, query: 'limit=25' }],
        ['messages_list', { channelId: c, limit: 5, before: m }, { query: `limit=5&before=${m}` }],
        ['message_get', { channelId: c, messageId: m }, { method: 'GET', route: `/channels/${c}/messages/${m}` }],
        ['pins_list', { channelId: c, before: '2026-01-01T00:00:00Z' }, { query: 'limit=25&before=2026-01-01T00%3A00%3A00Z' }],
        [
            'message_edit',
            { channelId: c, messageId: m, content: 'edited' },
            { method: 'PATCH', route: `/channels/${c}/messages/${m}`, body: { content: 'edited', allowed_mentions: mentions } },
        ],
        ['message_delete', { channelId: c, messageId: m }, { method: 'DELETE', route: `/channels/${c}/messages/${m}` }],
        [
            'messages_bulk_delete',
            { channelId: c, messageIds: [m, ids.other] },
            { method: 'POST', route: `/channels/${c}/messages/bulk-delete`, body: { messages: [m, ids.other] } },
        ],
        ['message_pin', { channelId: c, messageId: m }, { method: 'PUT', route: `/channels/${c}/messages/pins/${m}` }],
        ['message_unpin', { channelId: c, messageId: m }, { method: 'DELETE', route: `/channels/${c}/messages/pins/${m}` }],
        [
            'reaction_add',
            { channelId: c, messageId: m, emoji: thumbsUp },
            { route: `/channels/${c}/messages/${m}/reactions/%F0%9F%91%8D/@me` },
        ],
        [
            'reaction_remove_own',
            { channelId: c, messageId: m, emoji: custom },
            { method: 'DELETE', route: `/channels/${c}/messages/${m}/reactions/party_blob%3A123456789012345678/@me` },
        ],
        [
            'reaction_users',
            { channelId: c, messageId: m, emoji: thumbsUp, limit: 3, after: ids.user },
            { query: `limit=3&after=${ids.user}` },
        ],
        ['poll_end', { channelId: c, messageId: m }, { method: 'POST', route: `/channels/${c}/polls/${m}/expire`, body: {} }],
        ['poll_voters', { channelId: c, messageId: m, answerId: 2 }, { route: `/channels/${c}/polls/${m}/answers/2`, query: 'limit=25' }],
    ]);
    const pinCalls = api.calls.filter((call) => call.method === 'MESSAGE');
    assert.equal(pinCalls.length, 4, 'edit, pin, react and poll end each check the target message first');
    api.messageAuthor = ids.user;
    await assert.rejects(run('message_edit', { channelId: c, messageId: m, content: 'x' }), /Only bot-authored messages/);
    await assert.rejects(run('poll_end', { channelId: c, messageId: m }), /Only bot-authored polls/);
    await assert.rejects(run('reaction_add', { channelId: c, messageId: m, emoji: 'not an emoji' }));
    await assert.rejects(run('message_get', { channelId: c, messageId: m, extra: true }), 'operation inputs are strict');
}

async function checkPolls(file: string): Promise<void> {
    const { f, api, run, bare } = setup(file);
    const poll = { question: 'Lunch?', answers: ['Pizza', 'Soup'] };
    await assert.rejects(bare('poll_create', { channelId: c, poll }), /Captured triggering event is required/);
    await assert.rejects(run('poll_create', { channelId: ids.other, poll }), /must match its captured event/);
    await run('poll_create', { channelId: c, poll: { ...poll, durationHours: 2, multiselect: true } });
    assert.deepEqual(api.last(), {
        method: 'POST',
        route: `/channels/${c}/messages`,
        body: {
            allowed_mentions: mentions,
            poll: {
                question: { text: 'Lunch?' },
                answers: [{ poll_media: { text: 'Pizza' } }, { poll_media: { text: 'Soup' } }],
                duration: 2,
                allow_multiselect: true,
                layout_type: 1,
            },
        },
    });
    await run('poll_create', { channelId: c, poll });
    const body = api.last()!.body as { poll: { duration: number; allow_multiselect: boolean } };
    assert.equal(body.poll.duration, 24);
    assert.equal(body.poll.allow_multiselect, false);
    assert.equal(f.queue.snapshot(0, 25).events.length, 1);
}

async function checkChannelRequests(file: string): Promise<void> {
    const { f, api, run } = setup(file);
    f.policy.config.channels.blocked.push(ids.other);
    api.responses.set(`/guilds/${ids.guild}/channels`, [{ id: c }, { id: ids.other }]);
    assert.deepEqual(await run('channels_list', { guildId: ids.guild }), [{ id: c }], 'blocked channels are hidden');
    api.responses.set(`/guilds/${ids.guild}/threads/active`, { threads: [{ id: ids.other }, { id: ids.user }] });
    assert.deepEqual(await run('threads_active', { guildId: ids.guild }), [{ id: ids.user }]);
    api.responses.set(`/channels/${c}/threads/archived/public`, { threads: [{ id: ids.other }, { id: m }], has_more: true });
    assert.deepEqual(await run('threads_archived', { channelId: c, limit: 2, before: '2026-02-03T04:05:06Z' }), {
        threads: [{ id: m }],
        has_more: true,
    });
    assert.equal(api.last()!.query, 'limit=2&before=2026-02-03T04%3A05%3A06Z');
    const overwrite = { channelId: c, overwriteId: ids.user, type: 1, allow: '1024', deny: '0' };
    await expectCalls(run, api, [
        ['channel_get', { channelId: c }, { method: 'GET', route: `/channels/${c}` }],
        [
            'channel_create',
            { guildId: ids.guild, name: 'general', type: 0 },
            { route: `/guilds/${ids.guild}/channels`, body: { name: 'general', type: 0, parent_id: undefined, topic: undefined } },
        ],
        [
            'channel_edit',
            { channelId: c, name: 'renamed', slowmodeSeconds: 5, nsfw: false },
            { method: 'PATCH', body: { name: 'renamed', topic: undefined, rate_limit_per_user: 5, nsfw: false } },
        ],
        ['channel_delete', { channelId: c }, { method: 'DELETE', route: `/channels/${c}` }],
        [
            'channel_overwrite_set',
            overwrite,
            { method: 'PUT', route: `/channels/${c}/permissions/${ids.user}`, body: { type: 1, allow: '1024', deny: '0' } },
        ],
        [
            'channel_overwrite_delete',
            { channelId: c, overwriteId: ids.user },
            { method: 'DELETE', route: `/channels/${c}/permissions/${ids.user}` },
        ],
        [
            'thread_edit',
            { channelId: c, archived: true, locked: false },
            { method: 'PATCH', body: { archived: true, locked: false, name: undefined } },
        ],
        ['thread_join', { channelId: c }, { method: 'PUT', route: `/channels/${c}/thread-members/@me` }],
        ['thread_leave', { channelId: c }, { method: 'DELETE', route: `/channels/${c}/thread-members/@me` }],
        ['thread_member_add', { channelId: c, userId: ids.user }, { method: 'PUT', route: `/channels/${c}/thread-members/${ids.user}` }],
        [
            'thread_member_remove',
            { channelId: c, userId: ids.denied },
            { method: 'DELETE', route: `/channels/${c}/thread-members/${ids.denied}` },
        ],
    ]);
    await assert.rejects(run('thread_member_add', { channelId: c, userId: ids.denied }), /not whitelisted/);
    assert.equal(api.last()!.method, 'DELETE', 'an unapproved thread member is never added');
}

async function checkParents(file: string): Promise<void> {
    const { api, run } = setup(file);
    await run('channel_create', { guildId: ids.guild, name: 'nested', type: 0, parentId: ids.user, topic: 'about' });
    assert.deepEqual(
        api.calls.map((call) => call.method),
        ['CHANNEL', 'POST'],
    );
    assert.deepEqual((api.last()!.body as { parent_id: string }).parent_id, ids.user);
    api.channelGuild = ids.other;
    await assert.rejects(run('channel_create', { guildId: ids.guild, name: 'x', type: 0, parentId: ids.user }), /another guild/);
    assert.equal(api.calls.length, 3, 'nothing is created under a foreign parent');
}

async function checkThreads(file: string): Promise<void> {
    const { f, api, run, bare } = setup(file);
    await run('thread_create', { channelId: c, name: 'Follow up' });
    assert.deepEqual(api.last(), {
        method: 'POST',
        route: `/channels/${c}/messages/${m}/threads`,
        body: { name: 'Follow up', auto_archive_duration: 1440 },
    });
    await run('forum_post_create', { channelId: c, name: 'Post', content: 'Body', autoArchiveMinutes: 60 });
    assert.deepEqual(api.last()!.body, {
        name: 'Post',
        auto_archive_duration: 60,
        message: { content: 'Body', allowed_mentions: mentions },
    });
    await assert.rejects(run('forum_post_create', { channelId: ids.other, name: 'P', content: 'B' }), /must match/);
    await assert.rejects(bare('thread_create', { channelId: c, name: 'x' }), /Captured triggering event/);
    const slash = f.queue.add('slash', { actorId: ids.user, channelId: c, guildId: ids.guild, kind: 'interaction', text: 'hi' })!;
    const fromSlash = operationRunner(api, f.policy, { event: slash, expiresAt: Number.POSITIVE_INFINITY });
    await assert.rejects(fromSlash('thread_create', { channelId: c, name: 'x' }), /triggering message is required/);
    await assert.rejects(run('thread_create', { channelId: c, name: 'x', autoArchiveMinutes: 30 }));
}

function checkHelpers(): void {
    assert.equal(query({ a: 1, b: undefined, c: false, d: 'x y' }).toString(), 'a=1&c=false&d=x+y');
    const event = { event: { actorId: ids.user, channelId: c, guildId: null, kind: 'owner' as const, id: 'o' }, expiresAt: 1 };
    assert.equal(origin({ api: {} as never, policy: {} as never, origin: event }), event);
    const embed = { title: 't'.repeat(200), footer: { text: 'f'.repeat(1000) }, fields: [{ name: 'n', value: 'v'.repeat(799) }] };
    assert.ok(rich.embeds.safeParse([embed, embed, embed]).success, 'title, footer and fields add up to exactly 6000');
    assert.equal(rich.embeds.safeParse([embed, embed, { ...embed, title: 't'.repeat(201) }]).success, false);
    assert.ok(rich.embeds.safeParse([{}]).success, 'an empty embed counts as zero characters');
    const flags = Object.fromEntries(operations.map((item) => [item.name, [item.mutates, item.sensitive]]));
    assert.deepEqual(flags.messages_list, [false, false]);
    assert.deepEqual(flags.thread_join, [true, false]);
    assert.deepEqual(flags.channel_delete, [true, true]);
    assert.equal(new Set(operations.map((item) => item.name)).size, operations.length, 'operation names are unique');
}

export async function checkMessageOperations(directory: string): Promise<void> {
    checkHelpers();
    await checkMessageRequests(join(directory, 'message-operations.json'));
    await checkPolls(join(directory, 'poll-operations.json'));
    await checkChannelRequests(join(directory, 'channel-operations.json'));
    await checkParents(join(directory, 'parent-operations.json'));
    await checkThreads(join(directory, 'thread-operations.json'));
}
