import assert from 'node:assert/strict';
import type { Message } from 'discord.js';
import { Gateway } from '../src/discord/gateway.js';
import { ContextIndex, type ObservedMessage } from '../src/core/context.js';
import { fixture, fakeConfig, ids } from './fixtures.js';

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
        maxMessages: 3,
        perChannel: 2,
        ttlMinutes: 1,
        contentLimit: 10,
        includeBots: false,
    };
    let now = Date.now();
    const index = new ContextIndex(f.policy, f.queue, () => now);
    index.ingest(observed({ actorId: ids.denied }), false);
    assert.equal(f.queue.snapshot(0, 25).events.length, 1);
    const page = index.query(f.event.id, 'recent', 25);
    assert.equal(page.records[0]?.actorId, ids.denied);
    assert.equal(page.records[0]?.truncated, true);
    assert.equal(page.records[0]?.text.length, 10);
    assert.throws(() => index.query('forged-event', 'recent', 25));
    index.ingest(observed({ messageId: ids.other, channelId: ids.other, text: 'cross' }), false);
    assert.equal(index.query(f.event.id, 'user', 25).records.length, 1);
    assert.equal(index.query(f.event.id, 'recent', 25).records.length, 1);
    assert.equal(index.query(f.event.id, 'search', 25, 'SAMPLE').records.length, 1);
    index.update(ids.message, 'edited', true);
    assert.equal(index.query(f.event.id, 'search', 25, 'sample').records.length, 0);
    index.remove(ids.message);
    assert.equal(index.query(f.event.id, 'recent', 25).records.length, 0);
    now += 61_000;
    assert.equal(index.query(f.event.id, 'user', 25).records.length, 0);
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
            fetchReference: async () => {
                fetched++;
                return { id: ids.bot, channelId: targetChannel, guildId: ids.guild, author: { id: targetAuthor } };
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
    missing.fetchReference = async () => {
        throw new Error('missing');
    };
    await gateway.message(missing);
    assert.equal(f.queue.snapshot(0, 25).events.length, 2);
    gateway.stop();
}
