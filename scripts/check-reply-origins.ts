import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, ids } from './fixtures.js';
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
        replied_user: false,
        users: [ids.user],
    });
    const restartedJournal = new Journal(journal.file, 16384, () => now + 5 * 24 * 60 * 60_000, week);
    await restartedJournal.load();
    const restarted = new Bridge(base.policy, queue, base.journal, base.approvals, base.api, restored, restartedJournal);
    await restarted.respond(input);
    assert.equal(base.api.calls.filter((call) => call.method === 'POST').length, 1, 'reply dedup survives a restart within its retention');
    await assert.rejects(restarted.respond({ ...input, content: 'changed' }), /different input/);
    base.api.message = () =>
        Promise.resolve({ id: ids.message, channel_id: ids.other, author: { id: ids.user }, content: base.event.text });
    await assert.rejects(restarted.respond({ ...input, idempotencyKey: 'wrong-channel-reply' }), /source changed/);
    assert.throws(() => restored.context(base.event.id), /revoked/);
    const afterRevocation = new ReplyOrigins(origins.file);
    await afterRevocation.load();
    assert.throws(() => afterRevocation.context(base.event.id), /revoked/);
    await checkRevocations(directory);
    await checkDurableActions(directory);
}
async function checkDurableActions(directory: string): Promise<void> {
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
    await store.revokeMessage('900000000000000001');
    assert.equal(store.context(base.event.id).text, 'fixed a typo', 'unrelated deletions change nothing');
    const other = new ReplyOrigins(join(directory, 'deleted-origins.json'));
    await other.capture(base.event);
    await other.revokeMessage(ids.message);
    assert.throws(() => other.context(base.event.id), /revoked/);
}
