import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { attachmentResult } from '../src/mcp/media.js';
import { searchSchema } from '../src/media/index.js';
import { guarded } from '../src/mcp/tools.js';
import { ids } from './fixtures.js';
import { mediaFixture, message, png } from './check-media.js';

async function checkEviction(file: string): Promise<void> {
    const f = mediaFixture(file);
    const index = f.media.index;
    index.ingest(message(), ids.guild, false);
    index.ingest({ ...message(), id: ids.other }, ids.guild, false);
    const input = searchSchema.parse({ eventId: f.event.id, limit: 1 });
    const first = await index.search(input);
    for (let page = 0; page < 16; page++) await index.search(input);
    await assert.rejects(() => index.search({ ...input, cursor: first.nextCursor! }), /Cursor expired/, 'The oldest page makes room');
    const latest = await index.search(input);
    assert.equal((await index.search({ ...input, cursor: latest.nextCursor! })).attachments.length, 1);
    const entry = index.source(f.event.id, latest.attachments[0]!.sourceId);
    for (let handle = 0; handle < 1000; handle++) index.expose(f.event.id, entry);
    assert.throws(() => index.source(f.event.id, first.attachments[0]!.sourceId), /expired/, 'The oldest handle makes room');
}

async function checkUndeclaredHash(file: string): Promise<void> {
    const f = mediaFixture(file);
    const uploads = f.bridge.media.uploads;
    const input = { eventId: f.event.id, fileName: 'image.png', mimeType: 'image/png', size: png.length };
    const started = uploads.begin({ ...input, idempotencyKey: 'undeclared-hash' });
    uploads.chunk({ eventId: f.event.id, uploadId: started.uploadId, offset: 0, base64: png.toString('base64') });
    const sealed = await uploads.seal(f.event.id, started.uploadId);
    assert.equal(sealed.sha256, createHash('sha256').update(png).digest('hex'), 'Sealing computes the hash');
    assert.equal(uploads.ready(f.event.id, [started.uploadId])[0]!.sha256, sealed.sha256);
    const wrong = uploads.begin({ ...input, sha256: 'a'.repeat(64), idempotencyKey: 'declared-wrong-hash' });
    uploads.chunk({ eventId: f.event.id, uploadId: wrong.uploadId, offset: 0, base64: png.toString('base64') });
    await assert.rejects(() => uploads.seal(f.event.id, wrong.uploadId), /hash mismatch/, 'A declared hash is still verified');
}

async function checkImageResult(): Promise<void> {
    const base64 = png.toString('base64');
    const image = attachmentResult(
        await guarded(() => Promise.resolve({ mimeType: 'image/png', base64, complete: true, imageTypeVerified: true })),
    );
    const [described, attached] = image.content as [{ text: string }, unknown];
    assert.deepEqual(attached, { type: 'image', data: base64, mimeType: 'image/png' });
    assert.ok(!described.text.includes(base64), 'Image bytes are not repeated in the JSON text');
    assert.equal((JSON.parse(described.text) as { imageContent: boolean }).imageContent, true);
    const partial = await guarded(() => Promise.resolve({ mimeType: 'image/png', base64, complete: false, imageTypeVerified: true }));
    assert.equal(attachmentResult(partial), partial, 'Partial chunks keep their base64 text');
}

export async function checkMediaLimits(directory: string): Promise<void> {
    await checkEviction(`${directory}/media-eviction.json`);
    await checkUndeclaredHash(`${directory}/media-hash.json`);
    await checkImageResult();
}
