import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, ids } from './fixtures.js';
import { until } from './discord-fakes.js';
import { ReplyOrigins } from '../src/core/reply-origins.js';
import { EventQueue } from '../src/core/queue.js';
import { Journal } from '../src/core/journal.js';
import { Bridge } from '../src/core/bridge.js';
import { Approvals } from '../src/core/approvals.js';
import { operations } from '../src/discord/catalog.js';

const week = 7 * 24 * 60 * 60_000;
import { promptSchema } from '../src/interactions/schema.js';

export async function checkReplyOrigins(directory: string): Promise<void> {
    const base = fixture(join(directory, 'old-journal.json'));
    const origins = new ReplyOrigins(join(directory, 'origins.json'));
    await origins.load();
    await origins.capture(base.event);
    const restored = new ReplyOrigins(origins.file);
    await restored.load();
    assert.deepEqual(restored.context(base.event.id), base.event);
    assert.throws(() => restored.context('00000000-0000-4000-8000-000000000000'), /unknown/);
    await assert.rejects(restored.capture({ ...base.event, id: '22222222-2222-4222-8222-222222222222' }), /already captured/);
    let now = Date.now();
    const journal = new Journal(join(directory, 'reply-journal.json'), 16384, () => now, week);
    await journal.load();
    base.api.message = () =>
        Promise.resolve({ id: ids.message, channel_id: ids.channel, author: { id: ids.user }, content: base.event.text });
    const queue = new EventQueue(1, 1, () => now);
    const bridge = new Bridge(base.policy, queue, base.journal, base.approvals, base.api, restored, journal);
    now += 24 * 60 * 60_000;
    const input = {
        eventId: base.event.id,
        idempotencyKey: 'durable-test-reply',
        content: `Done <@${ids.user}> @everyone`,
        notifyRequester: true,
    };
    await bridge.respond(input);
    const sent = base.api.calls.filter((call) => call.method === 'POST');
    assert.equal(sent.length, 1);
    assert.deepEqual((sent[0]!.body as { allowed_mentions: unknown }).allowed_mentions, {
        parse: [],
        replied_user: true,
        users: [ids.user],
    });
    const restartedJournal = new Journal(journal.file, 16384, () => now + 5 * 24 * 60 * 60_000, week);
    await restartedJournal.load();
    const restarted = new Bridge(base.policy, queue, base.journal, base.approvals, base.api, restored, restartedJournal);
    await restarted.respond(input);
    assert.equal(base.api.calls.filter((call) => call.method === 'POST').length, 1, 'reply dedup survives a restart within its retention');
    await assert.rejects(restarted.respond({ ...input, content: 'changed' }), /different input/);
    await checkDetachedSource(base, restarted, restored, input);
    await checkRevocations(directory);
    await checkDurableActions(directory);
}
async function checkDetachedSource(
    base: ReturnType<typeof fixture>,
    restarted: Bridge,
    restored: ReplyOrigins,
    input: { eventId: string; idempotencyKey: string; content: string; notifyRequester: boolean },
): Promise<void> {
    base.api.message = () =>
        Promise.resolve({ id: ids.message, channel_id: ids.other, author: { id: ids.user }, content: base.event.text });
    await restarted.respond({ ...input, idempotencyKey: 'moved-source-reply' });
    const moved = base.api.calls.filter((call) => call.method === 'POST').at(-1)!.body as { message_reference?: unknown };
    assert.equal(moved.message_reference, undefined, 'a request whose source moved is answered in its channel without a reply link');
    base.api.message = () => Promise.reject(new Error('Unknown Message'));
    await restarted.respond({ ...input, idempotencyKey: 'deleted-source-reply' });
    assert.equal(base.api.calls.filter((call) => call.method === 'POST').length, 3, 'a deleted request can still be answered');
    assert.equal(restored.context(base.event.id).id, base.event.id, 'and its authority is never revoked');
}
async function checkNoExpiry(directory: string): Promise<void> {
    const f = fixture(join(directory, 'no-expiry.json'));
    const old = { ...f.event, receivedAt: new Date(Date.now() - 400 * 24 * 60 * 60_000).toISOString() };
    const origins = new ReplyOrigins(join(directory, 'no-expiry-origins.json'));
    await origins.capture(old);
    const restored = new ReplyOrigins(origins.file);
    await restored.load();
    assert.deepEqual(restored.context(old.id), old, 'a captured request stays valid however old it is');
    let now = 0;
    const queue = new EventQueue(5, 10, () => now);
    const event = queue.add('late', { actorId: ids.user, channelId: ids.channel, guildId: ids.guild, kind: 'interaction', text: 'go' })!;
    now = 24 * 60 * 60_000;
    assert.equal(queue.snapshot(0, 25).events.length, 0, 'the poll feed still ages events out');
    await checkRestartedEvents(directory);
    await checkTypingBeforeCapture(directory);
    assert.equal(queue.context(event.id).event.id, event.id, 'a late answer can still find its request');
}
async function checkTypingBeforeCapture(directory: string): Promise<void> {
    const f = fixture(join(directory, 'typing-early.json'));
    const origins = new ReplyOrigins(join(directory, 'typing-early-origins.json'));
    const queue = new EventQueue();
    const bridge = new Bridge(f.policy, queue, f.journal, f.approvals, f.api, origins);
    const event = queue.add('early', {
        actorId: ids.user,
        channelId: ids.channel,
        guildId: ids.guild,
        messageId: ids.message,
        kind: 'message',
        text: 'hi',
    })!;
    await bridge.typing(event.id);
    assert.match(f.api.calls.at(-1)!.route, new RegExp(`/channels/${ids.channel}/typing`), 'typing starts before the request is saved');
}
async function checkRestartedEvents(directory: string): Promise<void> {
    const f = fixture(join(directory, 'restarted-events.json'));
    const origins = new ReplyOrigins(join(directory, 'restarted-origins.json'));
    const queue = new EventQueue();
    new Bridge(f.policy, queue, f.journal, f.approvals, f.api, origins);
    const live = queue.add('slash', { actorId: ids.user, channelId: ids.channel, guildId: ids.guild, kind: 'interaction', text: 'go' })!;
    await until(() => origins.has(live.id), 'the slash request to be stored');
    const reloaded = new ReplyOrigins(origins.file);
    await reloaded.load();
    const restarted = new Bridge(f.policy, new EventQueue(), f.journal, f.approvals, f.api, reloaded);
    await restarted.respond({ eventId: live.id, content: 'Late answer', idempotencyKey: 'late-slash-answer' });
    const sent = f.api.calls.filter((call) => call.method === 'POST').at(-1)!;
    assert.match(sent.route, new RegExp(`/channels/${ids.channel}/messages`), 'after a restart the answer is posted in the channel');
}
async function checkDurableActions(directory: string): Promise<void> {
    await checkNoExpiry(directory);
    const f = fixture(join(directory, 'durable-actions.json'));
    const origins = new ReplyOrigins(join(directory, 'durable-action-origins.json'));
    await origins.capture(f.event);
    f.api.message = () => Promise.resolve({ id: ids.message, channel_id: ids.channel, author: { id: ids.user }, content: f.event.text });
    let now = Date.now();
    const queue = new EventQueue(1, 1, () => now);
    const approvals = new Approvals(f.policy, () => now);
    const bridge = new Bridge(f.policy, queue, f.journal, approvals, f.api, origins);
    f.policy.config.scopes.push('interactions.write', 'media.read', 'messages.read');
    f.policy.config.media.enabled = true;
    f.policy.config.context.enabled = true;
    now += 24 * 60 * 60_000;
    assert.equal(bridge.media.access.event(f.event.id).expiresAt, Infinity);
    assert.ok(bridge.context.query(f.event.id, 'recent', 1));
    const prompt = (await bridge.prompt({
        eventId: f.event.id,
        idempotencyKey: 'durable-question',
        ...promptSchema.parse({
            content: 'Still available?',
            mode: 'buttons',
            options: [{ key: 'yes', label: 'Yes' }],
        }),
    })) as { expiresAt: unknown };
    assert.equal(prompt.expiresAt, null);
    const operation = operations.find((item) => item.name === 'message_delete')!;
    const args = { channelId: ids.channel, messageId: ids.other };
    const controls = { eventId: f.event.id, idempotencyKey: 'durable-approved-delete' };
    const preview = (await bridge.invoke(operation, args, controls)) as { approvalId: string; expiresInSeconds: unknown };
    assert.equal(preview.expiresInSeconds, 604_800);
    assert.equal(
        ((await bridge.invoke(operation, args, controls)) as { approvalId: string }).approvalId,
        preview.approvalId,
        'repeating a request reuses its pending approval',
    );
    now += 24 * 60 * 60_000;
    assert.equal(approvals.confirm(f.event, preview.approvalId), true);
    await assert.rejects(
        bridge.invoke(operation, { ...args, messageId: ids.message }, { ...controls, approvalId: preview.approvalId }),
        /input mismatch/,
    );
    await bridge.invoke(operation, args, { ...controls, approvalId: preview.approvalId });
    assert.throws(() => approvals.assert(preview.approvalId, f.event, {}), /confirmation/);
    f.policy.config.allowedUserIds = [];
    await assert.rejects(
        bridge.prompt({
            eventId: f.event.id,
            idempotencyKey: 'revoked-question',
            ...promptSchema.parse({
                content: 'Denied',
                mode: 'buttons',
                options: [{ key: 'yes', label: 'Yes' }],
            }),
        }),
        /whitelisted/,
    );
}
async function checkRevocations(directory: string): Promise<void> {
    const base = fixture(join(directory, 'revoked-journal.json'));
    const store = new ReplyOrigins(join(directory, 'revoked-origins.json'));
    await store.capture(base.event);
    await store.edit(ids.message, base.event.text);
    assert.equal(store.context(base.event.id).actorId, ids.user, 'unchanged edits keep the request');
    await store.edit(ids.message, 'fixed a typo');
    assert.equal(store.context(base.event.id).text, 'fixed a typo', 'edited requests stay answerable with the new text');
}
