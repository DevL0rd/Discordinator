import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ReplyOrigins } from '../src/core/reply-origins.js';
import { Bridge } from '../src/core/bridge.js';
import { ContextIndex } from '../src/core/context.js';
import { EventQueue } from '../src/core/queue.js';
import { fixture, ids } from './fixtures.js';
import { RecordingApi } from './discord-fakes.js';
import { observed } from './check-context.js';

function checkDedupeLimit(): void {
    const queue = new EventQueue(1);
    const input = { actorId: ids.user, channelId: ids.channel, guildId: ids.guild, kind: 'message' as const, text: 'x' };
    for (const key of ['a', 'b', 'c', 'd']) assert.ok(queue.add(key, input));
    assert.equal(queue.snapshot(0, 25).droppedOnDedupeLimit, 0);
    assert.ok(queue.add('e', input), 'a full dedupe table forgets its oldest key');
    assert.equal(queue.snapshot(0, 25).droppedOnDedupeLimit, 1);
    assert.ok(queue.add('a', input), 'the forgotten key is accepted again');
    assert.equal(queue.add('e', input), null);
}

function checkContextAccess(file: string): void {
    const f = fixture(file);
    f.policy.config.scopes.push('messages.read');
    f.policy.config.context = { enabled: true, capture: 'all', reach: 'channel', perChannel: 10, includeBots: true };
    const index = new ContextIndex(f.policy, f.queue);
    const elsewhere = '700000000000000003';
    index.ingest(observed({ messageId: ids.other, text: 'here' }), false);
    index.ingest(observed({ messageId: '700000000000000004', channelId: elsewhere, text: 'later blocked' }), false);
    assert.equal(index.query(f.event.id, 'recent', 25).retained, 2);
    f.policy.config.channels.blocked.push(elsewhere);
    assert.equal(index.query(f.event.id, 'recent', 25).retained, 1, 'records from a newly blocked channel stop being readable');
    f.policy.config.channels.blocked = [];
    const dm = f.queue.add('dm', { actorId: ids.user, channelId: ids.other, guildId: null, kind: 'message', text: 'hi' })!;
    index.ingest(observed({ messageId: '700000000000000001', channelId: ids.other, guildId: null, text: 'mine' }), false);
    f.policy.config.allowedUserIds.push(ids.denied);
    index.ingest(observed({ messageId: '700000000000000002', channelId: ids.other, guildId: null, actorId: ids.denied }), false);
    f.policy.config.allowedUserIds = [ids.user];
    const texts = index.query(dm.id, 'recent', 25).records.map((record) => record.text);
    assert.deepEqual(texts, ['mine'], 'a direct message query only sees its own conversation, and only approved people');
}

async function checkGuildList(file: string): Promise<void> {
    const f = fixture(file);
    const api = new RecordingApi(f.policy);
    const bridge = new Bridge(f.policy, f.queue, f.journal, api);
    f.policy.config.servers.blocked.push(ids.other);
    api.responses.set('/users/@me/guilds', [
        { id: ids.guild, name: 'Home', icon: 'hidden' },
        { id: ids.other, name: 'Blocked' },
    ]);
    assert.deepEqual(await bridge.guilds(10), [{ id: ids.guild, name: 'Home' }], 'blocked servers and unsafe fields are dropped');
    assert.equal(api.last()!.query, 'limit=10');
    await bridge.guilds(5, ids.guild);
    assert.equal(api.last()!.query, `limit=5&before=${ids.guild}`);
    f.policy.config.scopes = [];
    await assert.rejects(bridge.guilds(5), /Capability is not approved/);
}

async function checkReplies(directory: string): Promise<void> {
    const f = fixture(join(directory, 'core-replies.json'));
    const api = new RecordingApi(f.policy);
    const origins = new ReplyOrigins(join(directory, 'core-reply-origins.json'));
    const bridge = new Bridge(f.policy, f.queue, f.journal, api, origins);
    await assert.rejects(bridge.respond({ eventId: randomUUID(), content: 'hi', idempotencyKey: 'unknown' }), /Reply origin unknown/);
    const heads: string[] = [];
    const slash = f.queue.add(
        'slash',
        { actorId: ids.user, channelId: ids.channel, guildId: ids.guild, kind: 'interaction', text: 'go' },
        (text) => {
            heads.push(text);
            return Promise.resolve({ id: ids.message, channel_id: ids.channel });
        },
    )!;
    const long = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`;
    await bridge.respond({ eventId: slash.id, content: long, idempotencyKey: 'long-slash' });
    assert.deepEqual(heads, ['a'.repeat(1500)], 'the interaction reply carries the first part');
    const posted = api.calls.filter((call) => call.method === 'POST' || call.method === 'FILES');
    assert.match(JSON.stringify(posted), /bbbb/, 'the rest is sent to the channel');
    const delivered: unknown[] = [];
    const reply = () => Promise.resolve({ id: ids.message, channel_id: ids.channel });
    const input = { actorId: ids.user, channelId: ids.channel, guildId: ids.guild, kind: 'interaction' as const, text: 'report' };
    const panel = f.queue.add('panel', input, reply, (payload) => {
        delivered.push(payload);
        return reply();
    })!;
    const embeds = [{ title: 'Report' }];
    await bridge.respond({ eventId: panel.id, content: 'summary', embeds, idempotencyKey: 'embed-slash' });
    assert.deepEqual(delivered, [{ content: 'summary', embeds }], 'embeds go through the interaction delivery');
}

export async function checkCoreEdges(directory: string): Promise<void> {
    checkDedupeLimit();
    checkContextAccess(join(directory, 'core-context.json'));
    await checkGuildList(join(directory, 'core-guilds.json'));
    await checkReplies(directory);
}
