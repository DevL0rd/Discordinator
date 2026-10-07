import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Events, GatewayIntentBits, type Message } from 'discord.js';
import { ReplyOrigins } from '../src/core/reply-origins.js';
import { commandDefinitions } from '../src/discord/commands.js';
import { gatewayIntents } from '../src/discord/gateway.js';
import { observe, observeRaw } from '../src/discord/observation.js';
import { fakeConfig, ids } from './fixtures.js';
import { createdAt, fakeMessage, gatewayHarness, snowflakeId, until } from './discord-fakes.js';

const role = '900000000000000001';
const thread = '888888888888888888';

async function checkRemovals(directory: string): Promise<void> {
    const origins = new ReplyOrigins(join(directory, 'lifecycle-origins.json'));
    const h = gatewayHarness(join(directory, 'lifecycle-removals.json'), { replyOrigins: origins });
    await h.gateway.message(fakeMessage({ id: snowflakeId(1) }));
    await h.gateway.message(fakeMessage({ id: snowflakeId(2) }));
    const [first, second] = h.queued().slice(-2);
    h.gateway.client.emit(Events.MessageDelete, fakeMessage({ id: snowflakeId(1) }) as never);
    await until(() => !hasOrigin(origins, first!.id), 'the deleted request to be revoked');
    h.gateway.client.emit(
        Events.MessageBulkDelete,
        new Map([
            [snowflakeId(2), {}],
            [snowflakeId(3), {}],
        ]) as never,
        {} as never,
    );
    await until(() => !hasOrigin(origins, second!.id), 'the bulk-deleted request to be revoked');
    assert.deepEqual(h.context.removed, [snowflakeId(1), snowflakeId(2), snowflakeId(3)]);
    assert.deepEqual(h.media.removed, [snowflakeId(1), snowflakeId(2), snowflakeId(3)]);
    h.gateway.stop();
}

function hasOrigin(origins: ReplyOrigins, id: string): boolean {
    try {
        origins.context(id);
        return true;
    } catch {
        return false;
    }
}

async function checkEdits(directory: string): Promise<void> {
    const origins = new ReplyOrigins(join(directory, 'lifecycle-edit-origins.json'));
    const config = { ...fakeConfig(), DISCORDINATOR_MESSAGE_CONTENT: 'false' as const };
    const h = gatewayHarness(join(directory, 'lifecycle-edits.json'), { replyOrigins: origins }, config);
    const id = snowflakeId(10);
    await h.gateway.message(fakeMessage({ id }));
    const event = h.queued().at(-1)!;
    const attached = new Map([['a1', { id: 'a1', name: 'a.png', size: 1, contentType: 'image/png', url: 'https://cdn.example/a.png' }]]);
    const update = (old: Record<string, unknown>, next: Record<string, unknown>) =>
        h.gateway.client.emit(Events.MessageUpdate, fakeMessage({ id, ...old }) as never, fakeMessage({ id, ...next }) as never);
    update({}, { partial: true, content: 'ignored' });
    assert.deepEqual(h.context.updated, [], 'partial edits are ignored');
    update({}, { content: 'Discordinator edited' });
    await until(() => origins.context(event.id).text === 'Discordinator edited', 'the captured request text to follow the edit');
    update({ partial: true }, { content: 'again', attachments: attached });
    update({ attachments: attached }, { content: 'again', attachments: attached });
    assert.deepEqual(h.media.removed, [], 'unchanged or unknown attachments keep their media entries');
    update({}, { content: 'with file', attachments: attached, guildId: null });
    await until(() => origins.context(event.id).text === 'with file', 'every edit to be saved');
    assert.deepEqual(h.media.removed, [id]);
    assert.deepEqual(h.media.ingested.at(-1)!.slice(1), [null, false], 'new attachments are indexed as unaddressed');
    assert.deepEqual(
        h.context.updated.map((args) => args[2]),
        [false, false, false, true],
        'edited text is only available with the content intent or in direct messages',
    );
    h.gateway.stop();
}

function checkMembership(file: string): void {
    const h = gatewayHarness(file);
    h.policy.config.allowedRoleIds.push(role);
    h.policy.config.channels = { mode: 'allowlist', allowed: [ids.channel], blocked: [] };
    const member = (roles: string[]) => ({
        id: ids.denied,
        guild: { id: ids.guild },
        roles: { cache: new Map(roles.map((id) => [id, {}])) },
    });
    h.gateway.client.emit(Events.GuildMemberUpdate, member([]) as never, member([role]) as never);
    assert.equal(h.policy.userAllowed(ids.denied), true, 'gaining an approved role grants access');
    h.gateway.client.emit(Events.GuildMemberRemove, member([role]) as never);
    assert.equal(h.policy.userAllowed(ids.denied), false, 'leaving the server revokes role access');
    h.gateway.client.emit(Events.ThreadCreate, { id: '989898989898989898', parentId: null } as never, true);
    h.gateway.client.emit(Events.ThreadCreate, { id: thread, parentId: ids.channel } as never, true);
    assert.equal(h.policy.channelAllowed('989898989898989898'), false);
    assert.equal(h.policy.channelAllowed(thread), true, 'new threads inherit their parent approval');
    h.gateway.stop();
}

async function checkStates(file: string): Promise<void> {
    const h = gatewayHarness(file, { commands: () => Promise.resolve({ title: 'ok', lines: [], tone: 'info' }) });
    const states: string[] = [];
    h.gateway.onState = () => states.push(h.gateway.status().gateway);
    const application = '161616161616161616';
    h.gateway.client.emit(Events.ClientReady, { user: { id: '171717171717171717' }, application: { id: application } } as never);
    assert.deepEqual([h.api.botId, h.api.applicationId], ['171717171717171717', application]);
    await until(() => h.api.calls.length > 0, 'commands to be registered');
    assert.deepEqual(h.api.calls[0], { method: 'PUT', route: `/applications/${application}/commands`, body: commandDefinitions });
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
        for (const event of [
            Events.ShardReconnecting,
            Events.ShardResume,
            Events.ShardDisconnect,
            Events.ShardReady,
            Events.ShardError,
            Events.Error,
        ])
            h.gateway.client.emit(event as never, new Error('offline') as never, 0 as never);
    } finally {
        console.error = realError;
    }
    assert.deepEqual(states, ['ready', 'reconnecting', 'ready', 'disconnected', 'ready', 'error', 'error']);
    assert.match(String(errors), /inspect configuration and connectivity/);
    h.gateway.stop();
    assert.deepEqual(h.gateway.status(), { gateway: 'offline', droppedMessages: 0 });
    assert.equal(states.at(-1), 'offline');
}

async function checkStart(file: string): Promise<void> {
    const h = gatewayHarness(file);
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
        await assert.rejects(h.gateway.start(), /token/i, 'an empty token fails before connecting');
        assert.deepEqual(errors, []);
        const client = h.gateway.client as unknown as { login: () => Promise<string> };
        client.login = () => Promise.reject(new Error('Used disallowed intents'));
        await assert.rejects(h.gateway.start(), /disallowed intents/);
        assert.match(String(errors), /Message Content Intent and Server Members Intent/);
        const plain = 'closed' as unknown as Error;
        client.login = () => Promise.reject(plain);
        await assert.rejects(h.gateway.start(), (error) => error === 'closed');
        assert.equal(errors.length, 1);
        client.login = () => Promise.resolve('ok');
        await h.gateway.start();
    } finally {
        console.error = realError;
        h.gateway.stop();
    }
}

function checkObservation(): void {
    const intents = gatewayIntents({ ...fakeConfig(), DISCORDINATOR_GUILD_MEMBERS: 'true' });
    assert.ok(intents.includes(GatewayIntentBits.GuildMembers) && intents.includes(GatewayIntentBits.MessageContent));
    const empty = fakeMessage({ content: '', createdTimestamp: null, channel: { isThread: () => false, parentId: ids.other } });
    const before = Date.now();
    const seen = observe(empty, false);
    assert.equal(seen.contentAvailable, false, 'guild text without the content intent is unavailable');
    assert.equal(seen.parentId, null, 'only threads have parents');
    assert.ok(Date.parse(seen.timestamp) >= before - 1000, 'a missing timestamp falls back to now');
    assert.equal(observe({ ...empty, guildId: null } as Message, false).contentAvailable, true);
    assert.equal(observe(empty, true).contentAvailable, true);
    assert.equal(observe(fakeMessage({ content: 'text' }), false).timestamp, new Date(createdAt).toISOString());
    const raw = {
        id: ids.message,
        channel_id: ids.channel,
        content: '',
        timestamp: '2026-10-07T00:00:00Z',
        author: { id: ids.bot, bot: true },
    };
    assert.deepEqual(observeRaw(raw, ids.guild, thread), {
        actorId: ids.bot,
        author: { id: ids.bot, username: null, globalName: null, nickname: null },
        mentions: [],
        authorBot: true,
        channelId: ids.channel,
        guildId: ids.guild,
        messageId: ids.message,
        text: '',
        timestamp: '2026-10-07T00:00:00.000Z',
        contentAvailable: false,
        parentId: thread,
        replyToId: null,
    });
    const human = observeRaw({ ...raw, author: { id: ids.user }, message_reference: { message_id: ids.other } }, null, null);
    assert.deepEqual([human.authorBot, human.contentAvailable, human.replyToId], [false, true, ids.other]);
}

export async function checkGatewayLifecycle(directory: string): Promise<void> {
    checkObservation();
    await checkRemovals(directory);
    await checkEdits(directory);
    checkMembership(join(directory, 'lifecycle-members.json'));
    await checkStates(join(directory, 'lifecycle-states.json'));
    await checkStart(join(directory, 'lifecycle-start.json'));
}
