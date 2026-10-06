import assert from 'node:assert/strict';
import type { Message } from 'discord.js';
import { Gateway } from '../src/discord/gateway.js';
import { ContextIndex, type ObservedMessage } from '../src/core/context.js';
import { fixture, fakeConfig, ids } from './fixtures.js';
import { channelHistory } from '../src/operator/history.js';
import { observeRaw, type RawMessage } from '../src/discord/observation.js';

export function observed(overrides: Partial<ObservedMessage> = {}): ObservedMessage {
    return {
        actorId: ids.user,
        channelId: ids.channel,
        guildId: ids.guild,
        messageId: ids.message,
        authorBot: false,
        text: 'sample data',
        timestamp: new Date().toISOString(),
        contentAvailable: true,
        parentId: null,
        replyToId: null,
        ...overrides,
    };
}

export async function checkContext(directory: string): Promise<void> {
    const f = fixture(`${directory}/context.json`);
    f.policy.config.scopes.push('messages.read');
    f.policy.config.context = {
        enabled: true,
        capture: 'all',
        reach: 'channel',
        perChannel: 2,
        includeBots: false,
    };
    let now = Date.now();
    const index = new ContextIndex(f.policy, f.queue, () => now);
    index.ingest(observed({ actorId: ids.denied }), false);
    assert.equal(f.queue.snapshot(0, 25).events.length, 1);
    const page = index.query(f.event.id, 'recent', 25);
    assert.equal(page.records[0]?.actorId, ids.denied);
    assert.equal(page.records[0]?.text, observed().text, 'messages are kept in full');
    assert.throws(() => index.query('forged-event', 'recent', 25));
    index.ingest(observed({ messageId: ids.other, channelId: ids.other, text: 'cross' }), false);
    assert.equal(index.query(f.event.id, 'user', 25).records.length, 1);
    assert.equal(index.query(f.event.id, 'recent', 25).records.length, 1);
    assert.equal(index.query(f.event.id, 'search', 25, 'SAMPLE').records.length, 1);
    index.update(ids.message, 'edited', true);
    assert.equal(index.query(f.event.id, 'search', 25, 'sample').records.length, 0);
    index.remove(ids.message);
    assert.equal(index.query(f.event.id, 'recent', 25).records.length, 0);
    now += 24 * 60 * 60_000;
    assert.equal(index.query(f.event.id, 'user', 25).records.length, 1, 'messages stay until newer ones displace them');
    checkBounds(index, f);
    await checkReplies(`${directory}/replies.json`);
}

function checkBounds(index: ContextIndex, f: ReturnType<typeof fixture>): void {
    for (const id of [ids.message, ids.other, ids.channel, ids.guild]) index.ingest(observed({ messageId: id }), false);
    const page = index.query(f.event.id, 'recent', 50);
    assert.equal(page.records.length, 2);
    assert.ok(page.evicted >= 2);
    f.policy.config.context.capture = 'addressed';
    index.ingest(observed({ messageId: ids.bot }), false);
    assert.equal(
        index.query(f.event.id, 'recent', 50).records.some((item) => item.messageId === ids.bot),
        false,
    );
    f.policy.config.allowedUserIds = [];
    assert.throws(() => index.query(f.event.id, 'recent', 25));
}

async function checkReplies(file: string): Promise<void> {
    const f = fixture(file);
    const gateway = new Gateway(fakeConfig(), f.policy, f.queue, f.approvals, f.api);
    let fetched = 0;
    const message = (actorId: string, targetAuthor: string, id: string, targetChannel: string = ids.channel) =>
        ({
            author: { id: actorId, bot: false },
            content: 'ordinary reply',
            id,
            channelId: ids.channel,
            guildId: ids.guild,
            webhookId: null,
            reference: { channelId: ids.channel, guildId: ids.guild, messageId: ids.bot },
            fetchReference: () => {
                fetched++;
                return Promise.resolve({ id: ids.bot, channelId: targetChannel, guildId: ids.guild, author: { id: targetAuthor } });
            },
        }) as unknown as Message;
    await gateway.message(message(ids.denied, ids.bot, 'denied'));
    assert.equal(fetched, 0);
    await gateway.message(message(ids.user, ids.denied, 'wrong-author'));
    await gateway.message(message(ids.user, ids.bot, 'wrong-channel', ids.other));
    assert.equal(f.queue.snapshot(0, 25).events.length, 1);
    await gateway.message(message(ids.user, ids.bot, 'good-reference'));
    assert.equal(f.queue.snapshot(0, 25).events.length, 2);
    const missing = message(ids.user, ids.bot, 'deleted');
    missing.fetchReference = () => Promise.reject(new Error('missing'));
    await gateway.message(missing);
    assert.equal(f.queue.snapshot(0, 25).events.length, 2);
    gateway.stop();
}

export async function checkHistory(directory: string): Promise<void> {
    const f = fixture(`${directory}/history.json`);
    f.policy.config.scopes.push('messages.read');
    f.policy.config.context = { enabled: true, capture: 'all', reach: 'channel', perChannel: 10, includeBots: false };
    const raw = (id: string, minute: string, content: string, channel = ids.channel): RawMessage => ({
        id,
        channel_id: channel,
        content,
        timestamp: `2026-10-07T01:${minute}:00.000Z`,
        author: { id: ids.denied },
    });
    const fetched: string[] = [];
    f.api.get = (route: string) => {
        if (route.endsWith('/channels'))
            return Promise.resolve([
                { id: ids.channel, name: 'general', type: 0 },
                { id: ids.other, name: 'random', type: 0 },
            ]);
        fetched.push(route);
        if (route.includes(ids.other)) return Promise.resolve([raw('900000000000000009', '07', 'elsewhere', ids.other)]);
        return Promise.resolve([
            raw(ids.message, '10', 'Discordinator help'),
            raw('900000000000000002', '05', 'second'),
            raw('900000000000000001', '00', 'first'),
        ]);
    };
    const history = channelHistory(f.bridge.context, f.policy, f.api);
    const opening = await history(f.event, {});
    assert.match(
        opening.text,
        /^Recent messages[\s\S]*first[\s\S]*second/,
        'a restart backfills recent channel history from Discord, oldest first',
    );
    assert.doesNotMatch(opening.text, /Discordinator help|elsewhere/, 'only this channel, without repeating the delivered message');
    assert.equal(opening.key, ids.channel);
    f.bridge.context.ingest(observeRaw(raw('900000000000000003', '20', 'later'), ids.guild, null), false);
    const update = await history(f.event, { [opening.key]: opening.latest! });
    assert.match(update.text, /^New messages[\s\S]*later/, 'later deliveries carry only what is new, from anyone in the channel');
    assert.doesNotMatch(update.text, /first|second/);
    assert.equal(fetched.length, 1, 'Discord history is fetched once per channel per run');
    const offline = Object.create(f.api) as typeof f.api;
    offline.get = () => Promise.reject(new Error('offline'));
    const flaky = channelHistory(f.bridge.context, f.policy, offline);
    await flaky(f.event, {});
    offline.get = (route) => f.api.get(route);
    await flaky(f.event, {});
    assert.equal(fetched.length, 2, 'a failed history fetch is retried on the next message');
    fetched.pop();
    f.policy.config.context.reach = 'server';
    const server = await history(f.event, {});
    assert.equal(server.key, `guild:${ids.guild}`);
    assert.match(server.text, /#general[\s\S]*first[\s\S]*#random[\s\S]*elsewhere/, 'whole-server history is grouped by channel');
    f.api.channel = () => Promise.reject(new Error('This operation requires a guild channel'));
    const dm = f.queue.add('dm-history', {
        actorId: ids.user,
        channelId: ids.other,
        guildId: null,
        messageId: '900000000000000099',
        kind: 'message',
        text: 'hi',
    })!;
    assert.equal(typeof (await history(dm, {})).text, 'string', 'direct messages never use the server-only channel lookup');
}
