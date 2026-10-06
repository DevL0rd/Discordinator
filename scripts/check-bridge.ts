import assert from 'node:assert/strict';
import { UncertainOutcome } from '../src/core/errors.js';
import { Journal } from '../src/core/journal.js';
import { operations } from '../src/discord/catalog.js';
import { policySchema } from '../src/core/config.js';
import { Policy } from '../src/core/policy.js';
import { fixture, ids } from './fixtures.js';
import { EventQueue } from '../src/core/queue.js';

async function checkMutations(file: string): Promise<void> {
    const f = fixture(file);
    const operation = operations.find((item) => item.name === 'message_delete')!;
    const controls = { eventId: f.event.id, idempotencyKey: 'delete-confirmation' };
    const args = { channelId: ids.channel, messageId: ids.message };
    await assert.rejects(() => f.bridge.invoke(operation, args));
    const preview = (await f.bridge.invoke(operation, args, controls)) as { approvalId: string };
    assert.equal(f.api.calls.length, 0);
    await assert.rejects(() => f.bridge.invoke(operation, args, { ...controls, approvalId: preview.approvalId }));
    assert.equal(f.approvals.confirm({ ...f.event, actorId: ids.user, channelId: ids.other }, preview.approvalId), false);
    assert.equal(f.approvals.confirm(f.event, preview.approvalId), true);
    await assert.rejects(() =>
        f.bridge.invoke(operation, { ...args, messageId: ids.other }, { ...controls, approvalId: preview.approvalId }),
    );
    await f.bridge.invoke(operation, args, { ...controls, approvalId: preview.approvalId });
    await f.bridge.invoke(operation, args, { ...controls, approvalId: preview.approvalId });
    assert.equal(f.api.calls.length, 1);
    await assert.rejects(() => f.bridge.proactive({ channelId: ids.channel, content: 'blocked', idempotencyKey: 'proactive-blocked' }));
    await assert.rejects(() => f.bridge.respond({ eventId: 'unknown', content: 'blocked', idempotencyKey: 'respond-blocked' }));
}

async function checkResponses(file: string): Promise<void> {
    const f = fixture(file);
    const input = { eventId: f.event.id, content: 'hello @everyone', idempotencyKey: 'respond-key' };
    await f.bridge.respond(input);
    await f.bridge.respond(input);
    assert.equal(f.api.calls.length, 1);
    const body = f.api.calls[0]!.body as { allowed_mentions: unknown; enforce_nonce: boolean };
    assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
    assert.equal(body.enforce_nonce, true);
    await assert.rejects(() => f.bridge.respond({ ...input, content: 'changed' }));
    await f.bridge.dm({ ...input, idempotencyKey: 'dm-response-key' });
    assert.deepEqual(f.api.calls[1]!.body, { recipient_id: ids.user });
    const deniedEvent = f.queue.add('denied', { ...f.event, actorId: ids.denied })!;
    await assert.rejects(() => f.bridge.dm({ ...input, eventId: deniedEvent.id, idempotencyKey: 'denied-dm-key' }));
    const saved = new Journal(file);
    await saved.load();
    assert.deepEqual(
        await saved.execute(input.idempotencyKey, { operation: 'respond', ...input }, () => Promise.reject(new Error('must not rerun'))),
        { id: ids.message, channel_id: ids.channel },
    );
}

async function checkJournal(file: string): Promise<void> {
    const journal = new Journal(file);
    await journal.load();
    await assert.rejects(() =>
        journal.execute('uncertain-key', { action: 'uncertain' }, () => Promise.reject(new UncertainOutcome('ambiguous network result'))),
    );
    await assert.rejects(() =>
        journal.execute('refused-key', { action: 'refused' }, () => Promise.reject(new Error('Discord request failed (403)'))),
    );
    assert.equal(
        await journal.execute('refused-key', { action: 'refused' }, () => Promise.resolve('sent')),
        'sent',
        'a definite failure can be retried',
    );
    const both = await Promise.all([
        journal.execute('parallel-a', {}, () => Promise.resolve('a')),
        journal.execute('parallel-b', {}, () => Promise.resolve('b')),
    ]);
    assert.deepEqual(both, ['a', 'b'], 'concurrent operations queue instead of failing');
    const reloaded = new Journal(file);
    await reloaded.load();
    await assert.rejects(() => reloaded.execute('uncertain-key', { action: 'uncertain' }, () => Promise.resolve('duplicate')), /uncertain/);
    const tiny = new Journal(`${file}.capacity`, 1);
    await tiny.load();
    await tiny.execute('first', {}, () => Promise.resolve(null));
    assert.equal(await tiny.execute('second', {}, () => Promise.resolve('kept')), 'kept', 'the oldest finished record makes room');
    await assert.rejects(() => tiny.execute('stuck', {}, () => Promise.reject(new UncertainOutcome('timeout'))));
    await assert.rejects(() => tiny.execute('third', {}, () => Promise.resolve(null)), /full of unresolved/);
    let now = 0;
    const aging = new Journal(`${file}.aging`, 10, () => now, 1000);
    await aging.execute('old', {}, () => Promise.resolve('first'));
    now = 2000;
    assert.equal(await aging.execute('old', {}, () => Promise.resolve('again')), 'again', 'records expire after their retention');
}

function checkQueue(): void {
    let now = 0;
    const queue = new EventQueue(2, 100, () => now);
    const event = { actorId: ids.user, channelId: ids.channel, guildId: ids.guild, kind: 'message' as const, text: 'Discordinator' };
    const first = queue.add('one', event)!;
    assert.equal(queue.add('one', event), null);
    queue.add('two', event);
    queue.add('three', event);
    assert.equal(queue.snapshot(0, 25).gap, true);
    assert.throws(() => queue.context(first.id));
    now = 101;
    assert.equal(queue.snapshot(0, 25).events.length, 0);
    assert.notEqual(queue.add('one', event), null);
    const source = queue.add('parent', event)!;
    now = 150;
    const child = queue.add('child', { ...event, kind: 'interaction', sourceEventId: source.id })!;
    assert.ok(queue.context(child.id));
    now = 202;
    assert.throws(() => queue.context(child.id));
}

async function checkLongReply(file: string): Promise<void> {
    const f = fixture(file);
    const paragraph = 'word '.repeat(300).trim();
    const content = [paragraph, paragraph, paragraph].join('\n\n');
    await f.bridge.respond({ eventId: f.event.id, content, idempotencyKey: 'long-reply', embeds: [{ title: 'Summary' }] });
    const bodies = f.api.calls.map(
        (call) => call.body as { content: string; nonce: string; message_reference?: unknown; embeds?: unknown },
    );
    assert.equal(bodies.length, 3, 'long replies are sent as several messages');
    assert.ok(bodies.every((body) => body.content.length <= 2000));
    assert.equal(bodies.filter((body) => body.message_reference).length, 1, 'only the first part replies to the request');
    assert.ok(bodies[2]!.embeds && !bodies[0]!.embeds, 'embeds come after the text');
    assert.equal(new Set(bodies.map((body) => body.nonce)).size, 3, 'every part has its own nonce');
}

export async function checkBridge(directory: string): Promise<void> {
    assert.equal(new Set(operations.map((item) => item.name)).size, operations.length);
    for (const operation of operations) {
        assert.equal(operation.schema.safeParse({ route: '/arbitrary' }).success, false);
        if (operation.sensitive) assert.equal(operation.mutates, true);
    }
    const policy = new Policy(policySchema.parse({ servers: { mode: 'blocklist' }, channels: { mode: 'blocklist' } }));
    assert.throws(() => policy.assertUser(ids.user));
    await checkMutations(`${directory}/mutations.json`);
    await checkResponses(`${directory}/responses.json`);
    await checkLongReply(`${directory}/long-reply.json`);
    await checkJournal(`${directory}/journal.json`);
    checkQueue();
}
