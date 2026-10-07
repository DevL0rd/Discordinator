import assert from 'node:assert/strict';
import { join } from 'node:path';
import { inspectFile } from '../src/media/formats.js';
import { jumpUrl, matches, searchSchema, type Entry } from '../src/media/index.js';
import { MediaService } from '../src/media/service.js';
import { fileAccess, fileBucket, Uploads } from '../src/media/uploads.js';
import { fixture, ids } from './fixtures.js';
import { mediaFixture, message, png } from './check-media.js';

async function checkTextFormats(): Promise<void> {
    await assert.rejects(inspectFile(Buffer.from('bell\u0007'), 'notes.txt'), /binary control bytes/);
    await assert.rejects(inspectFile(Buffer.from('plain'), 'notes.xyz'), /Unsupported file format/);
    assert.equal(await inspectFile(Buffer.from('# Title\n\tindented\r\n'), 'notes.md'), 'text/markdown', 'Text types follow the extension');
}

function checkFilters(): void {
    const entry = (filename: string, contentType?: string): Entry => ({
        attachment: { id: ids.message, filename, size: 1, url: 'https://cdn.discordapp.com/x', content_type: contentType },
        messageId: ids.message,
        channelId: ids.channel,
        guildId: null,
        userId: ids.user,
        timestamp: '2026-01-02T00:00:00.000Z',
        storedAt: 0,
    });
    const search = (filters: Record<string, unknown>) => searchSchema.parse({ eventId: crypto.randomUUID(), ...filters });
    const photo = entry('photo.JPG');
    const report = entry('report.pdf', 'application/pdf');
    assert.equal(matches(photo, search({ kind: 'image' })), true, 'Images are recognized by extension without a MIME type');
    assert.equal(matches(photo, search({ kind: 'file' })), false);
    assert.equal(matches(report, search({ kind: 'image' })), false);
    assert.equal(matches(report, search({ kind: 'file' })), true);
    assert.equal(matches(report, search({ userId: ids.denied })), false);
    assert.equal(matches(report, search({ messageId: ids.other })), false);
    assert.equal(matches(report, search({ attachmentIds: [ids.other] })), false);
    assert.equal(matches(report, search({ attachmentIds: [ids.message] })), true);
    assert.equal(matches(report, search({ from: '2026-01-03T00:00:00Z' })), false);
    assert.equal(matches(report, search({ to: '2026-01-01T00:00:00Z' })), false);
    assert.equal(matches(report, search({ from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' })), true);
    assert.equal(jumpUrl(report), `https://discord.com/channels/@me/${ids.channel}/${ids.message}`, 'DM links use @me');
}

async function checkHistory(directory: string): Promise<void> {
    const f = mediaFixture(join(directory, 'media-history.json'));
    const single = await f.media.history({ eventId: f.event.id, messageId: ids.message, pageSize: 25, limit: 10, kind: 'all' });
    assert.equal(f.api.calls.at(-1)?.route, `/channels/${ids.channel}/messages/${ids.message}`, 'A message id reads one message');
    assert.equal(single.attachments.length, 1);
    assert.equal(single.nextBefore, null);
    await f.media.history({ eventId: f.event.id, channelId: ids.channel, before: ids.other, pageSize: 5, limit: 10, kind: 'all' });
    const paged = f.api.calls.at(-1) as { route: string };
    assert.equal(paged.route, `/channels/${ids.channel}/messages`);
    f.api.record = { ...message(), channel_id: ids.other };
    await assert.rejects(
        f.media.history({ eventId: f.event.id, pageSize: 25, limit: 10, kind: 'all' }),
        /history source mismatch/,
        'History pages from another channel are refused',
    );
    const dm = f.queue.add('dm-history', { ...f.event, guildId: null })!;
    assert.equal(await f.access.channel(dm.id, ids.channel), null, 'DM media stays in its DM');
}

async function checkReads(directory: string): Promise<void> {
    const f = mediaFixture(join(directory, 'media-reads.json'));
    const release: (() => void)[] = [];
    let short = false;
    const media = new MediaService(f.access, () => {
        if (short) return Promise.resolve(png.subarray(1));
        return new Promise((resolve) => release.push(() => resolve(png)));
    });
    media.index.ingest(message(), ids.guild, false);
    const found = await media.index.search(searchSchema.parse({ eventId: f.event.id }));
    const input = { eventId: f.event.id, sourceId: found.attachments[0]!.sourceId, offset: 0, length: 131072 };
    const pending = [media.read(input), media.read(input), media.read(input)];
    const deadline = Date.now() + 10_000;
    while (release.length < 3) {
        assert.ok(Date.now() < deadline, 'Three downloads start');
        await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(media.read(input), /Too many attachment downloads/);
    for (const resolve of release) resolve();
    for (const read of await Promise.all(pending)) assert.equal(read.size, png.length);
    short = true;
    await assert.rejects(media.read(input), /byte count mismatch/);
    f.policy.config.media.maxFileBytes = png.length - 1;
    await assert.rejects(media.read(input), /exceeds local file limit/);
}

function checkFileBucket(directory: string): void {
    const f = fixture(join(directory, 'file-bucket.json'));
    let now = 0;
    const uploads = new Uploads(fileAccess(f.policy), () => now);
    const upload = { eventId: fileBucket, fileName: 'image.png', mimeType: 'image/png', size: png.length };
    assert.throws(() => uploads.begin({ ...upload, idempotencyKey: 'bucket-scope' }), /Capability is not approved/);
    f.policy.config.scopes.push('media.write');
    f.policy.config.media.enabled = false;
    assert.throws(() => uploads.begin({ ...upload, idempotencyKey: 'bucket-disabled' }), /Media is disabled/);
    f.policy.config.media.enabled = true;
    const first = uploads.begin({ ...upload, idempotencyKey: 'bucket-0' });
    for (let index = 1; index < 16; index++) uploads.begin({ ...upload, idempotencyKey: `bucket-${index}` });
    assert.throws(() => uploads.begin({ ...upload, idempotencyKey: 'bucket-16' }), /limit reached/);
    now = 10 * 60_000;
    assert.throws(() => uploads.get(fileBucket, first.uploadId), /expired/, 'Unsent uploads expire after ten minutes');
    assert.notEqual(uploads.begin({ ...upload, idempotencyKey: 'bucket-0' }).uploadId, first.uploadId, 'Expired keys are reusable');
}

async function checkIndexBounds(directory: string): Promise<void> {
    const f = mediaFixture(join(directory, 'media-index-bounds.json'));
    const index = f.media.index;
    const search = async () => (await index.search(searchSchema.parse({ eventId: f.event.id }))).attachments;
    f.policy.config.media.enabled = false;
    index.ingest(message(), ids.guild, true);
    f.policy.config.media.enabled = true;
    f.policy.config.media.capture = 'addressed';
    index.ingest(message(), ids.guild, false);
    assert.equal((await search()).length, 0, 'Disabled media and unaddressed messages are not indexed');
    f.policy.config.media.capture = 'all';
    index.ingest(message(), ids.guild, false);
    index.ingest({ ...message(), id: ids.channel }, ids.guild, false);
    f.policy.update({ ...f.policy.config, media: { ...f.policy.config.media, maxAttachments: 1 } });
    assert.equal((await search()).length, 1, 'a lower attachment limit applies right away');
    index.ingest(message(), ids.guild, false);
    index.ingest({ ...message(), id: ids.other }, ids.guild, false);
    assert.deepEqual(
        (await search()).map((item) => item.messageId),
        [ids.other],
        'The oldest attachment is evicted at capacity',
    );
    index.ingest(message(), ids.other, false);
    assert.deepEqual(
        (await search()).map((item) => item.messageId),
        [],
        'Attachments from another guild stay hidden',
    );
    const foreign = index.records(message(), ids.other)[0]!;
    assert.throws(() => index.expose(f.event.id, foreign), /outside current resource grants/);
    const stale = { ...index.records(message(), ids.guild)[0]!, storedAt: 0 };
    assert.throws(() => index.expose(f.event.id, stale), /outside current resource grants/, 'Expired entries are never exposed');
    const dm = f.queue.add('dm-index', { ...f.event, guildId: null })!;
    const elsewhere = { ...index.records({ ...message(), channel_id: ids.other }, null)[0]! };
    assert.throws(() => index.expose(dm.id, elsewhere), /outside current resource grants/, 'DM media stays in its own DM');
}

export async function checkMediaEdges(directory: string): Promise<void> {
    await checkTextFormats();
    checkFilters();
    await checkHistory(directory);
    await checkReads(directory);
    checkFileBucket(directory);
    await checkIndexBounds(directory);
}
