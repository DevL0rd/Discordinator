import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Bridge } from '../src/core/bridge.js';
import { EventQueue } from '../src/core/queue.js';
import { promptSchema } from '../src/interactions/schema.js';
import { fixture, ids } from './fixtures.js';
import { operations } from '../src/discord/catalog.js';
import { OwnerContexts } from '../src/core/authorization.js';

async function checkContextReuse(f: ReturnType<typeof fixture>): Promise<void> {
    const contexts = new OwnerContexts(f.policy, f.api);
    const requesters = Array.from({ length: 1002 }, (_, index) => String(200_000_000_000_000_000n + BigInt(index)));
    f.policy.config.allowedUserIds.push(...requesters);
    await contexts.run(true, async () => {
        const first = await contexts.create(ids.channel, requesters[0]!);
        assert.equal((await contexts.create(ids.channel, requesters[0]!)).contextId, first.contextId, 'The same pair reuses its context');
        const second = await contexts.create(ids.channel, requesters[1]!);
        const third = await contexts.create(ids.channel, requesters[2]!);
        for (const requester of requesters.slice(3, 1000)) await contexts.create(ids.channel, requester);
        assert.ok(contexts.get(first.contextId), 'Recently used contexts stay');
        await contexts.create(ids.channel, requesters[1000]!);
        await contexts.create(ids.channel, requesters[1001]!);
        assert.equal(contexts.has(second.contextId), false, 'The least recently used context is evicted');
        assert.equal(contexts.has(third.contextId), false);
        assert.ok(contexts.has(first.contextId));
    });
    f.policy.config.allowedUserIds = f.policy.config.allowedUserIds.filter((id) => !requesters.includes(id));
}

export async function checkOwnerContext(directory: string): Promise<void> {
    const f = fixture(join(directory, 'owner-context.json'));
    f.policy.config.scopes.push('interactions.write', 'messages.read', 'media.read');
    f.policy.config.context.enabled = true;
    f.policy.config.media.enabled = true;
    const queue = new EventQueue();
    const bridge = new Bridge(f.policy, queue, f.journal, f.api);
    await assert.rejects(bridge.authorizeContext(ids.channel, ids.user), /Authenticated owner/);
    await checkContextReuse(f);
    const context = await bridge.withOwner(() => bridge.authorizeContext(ids.channel, ids.user));
    assert.equal(queue.snapshot(0, 25).events.length, 0, 'Authorization does not fabricate a Discord event');
    assert.throws(() => queue.context(context.contextId), /unknown/);
    assert.throws(() => bridge.media.access.event(context.contextId), /Authenticated owner/);
    f.policy.config.channels.blocked = [ids.other];
    await assert.rejects(
        bridge.withOwner(() => bridge.authorizeContext(ids.other, ids.user)),
        /Channel or thread is not approved/,
        'Owner contexts follow the channel rules',
    );
    f.policy.config.channels.blocked = [];
    await assert.rejects(
        bridge.withOwner(() => bridge.authorizeContext(ids.channel, ids.denied)),
        /whitelisted/,
    );
    await bridge.withOwner(async () => {
        assert.equal(bridge.media.access.event(context.contextId).event.kind, 'owner');
        assert.ok(bridge.context.query(context.contextId, 'recent', 1));
        const edit = operations.find((item) => item.name === 'message_edit')!;
        const args = { channelId: ids.channel, messageId: ids.message, content: 'Direct authorized edit' };
        const mutation = { eventId: context.contextId, idempotencyKey: 'owner-direct-edit' };
        await bridge.invoke(edit, args, mutation);
        await assert.rejects(bridge.invoke(edit, { ...args, channelId: ids.other }, mutation), /destination/);
        await bridge.respond({ eventId: context.contextId, content: 'Standalone owner action', idempotencyKey: 'owner-direct-message' });
        await bridge.prompt({
            eventId: context.contextId,
            idempotencyKey: 'owner-direct-question',
            ...promptSchema.parse({
                mode: 'select',
                content: 'Choose any two',
                maxValues: 2,
                options: [
                    { key: 'a', label: 'A' },
                    { key: 'b', label: 'B' },
                ],
            }),
        });
    });
    const sent = f.api.calls.at(-1)!.body as { body: { components: { components: { custom_id: string; max_values: number }[] }[] } };
    assert.equal(Object.hasOwn(sent.body, 'message_reference'), false);
    const selected = sent.body.components[0]!.components[0]!;
    assert.equal(selected.max_values, 2);
    const accepted = bridge.flows.accept({
        customId: selected.custom_id,
        actorId: ids.user,
        channelId: ids.channel,
        guildId: ids.guild,
        applicationId: ids.bot,
        messageId: ids.message,
        messageAuthorId: ids.bot,
        modal: false,
        componentType: 3,
        values: ['a', 'b'],
    });
    assert.equal(accepted.origin.kind, 'owner');
    assert.equal(accepted.text, '{"choices":["a","b"]}');
    await Promise.all([
        bridge.withOwner(async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(bridge.media.access.event(context.contextId).event.actorId, ids.user);
        }),
        (async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.throws(() => bridge.media.access.event(context.contextId), /Authenticated owner/);
        })(),
    ]);
    f.policy.config.allowedUserIds = [];
    await assert.rejects(
        bridge.withOwner(() =>
            bridge.respond({ eventId: context.contextId, content: 'Denied after revocation', idempotencyKey: 'owner-revoked-send' }),
        ),
        /whitelisted/,
    );
}
