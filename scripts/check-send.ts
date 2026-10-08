import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, ids } from './fixtures.js';
import { requireOwner } from '../src/mcp/owner.js';
import { Bridge } from '../src/core/bridge.js';
import { EventQueue } from '../src/core/queue.js';
import { Sender } from '../src/core/sender.js';
import { readLocalFile, safeFileName } from '../src/media/local-files.js';
import { png } from './check-media.js';

type Fixture = ReturnType<typeof fixture>;
const files = (f: Fixture) => f.api.calls.filter((call) => call.method === 'FILES');

async function checkChannels(f: Fixture): Promise<void> {
    f.policy.config.channels.blocked = [ids.other];
    await assert.rejects(
        f.bridge.proactive({ channelId: ids.other, content: 'Denied', idempotencyKey: 'denied-post' }),
        /Channel or thread is not approved/,
        'Messages can go anywhere Discordinator may respond, and nowhere else',
    );
    f.policy.config.channels.blocked = [];
    await assert.rejects(
        f.bridge.proactive({ channelId: ids.channel, content: 'Denied', idempotencyKey: 'denied-mention', notifyUserId: ids.denied }),
        /whitelisted/,
    );
    const message = { channelId: ids.channel, content: `<@${ids.user}> Done`, idempotencyKey: 'approved-post', notifyUserId: ids.user };
    await f.bridge.proactive(message);
    await f.bridge.proactive(message);
    assert.equal(f.api.calls.length, 1);
    assert.equal(Object.hasOwn(f.api.calls[0]!.body as object, 'message_reference'), false);
    assert.deepEqual((f.api.calls[0]!.body as { allowed_mentions: unknown }).allowed_mentions, {
        parse: [],
        replied_user: false,
        users: [ids.user],
    });
}

async function checkWithoutRequest(f: Fixture): Promise<void> {
    let now = 0;
    const queue = new EventQueue(5, 10, () => now);
    const bridge = new Bridge(f.policy, queue, f.journal, f.api);
    await bridge.proactive({ channelId: ids.channel, content: 'No request required', idempotencyKey: 'post-empty-queue' });
    const event = queue.add('old-request', {
        actorId: ids.user,
        channelId: ids.channel,
        guildId: ids.guild,
        messageId: ids.message,
        kind: 'message',
        text: 'Old request',
    })!;
    now = 24 * 60 * 60_000;
    assert.equal(queue.context(event.id).event.id, event.id, 'time alone never makes a request unanswerable');
    await bridge.proactive({ channelId: ids.channel, content: 'Posting needs no reply', idempotencyKey: 'post-old-queue' });
    for (const call of f.api.calls.slice(-2)) assert.equal(Object.hasOwn(call.body as object, 'message_reference'), false);
}

async function checkSender(f: Fixture, root: string): Promise<void> {
    const sender = new Sender(f.bridge);
    const file = await readLocalFile(join(root, 'pixel.png'), 1024, [root]);
    const base = { content: 'Result', files: [file] };
    assert.throws(() => sender.send({ ...base, idempotencyKey: 'no-target' }), /exactly one/);
    assert.throws(() => sender.send({ ...base, channelId: ids.channel, userId: ids.user, idempotencyKey: 'two-targets' }), /exactly one/);
    assert.throws(() => sender.send({ channelId: ids.channel, content: '', files: [], idempotencyKey: 'empty' }), /needs text/);
    const post = { ...base, channelId: ids.channel, notifyUserId: ids.user, idempotencyKey: 'send-post-file' };
    await sender.send(post);
    await sender.send(post);
    assert.equal(files(f).length, 1, 'Retries with the same key send once');
    const posted = files(f)[0]!.body as { body: { content: string; allowed_mentions: unknown }; files: { data: Buffer }[] };
    assert.equal(posted.body.content, `<@${ids.user}> Result`);
    assert.ok(posted.files[0]!.data.equals(png));
    await assert.rejects(sender.send({ ...post, content: 'Changed' }), /different/);
    f.policy.config.channels.blocked = [ids.other];
    await assert.rejects(sender.send({ ...base, channelId: ids.other, idempotencyKey: 'send-blocked' }), /not approved/);
    f.policy.config.channels.blocked = [];
    await sender.send({ ...base, userId: ids.user, idempotencyKey: 'send-dm-file' });
    assert.equal(f.api.calls.findLast((call) => call.route === '/users/@me/channels')?.method, 'POST');
    assert.equal(files(f).length, 2, 'Approved people can be sent files by DM');
    await assert.rejects(sender.send({ ...base, userId: ids.denied, idempotencyKey: 'send-dm-denied' }), /whitelisted|approved/);
    await checkReplies(f, sender, base);
}

async function checkReplies(f: Fixture, sender: Sender, base: { content: string; files: Awaited<ReturnType<typeof readLocalFile>>[] }) {
    await assert.rejects(
        sender.send({ ...base, eventId: f.event.id, notifyUserId: ids.other, idempotencyKey: 'reply-ping-other' }),
        /only ping the person who asked/,
    );
    await sender.send({ ...base, eventId: f.event.id, notifyUserId: ids.user, idempotencyKey: 'reply-file' });
    const reply = files(f).at(-1)!.body as { body: { message_reference: { message_id: string } } };
    assert.equal(reply.body.message_reference.message_id, ids.message, 'Replies with files stay in the request conversation');
    await sender.send({ eventId: f.event.id, content: 'Working on it', files: [], progress: true, idempotencyKey: 'reply-progress' });
    const progress = f.api.calls.at(-1)!;
    assert.equal(progress.method, 'POST', 'After a reply with files, progress gets its own reply');
}

async function checkLocalFiles(root: string): Promise<void> {
    assert.equal(safeFileName('../my report?.png'), 'my report-.png');
    assert.equal(safeFileName(`${'a'.repeat(150)}.png`).length, 100);
    const outside = resolve(root, '..', 'outside.png');
    await writeFile(outside, png);
    await symlink(outside, join(root, 'link.png'));
    await mkdir(join(root, 'folder'));
    await assert.rejects(readLocalFile(outside, 1024, [root]), /Only files inside/);
    await assert.rejects(readLocalFile(join(root, 'link.png'), 1024, [root]), /Only files inside/, 'Symlinks cannot escape');
    await assert.rejects(readLocalFile(join(root, 'missing.png'), 1024, [root]), /File not found: missing.png/);
    await assert.rejects(readLocalFile(join(root, 'folder'), 1024, [root]), /regular files/);
    await assert.rejects(readLocalFile(join(root, 'pixel.png'), 10, [root]), /file limit/);
    const read = await readLocalFile(join(root, 'pixel.png'), 1024, [root]);
    assert.deepEqual([read.name, read.contentType], ['pixel.png', 'image/png']);
    await assert.rejects(readLocalFile(join(root, 'pixel.png'), 1024), /Only files inside/, 'By default only the temp folder is readable');
}

export async function checkSend(directory: string): Promise<void> {
    assert.throws(() => requireOwner(undefined), /Authenticated owner/);
    assert.throws(() => requireOwner(), /Authenticated owner/);
    assert.doesNotThrow(() => requireOwner({ id: 'oauth:verified-owner' }));
    const root = join(directory, 'send-files');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'pixel.png'), png);
    await checkLocalFiles(root);
    const f = fixture(join(directory, 'send.json'));
    f.policy.config.media.enabled = true;
    f.policy.config.scopes.push('media.write');
    await checkChannels(f);
    await checkWithoutRequest(f);
    await checkSender(f, root);
}
