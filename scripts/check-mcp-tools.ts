import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localCall } from '../src/mcp/local-client.js';
import { guarded } from '../src/mcp/tools.js';
import { fixture, ids } from './fixtures.js';
import { key, localServer } from './check-channel.js';
import { observed } from './check-context.js';
import { png } from './check-media.js';

type Fixture = ReturnType<typeof fixture>;
const foreignRejection = { then: (_resolve: unknown, reject: (reason: string) => void) => reject('raw') } as unknown as Promise<unknown>;
const pixel = png;

export function caller(base: string) {
    return async (name: string, args: Record<string, unknown>) => {
        const result = await localCall({ base, key }, 'tools/call', { name, arguments: args });
        const text = (result.content as { text: string }[])[0]!.text;
        return { failed: result.isError === true, text, value: <T>() => JSON.parse(text) as T };
    };
}
type Call = ReturnType<typeof caller>;

async function checkSendTools(call: Call, f: Fixture): Promise<void> {
    f.policy.config.media.enabled = true;
    f.policy.config.scopes.push('media.write');
    const begun = await call('media_upload_begin', {
        fileName: 'pixel.png',
        mimeType: 'image/png',
        size: pixel.length,
        sha256: createHash('sha256').update(pixel).digest('hex'),
        idempotencyKey: 'mcp-upload',
    });
    assert.equal(begun.failed, false, begun.text);
    const { uploadId } = begun.value<{ uploadId: string }>();
    const chunk = await call('media_upload_chunk', { uploadId, offset: 0, base64: pixel.toString('base64') });
    assert.equal(chunk.failed, false, chunk.text);
    const sealed = await call('media_upload_seal', { uploadId });
    assert.equal(sealed.failed, false, sealed.text);
    const sent = await call('discord_send', {
        channelId: ids.channel,
        content: 'Rendered result',
        files: [{ uploadId }],
        idempotencyKey: 'mcp-send-upload',
    });
    assert.equal(sent.failed, false, sent.text);
    assert.equal(f.api.calls.findLast((item) => item.method === 'FILES')?.route, `/channels/${ids.channel}/messages`);
    const folder = await mkdtemp(join(tmpdir(), 'discordinator-send-'));
    try {
        await writeFile(join(folder, 'shot.png'), pixel);
        const local = await call('discord_send', {
            userId: ids.user,
            content: 'Screenshot',
            files: [{ path: join(folder, 'shot.png') }],
            idempotencyKey: 'mcp-send-path',
        });
        assert.equal(local.failed, false, local.text);
        const posted = f.api.calls.findLast((item) => item.method === 'FILES')!.body as { files: { name: string }[] };
        assert.equal(posted.files[0]!.name, 'shot.png', 'Local clients can send a temp file by path');
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
    const outside = await call('discord_send', {
        channelId: ids.channel,
        files: [{ path: resolve('package.json') }],
        idempotencyKey: 'mcp-send-outside',
    });
    assert.deepEqual([outside.failed, /Only files inside/.test(outside.text)], [true, true], 'Paths outside the temp folder are refused');
}

async function checkOwnerMessages(call: Call, f: Fixture): Promise<void> {
    const dm = await call('discord_send', { userId: ids.user, content: 'Build finished', idempotencyKey: 'mcp-owner-dm' });
    assert.equal(dm.failed, false, dm.text);
    assert.deepEqual(f.api.calls.find((item) => item.route === '/users/@me/channels')?.body, { recipient_id: ids.user });
    const denied = await call('discord_send', { userId: ids.denied, content: 'Nope', idempotencyKey: 'mcp-denied-dm' });
    assert.equal(denied.failed, true, 'Unapproved people cannot be messaged');
    f.policy.config.scopes.push('messages.read', 'reactions.write');
    const read = await call('discord_message_get', { channelId: ids.channel, messageId: ids.message });
    assert.equal(read.failed, false, read.text);
    assert.equal(f.api.calls.at(-1)?.route, `/channels/${ids.channel}/messages/${ids.message}`);
    const reacted = await call('discord_reaction_add', {
        eventId: f.event.id,
        channelId: ids.channel,
        messageId: ids.message,
        emoji: '👍',
        idempotencyKey: 'mcp-reaction-add',
    });
    assert.equal(reacted.failed, false, reacted.text);
    assert.equal(f.api.calls.at(-1)?.method, 'PUT', 'Mutating catalog operations run with their captured request');
}

async function checkContextAndPolling(call: Call, f: Fixture): Promise<void> {
    f.policy.config.context = { enabled: true, capture: 'all', reach: 'channel', perChannel: 10, includeBots: false };
    f.bridge.context.ingest(observed({ text: 'earlier context' }), false);
    const recent = await call('context_recent', { eventId: f.event.id });
    assert.equal(recent.failed, false, recent.text);
    assert.deepEqual(
        recent.value<{ records: { text: string }[] }>().records.map((item) => item.text),
        ['earlier context'],
    );
    const origin = { channelId: ids.channel, guildId: ids.guild, messageId: ids.message, kind: 'message' as const };
    const hidden = f.queue.add('denied-actor', { ...origin, actorId: ids.denied, text: 'not approved' })!;
    const page = await call('events_poll', { after: f.event.cursor });
    assert.deepEqual(page.value<{ events: unknown[] }>().events, [], 'Events from people who are no longer approved are withheld');
    for (let index = 0; index < 25; index++) f.queue.add(`bulky-${index}`, { ...origin, actorId: ids.user, text: '\u0001'.repeat(4000) });
    const bulky = await call('events_poll', { after: hidden.cursor });
    assert.equal(bulky.failed, true);
    assert.match(bulky.text, /Result exceeds output limit/);
}

async function checkSettingsTool(call: Call, directory: string): Promise<void> {
    const home = resolve(directory, 'settings-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.env'), 'DISCORD_BOT_TOKEN=fixture-not-a-real-token\nDISCORDINATOR_MCP_TOKEN=\n');
    const previous = process.cwd();
    process.chdir(home);
    try {
        const unknown = await call('discordinator_settings_update', { changes: [{ id: 'not-a-setting', value: true }] });
        assert.equal(unknown.failed, true);
        assert.equal(unknown.text, 'Unknown setting not-a-setting');
        const listed = (await call('discordinator_settings', {})).value<{ label: string; value: unknown; editable: boolean }[]>();
        const shown = (label: string) => listed.find((item) => item.label === label)?.value;
        assert.equal(shown('Discord bot credential'), 'set', 'Credentials only show that they are set');
        assert.equal(shown('Bearer credential'), 'not set');
        assert.ok(!JSON.stringify(listed).includes('fixture-not-a-real-token'), 'Credential values are never returned');
        assert.equal(listed.find((item) => item.label === 'Owner')?.editable, true, 'The owner is editable through settings');
        const owner = await call('discordinator_settings_update', { changes: [{ id: 'policy.ownerUserId', value: ids.denied }] });
        assert.deepEqual([owner.failed, owner.text], [true, 'The owner must be one of the approved people.']);
    } finally {
        process.chdir(previous);
    }
}

export async function checkMcpTools(directory: string): Promise<void> {
    const { f, http, base } = await localServer(join(directory, 'mcp-tools.json'));
    const call = caller(base);
    assert.deepEqual(await guarded(() => foreignRejection), {
        content: [{ type: 'text', text: 'Operation failed' }],
        isError: true,
    });
    try {
        await checkSendTools(call, f);
        await checkOwnerMessages(call, f);
        await checkContextAndPolling(call, f);
        await checkSettingsTool(call, directory);
    } finally {
        await http.stop();
    }
}
