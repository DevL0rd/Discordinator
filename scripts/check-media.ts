import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { fixture, ids, FakeApi } from './fixtures.js';
import { MediaAccess } from '../src/media/access.js';
import { MediaService } from '../src/media/service.js';
import { attachmentUrl, collect, downloader } from '../src/media/download.js';
import { inspectFile } from '../src/media/formats.js';
import { Uploads } from '../src/media/uploads.js';
import { AttachmentIndex, searchSchema } from '../src/media/index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const attachmentId = '888888888888888888';
function message(bytes = png, filename = 'image.png', mime = 'image/png') {
    return {
        id: ids.message,
        channel_id: ids.channel,
        author: { id: ids.denied },
        timestamp: new Date().toISOString(),
        attachments: [
            {
                id: attachmentId,
                filename,
                size: bytes.length,
                content_type: mime,
                url: `https://cdn.discordapp.com/attachments/${ids.channel}/${attachmentId}/${filename}?ex=fixture`,
            },
        ],
    };
}
class MediaApi extends FakeApi {
    record = message();
    override get(route: string) {
        this.calls.push({ method: 'GET', route });
        return Promise.resolve(route.endsWith('/messages') ? [this.record] : this.record);
    }
}
function mediaFixture(file: string) {
    const f = fixture(file);
    f.policy.config.scopes.push('media.read', 'media.write', 'messages.read');
    f.policy.config.media.enabled = true;
    f.policy.config.media.capture = 'all';
    const api = new MediaApi(f.policy);
    const access = new MediaAccess(f.policy, f.queue, api);
    const media = new MediaService(access, (url) => {
        assert.equal(url.hostname, 'cdn.discordapp.com');
        return Promise.resolve(png);
    });
    return { ...f, api, access, media };
}

async function checkUploads(file: string): Promise<void> {
    const f = mediaFixture(file);
    const uploads = f.bridge.media.uploads;
    const input = {
        eventId: f.event.id,
        fileName: 'image.png',
        mimeType: 'image/png',
        size: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
        idempotencyKey: 'media-upload-fixture',
    };
    const started = uploads.begin(input);
    assert.equal(uploads.begin(input).uploadId, started.uploadId);
    assert.throws(() => uploads.begin({ ...input, sha256: 'a'.repeat(64) }));
    assert.throws(() => uploads.begin({ ...input, fileName: '../private.png' }));
    const chunk = { eventId: f.event.id, uploadId: started.uploadId, offset: 0, base64: png.toString('base64') };
    assert.throws(() => uploads.chunk({ ...chunk, offset: 1 }));
    assert.throws(() => uploads.chunk({ ...chunk, base64: `${chunk.base64}\n` }));
    await assert.rejects(() => uploads.seal(f.event.id, started.uploadId));
    uploads.chunk(chunk);
    uploads.chunk(chunk);
    assert.throws(() => uploads.chunk({ ...chunk, base64: Buffer.alloc(png.length).toString('base64') }));
    await uploads.seal(f.event.id, started.uploadId);
    const reply = {
        eventId: f.event.id,
        content: 'Edited image',
        uploadIds: [started.uploadId],
        sourceIds: [],
        idempotencyKey: 'media-reply-fixture',
    };
    await f.bridge.mediaReply(reply);
    await f.bridge.mediaReply(reply);
    assert.equal(f.api.calls.length, 0);
    assert.equal(f.bridge.api instanceof FakeApi, true);
    const call = (f.bridge.api as FakeApi).calls[0]!;
    const multipart = call.body as { body: { message_reference: unknown; allowed_mentions: unknown }; files: { data: Buffer }[] };
    assert.equal(call.method, 'FILES');
    assert.ok(multipart.files[0]!.data.equals(png));
    assert.deepEqual(multipart.body.allowed_mentions, { parse: [], replied_user: false });
    assert.deepEqual(multipart.body.message_reference, { message_id: ids.message, fail_if_not_exists: true });
    const denied = f.queue.add('denied-media', { ...f.event, actorId: ids.denied })!;
    assert.throws(() => uploads.get(denied.id, started.uploadId));
    assert.equal((f.bridge.api as FakeApi).calls.length, 1);
    checkUploadLimits(f, input);
}

function checkUploadLimits(f: ReturnType<typeof mediaFixture>, input: Parameters<Uploads['begin']>[0]): void {
    let now = Date.now();
    const expiring = new Uploads(f.access, () => now);
    const ephemeral = expiring.begin(input);
    now += 11 * 60_000;
    assert.throws(() => expiring.get(f.event.id, ephemeral.uploadId));
    f.policy.config.media.maxFileBytes = 1;
    assert.throws(() => f.bridge.media.uploads.begin({ ...input, idempotencyKey: 'file-size-denied' }));
}

async function checkLookup(file: string): Promise<void> {
    const f = mediaFixture(file);
    const index = f.media.index;
    const record = message();
    index.ingest(record, ids.guild, false);
    const second = { ...record, id: ids.other, timestamp: new Date(Date.now() - 1000).toISOString() };
    index.ingest(second, ids.guild, false);
    const input = searchSchema.parse({ eventId: f.event.id, kind: 'image', userId: ids.denied, limit: 1 });
    const first = await index.search(input);
    assert.equal(first.coverage, 'bounded-local-index');
    assert.equal(first.incomplete, true);
    assert.equal(first.attachments[0]!.messageId, ids.message);
    assert.ok(first.nextCursor);
    assert.equal('url' in first.attachments[0]!, false);
    const next = await index.search({ ...input, cursor: first.nextCursor });
    assert.equal(next.attachments[0]!.messageId, ids.other);
    await assert.rejects(() => index.search({ ...input, cursor: first.nextCursor!, kind: 'file' }));
    const exact = await index.search(searchSchema.parse({ eventId: f.event.id, messageId: ids.message, attachmentIds: [attachmentId] }));
    assert.equal(exact.attachments.length, 1);
    const none = await index.search(searchSchema.parse({ eventId: f.event.id, from: new Date(Date.now() + 1000).toISOString() }));
    assert.equal(none.attachments.length, 0);
    assert.equal(f.queue.snapshot(0, 25).events.length, 1);
    const history = await f.media.history({ ...input, pageSize: 25 });
    assert.equal(history.coverage, 'discord-channel-history-page');
    assert.equal(history.scannedMessages, 1);
    assert.equal(history.nextBefore, ids.message);
    index.remove(ids.message);
    assert.throws(() => index.source(f.event.id, first.attachments[0]!.sourceId));
    const denied = f.queue.add('denied-read', { ...f.event, actorId: ids.denied })!;
    await assert.rejects(() => index.search({ ...input, eventId: denied.id }));
    await checkIndexLimits(f, record, input);
}

async function checkIndexLimits(
    f: ReturnType<typeof mediaFixture>,
    record: ReturnType<typeof message>,
    input: ReturnType<typeof searchSchema.parse>,
) {
    let now = Date.now();
    const retained = new AttachmentIndex(f.access, () => now);
    retained.ingest(record, ids.guild, false);
    now += 61 * 60_000;
    assert.equal((await retained.search(input)).attachments.length, 0);
    f.policy.config.channels = { mode: 'allowlist', allowed: [ids.channel], blocked: [] };
    await assert.rejects(() => f.media.index.search({ ...input, channelId: ids.other }));
    f.policy.config.channels = { mode: 'blocklist', allowed: [], blocked: [] };
    f.media.index.ingest({ ...record, channel_id: ids.other, id: attachmentId }, ids.guild, false);
    assert.equal((await f.media.index.search({ ...input, channelId: ids.other })).attachments.length, 1);
    assert.equal((await f.media.index.search({ ...input, channelId: undefined, limit: 25 })).attachments.length, 2);
    f.policy.config.channels = { mode: 'allowlist', allowed: [ids.channel], blocked: [] };
    assert.equal((await f.media.index.search({ ...input, limit: 25 })).attachments.length, 1);
}

async function checkRetrieval(file: string): Promise<void> {
    const f = mediaFixture(file);
    const query = searchSchema.parse({ eventId: f.event.id });
    const history = await f.media.history({ ...query, pageSize: 25 });
    const sourceId = history.attachments[0]!.sourceId;
    const input = { eventId: f.event.id, sourceId, offset: 0, length: 10 };
    const chunk = await f.media.read(input);
    assert.equal(chunk.nextOffset, 10);
    assert.equal(chunk.complete, false);
    const whole = await f.media.read({ ...input, length: 131072 });
    assert.equal(whole.complete, true);
    assert.equal(whole.imageTypeVerified, true);
    assert.equal(whole.sha256, createHash('sha256').update(png).digest('hex'));
    await assert.rejects(() => f.media.read({ ...input, offset: png.length }));
    const other = f.queue.add('other-live', { ...f.event })!;
    await assert.rejects(() => f.media.read({ ...input, eventId: other.id }));
    f.api.record.attachments[0]!.url = 'https://127.0.0.1/private';
    await assert.rejects(() => f.media.read(input));
    f.api.record = message();
    f.api.record.author.id = ids.user;
    await assert.rejects(() => f.media.read(input));
    f.api.record = message();
    f.api.record.attachments = [];
    await assert.rejects(() => f.media.read(input));
    const dm = f.queue.add('dm-source', { ...f.event, guildId: null })!;
    await assert.rejects(() => f.access.channel(dm.id, ids.other));
}

async function checkFormats(): Promise<void> {
    await inspectFile(png, 'test.png', 'image/png');
    await inspectFile(gif, 'test.gif', 'image/gif');
    assert.equal(await inspectFile(png, 'photo.edited.png'), 'image/png');
    assert.equal(await inspectFile(Buffer.from('safe text'), 'test.txt', 'text/plain; charset=utf-8'), 'text/plain');
    await inspectFile(Buffer.from('safe text'), 'test.txt', 'text/plain');
    await inspectFile(Buffer.from('{"ok":true}'), 'test.json', 'application/json');
    await assert.rejects(() => inspectFile(png, 'test.gif', 'image/gif'));
    await assert.rejects(() => inspectFile(Buffer.from('<svg/>'), 'test.svg', 'image/svg+xml'));
    await assert.rejects(() => inspectFile(Buffer.from([0xff, 0xfe]), 'test.txt', 'text/plain'));
    await assert.rejects(
        () => inspectFile(Buffer.from('private invalid text'), 'test.json', 'application/json'),
        (error) => {
            assert.equal((error as Error).message.includes('private invalid text'), false);
            return true;
        },
    );
    const giant = Buffer.from(png);
    giant.writeUInt32BE(8193, 16);
    await assert.rejects(() => inspectFile(giant, 'test.png', 'image/png'));
}

async function checkSourceReply(file: string): Promise<void> {
    const f = mediaFixture(file);
    const record = { ...message(), id: ids.other };
    f.bridge.api.get = () => Promise.resolve(record);
    f.bridge.media.index.ingest(record, ids.guild, false);
    const found = await f.bridge.media.index.search(searchSchema.parse({ eventId: f.event.id }));
    const sourceId = found.attachments[0]!.sourceId;
    const input = {
        eventId: f.event.id,
        content: 'Source attached',
        sourceIds: [sourceId],
        uploadIds: [],
        idempotencyKey: 'linked-source-reply',
    };
    await f.bridge.mediaReply(input);
    const sent = (f.bridge.api as FakeApi).calls[0]!.body as { body: { content: string; message_reference: { message_id: string } } };
    assert.ok(sent.body.content.includes(`https://discord.com/channels/${ids.guild}/${ids.channel}/${ids.other}`));
    assert.equal(sent.body.message_reference.message_id, ids.message);
    record.author.id = ids.user;
    await assert.rejects(() => f.bridge.mediaReply({ ...input, idempotencyKey: 'source-changed-reply' }));
    assert.equal((f.bridge.api as FakeApi).calls.length, 1);
    const media = new MediaService(f.access, () => {
        f.policy.config.allowedUserIds = [];
        return Promise.resolve(png);
    });
    const query = searchSchema.parse({ eventId: f.event.id });
    const history = await media.history({ ...query, pageSize: 25 });
    await assert.rejects(
        () => media.read({ eventId: f.event.id, sourceId: history.attachments[0]!.sourceId, offset: 0, length: 100 }),
        /whitelisted/,
    );
}

function streamResponse(status: number, data: Buffer, expected: number): Promise<Buffer> {
    const stream = new PassThrough() as unknown as IncomingMessage;
    Object.assign(stream, { statusCode: status, headers: {} });
    const result = new Promise<Buffer>((resolve, reject) => collect(stream, expected, resolve, reject));
    (stream as unknown as PassThrough).end(data);
    return result;
}
async function checkDownload(): Promise<void> {
    const safe = message().attachments[0]!.url;
    attachmentUrl(safe, ids.channel, attachmentId);
    for (const value of [
        'http://cdn.discordapp.com/file',
        'https://cdn.discordapp.com.evil.example/file',
        'https://user:pass@cdn.discordapp.com/file',
        'https://cdn.discordapp.com:8443/file',
        'https://discord.com/file',
        `https://cdn.discordapp.com/attachments/${ids.other}/${attachmentId}/image.png`,
    ]) {
        assert.throws(() => attachmentUrl(value, ids.channel, attachmentId));
    }
    await assert.rejects(() => downloader(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }]))(new URL(safe), png.length));
    assert.ok((await streamResponse(200, png, png.length)).equals(png));
    await assert.rejects(() => streamResponse(302, png, png.length));
    await assert.rejects(() => streamResponse(200, png, png.length - 1));
    await assert.rejects(() => streamResponse(200, png, png.length + 1));
}

export async function checkMedia(directory: string): Promise<void> {
    await checkUploads(`${directory}/media-upload.json`);
    await checkLookup(`${directory}/media-lookup.json`);
    await checkRetrieval(`${directory}/media-read.json`);
    await checkSourceReply(`${directory}/media-source.json`);
    await checkFormats();
    await checkDownload();
}
