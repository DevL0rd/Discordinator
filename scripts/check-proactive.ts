import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fixture, ids } from './fixtures.js';
import { requireOwner } from '../src/mcp/proactive-media.js';
import { Bridge } from '../src/core/bridge.js';
import { EventQueue } from '../src/core/queue.js';

export async function checkProactive(directory: string): Promise<void> {
    assert.throws(() => requireOwner(undefined), /Authenticated owner/);
    assert.throws(() => requireOwner(), /Authenticated owner/);
    assert.doesNotThrow(() => requireOwner({ id: 'oauth:verified-owner' }));
    const f = fixture(join(directory, 'proactive.json'));
    f.policy.config.proactive = [{ channelId: ids.channel, scopes: ['message.send'] }];
    f.policy.config.media.enabled = true;
    f.policy.config.scopes.push('media.write');
    await assert.rejects(
        f.bridge.proactive({ channelId: ids.other, content: 'Denied', idempotencyKey: 'denied-proactive' }),
        /not approved/,
    );
    await assert.rejects(
        f.bridge.proactive({ channelId: ids.channel, content: 'Denied', idempotencyKey: 'denied-mention', notifyUserId: ids.denied }),
        /whitelisted/,
    );
    const message = {
        channelId: ids.channel,
        content: `<@${ids.user}> Done`,
        idempotencyKey: 'approved-proactive',
        notifyUserId: ids.user,
    };
    await f.bridge.proactive(message);
    await f.bridge.proactive(message);
    assert.equal(f.api.calls.length, 1);
    assert.equal(Object.hasOwn(f.api.calls[0]!.body as object, 'message_reference'), false);
    assert.deepEqual((f.api.calls[0]!.body as { allowed_mentions: unknown }).allowed_mentions, {
        parse: [],
        replied_user: false,
        users: [ids.user],
    });
    await checkProactiveMedia(f);
    await checkStandaloneWithoutRequest(f);
}
async function checkStandaloneWithoutRequest(f: ReturnType<typeof fixture>): Promise<void> {
    let now = 0;
    const queue = new EventQueue(5, 10, () => now);
    const bridge = new Bridge(f.policy, queue, f.journal, f.approvals, f.api);
    await bridge.proactive({ channelId: ids.channel, content: 'No request required', idempotencyKey: 'standalone-empty-queue' });
    const event = queue.add('expired-request', {
        actorId: ids.user,
        channelId: ids.channel,
        guildId: ids.guild,
        messageId: ids.message,
        kind: 'message',
        text: 'Old request',
    })!;
    now = 24 * 60 * 60_000;
    assert.throws(() => queue.context(event.id), /expired/);
    await bridge.proactive({ channelId: ids.channel, content: 'No reply deadline', idempotencyKey: 'standalone-expired-queue' });
    for (const call of f.api.calls.slice(-2)) assert.equal(Object.hasOwn(call.body as object, 'message_reference'), false);
}
async function checkProactiveMedia(f: ReturnType<typeof fixture>): Promise<void> {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=', 'base64');
    const upload = {
        channelId: ids.channel,
        fileName: 'image.png',
        mimeType: 'image/png',
        size: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
        idempotencyKey: 'proactive-media-upload',
    };
    assert.throws(() => f.bridge.proactiveUploads.begin({ ...upload, channelId: ids.other }), /not approved/);
    assert.throws(() => f.bridge.proactiveUploads.begin({ ...upload, fileName: '../private.png' }));
    const started = f.bridge.proactiveUploads.begin(upload);
    f.bridge.proactiveUploads.uploads.chunk({
        eventId: started.scopeId,
        uploadId: started.uploadId,
        offset: 0,
        base64: png.toString('base64'),
    });
    await f.bridge.proactiveUploads.uploads.seal(started.scopeId, started.uploadId);
    assert.throws(() => f.bridge.proactiveUploads.ready(ids.other, started.scopeId, [started.uploadId]), /destination mismatch/);
    const input = {
        channelId: ids.channel,
        scopeId: started.scopeId,
        uploadIds: [started.uploadId],
        content: 'Safe image',
        idempotencyKey: 'proactive-safe-media',
    };
    await f.bridge.proactiveMedia(input);
    await f.bridge.proactiveMedia(input);
    assert.equal(f.api.calls.filter((call) => call.method === 'FILES').length, 1);
}
