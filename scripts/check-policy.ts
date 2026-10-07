import assert from 'node:assert/strict';
import type { Message, ChatInputCommandInteraction } from 'discord.js';
import { policySchema } from '../src/core/config.js';
import { loadConfig } from '../src/core/config.js';
import { writeFile } from 'node:fs/promises';
import { Policy } from '../src/core/policy.js';
import { Triggers } from '../src/core/triggers.js';
import { Gateway, gatewayIntents } from '../src/discord/gateway.js';
import { ids, fixture, fakeConfig } from './fixtures.js';

function checkTriggers(policy: Policy): void {
    const triggers = new Triggers(policy);
    for (const text of ['Discordinator help', 'DOT, help', '(dot)', 'dot+ help', `<@${ids.bot}> help`, `<@!${ids.bot}> help`]) {
        assert.equal(triggers.accepts(ids.user, text, ids.bot), true);
    }
    for (const text of ['anecdotal', 'dotnet', 'adot', 'dot2', '_dot_', 'éDiscordinator', 'dotЖ', 'ordinary chat']) {
        assert.equal(triggers.accepts(ids.user, text, ids.bot), false);
    }
    assert.throws(() => triggers.accepts(ids.denied, 'DOT help', ids.bot));
    const mentionOnly = new Triggers(new Policy(policySchema.parse({ allowedUserIds: [ids.user] })));
    assert.equal(mentionOnly.accepts(ids.user, 'dot', ids.bot), false);
    assert.equal(mentionOnly.accepts(ids.user, `<@${ids.bot}>`, ids.bot), true);
    const approvalId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assert.equal(triggers.approvalId(`Discordinator approve ${approvalId}`, ids.bot), approvalId);
    assert.equal(triggers.approvalId(`<@${ids.bot}> approve ${approvalId}`, ids.bot), approvalId);
    assert.equal(triggers.approvalId(`approve ${approvalId}`, ids.bot, true), approvalId);
    assert.equal(triggers.approvalId(`Discordinator do not approve ${approvalId}`, ids.bot), null);
    assert.equal(triggers.approvalId(`Discordinator approve ${approvalId} please cancel`, ids.bot), null);
}

function checkScopeLists(): void {
    const scoped = (value: unknown) => new Policy(policySchema.parse(value));
    const [a, b, c] = ['111111111111111111', '222222222222222222', '333333333333333333'];
    const emptyAllow = scoped({});
    assert.equal(emptyAllow.guildAllowed(a), false, 'empty allowlist allows nothing');
    assert.equal(emptyAllow.channelAllowed(a), false);
    const emptyBlock = scoped({ servers: { mode: 'blocklist' }, channels: { mode: 'blocklist' } });
    assert.equal(emptyBlock.guildAllowed(a), true, 'empty blocklist excludes nothing');
    const mixed = scoped({
        servers: { mode: 'allowlist', allowed: [a, b], blocked: [b] },
        channels: { mode: 'blocklist', blocked: [c] },
    });
    assert.equal(mixed.guildAllowed(a), true);
    assert.equal(mixed.guildAllowed(b), false, 'blocked wins over allowed');
    assert.equal(mixed.guildAllowed(c), false);
    assert.equal(mixed.channelAllowed(a), true, 'channel mode is independent of server mode');
    assert.equal(mixed.channelAllowed(c), false);
    const legacyAll = policySchema.parse({ guildScope: 'all', channelScope: 'all', guildIds: [a], channelIds: [] });
    assert.deepEqual(legacyAll.servers, { mode: 'blocklist', allowed: [a], blocked: [] }, 'legacy all keeps full coverage');
    assert.equal(new Policy(legacyAll).guildAllowed(c), true);
    const legacyListed = policySchema.parse({ guildScope: 'listed', guildIds: [a], channelIds: [b] });
    assert.deepEqual(legacyListed.servers, { mode: 'allowlist', allowed: [a], blocked: [] }, 'legacy listed keeps exact list');
    assert.deepEqual(legacyListed.channels, { mode: 'allowlist', allowed: [b], blocked: [] });
    assert.equal(new Policy(legacyListed).guildAllowed(c), false);
    const legacyDefault = policySchema.parse({ guildIds: [] });
    assert.equal(new Policy(legacyDefault).guildAllowed(a), false, 'legacy default listed with no ids stays closed');
    assert.deepEqual(policySchema.parse(JSON.parse(JSON.stringify(mixed.config))), mixed.config, 'saved form reloads unchanged');
    assert.equal('guildScope' in legacyAll, false);
}

async function checkGateway(file: string): Promise<void> {
    const f = fixture(file);
    const gateway = new Gateway(fakeConfig(), f.policy, f.queue, f.approvals, f.api);
    const message = (actor: string, content: string, id: string) =>
        ({
            author: { id: actor, bot: false },
            content,
            id,
            channelId: ids.channel,
            guildId: ids.guild,
            webhookId: null,
        }) as unknown as Message;
    await gateway.message(message(ids.denied, 'Discordinator hello', 'denied'));
    await gateway.message(message(ids.user, 'anecdotal', 'quiet'));
    await gateway.message(message(ids.user, 'Discordinator hello', 'accepted'));
    await gateway.message(message(ids.user, 'Discordinator hello', 'accepted'));
    assert.equal(f.queue.snapshot(0, 25).events.length, 2);
    let deferred = 0;
    let edited = 0;
    const interaction = {
        id: 'interaction',
        user: { id: ids.user },
        applicationId: ids.bot,
        commandName: 'discordinator',
        channelId: ids.channel,
        guildId: ids.guild,
        options: { getString: () => 'hello' },
        deferReply: () => {
            deferred++;
            return Promise.resolve();
        },
        editReply: () => {
            edited++;
            return Promise.resolve({ id: ids.message, channelId: ids.channel });
        },
    } as unknown as ChatInputCommandInteraction;
    await gateway.interaction(interaction);
    await gateway.interaction(interaction);
    assert.equal(deferred, 1);
    const event = f.queue.snapshot(0, 25).events.at(-1)!;
    await f.bridge.respond({ eventId: event.id, content: 'reply', idempotencyKey: 'interaction-reply' });
    assert.equal(edited, 1);
    const replies: unknown[] = [];
    const denied = {
        ...interaction,
        user: { id: ids.denied },
        reply: (body: unknown) => {
            replies.push(body);
            return Promise.resolve();
        },
    } as unknown as ChatInputCommandInteraction;
    await gateway.interaction(denied);
    assert.equal(deferred, 1);
    assert.match(JSON.stringify(replies), /not approved/, 'unapproved people get a private explanation');
    gateway.stop();
}
async function checkDirectMessages(file: string): Promise<void> {
    const f = fixture(file);
    const gateway = new Gateway(fakeConfig(), f.policy, f.queue, f.approvals, f.api);
    const message = (id: string, actor = ids.user, bot = false, webhookId: string | null = null) =>
        ({
            id,
            author: { id: actor, bot },
            content: 'plain hello',
            channelId: ids.channel,
            guildId: null,
            webhookId,
        }) as unknown as Message;
    await gateway.message(message('approved-dm'));
    assert.equal(f.queue.snapshot(0, 25).events.length, 2);
    await gateway.message(message('unapproved-dm', ids.denied));
    await gateway.message(message('bot-dm', ids.user, true));
    await gateway.message(message('webhook-dm', ids.user, false, ids.other));
    await gateway.message({ ...message('plain-guild'), guildId: ids.guild } as Message);
    assert.equal(f.queue.snapshot(0, 25).events.length, 2);
}

function checkRoles(): void {
    const policy = new Policy(policySchema.parse({ allowedUserIds: ['111111111111111111'], allowedRoleIds: ['900000000000000001'] }));
    assert.equal(policy.userAllowed('111111111111111111'), true, 'approved people still pass');
    assert.equal(policy.userAllowed('222222222222222222'), false, 'unknown roles do not pass');
    policy.noteRoles('222222222222222222', '444444444444444444', ['900000000000000001']);
    assert.doesNotThrow(() => policy.assertUser('222222222222222222'), 'an approved role lets someone ask');
    policy.noteRoles('222222222222222222', '444444444444444444', []);
    assert.throws(() => policy.assertUser('222222222222222222'), /whitelisted/, 'losing the role revokes access');
}

export async function checkPolicy(directory: string): Promise<void> {
    checkRoles();
    const empty = new Policy(policySchema.parse({}));
    await checkDirectMessages(`${directory}/direct-messages.json`);
    checkScopeLists();
    assert.throws(() => empty.assertUser(ids.user));
    assert.throws(() => empty.assertGuild(ids.guild));
    assert.throws(() => empty.assertChannel(ids.channel));
    assert.throws(() => empty.assertScope('messages.write'));
    assert.equal(policySchema.safeParse({ allowedUserIds: [Number(ids.user)] }).success, false);
    const f = fixture(`${directory}/policy.json`);
    f.policy.assertGuild(ids.other);
    f.policy.assertChannel(ids.other);
    assert.throws(() => f.policy.assertUser(ids.denied));
    f.policy.assertProactive(ids.channel);
    f.policy.noteDm(ids.other, ids.denied);
    assert.throws(() => f.policy.assertProactive(ids.other), /not whitelisted/, 'A DM is only for approved people');
    assert.throws(() => f.policy.assertResponse(f.event, ids.other));
    assert.throws(() => f.policy.assertGuildAction(f.event, ids.other));
    checkTriggers(f.policy);
    assert.equal(gatewayIntents(fakeConfig()).length, 5, 'Voice states are always requested so the bot can follow calls');
    assert.equal(gatewayIntents({ ...fakeConfig(), DISCORDINATOR_MESSAGE_CONTENT: 'false' }).length, 4);
    await checkGateway(`${directory}/gateway.json`);
    await checkConfig(`${directory}/config.json`);
}

async function checkConfig(file: string): Promise<void> {
    await writeFile(file, JSON.stringify(policySchema.parse({ triggers: { matchNames: true, names: ['Discordinator'] } })));
    const env = {
        DISCORD_BOT_TOKEN: 'offline-validation-only',
        DISCORDINATOR_AUTH_MODE: 'bearer',
        DISCORDINATOR_MCP_TOKEN: fakeConfig().DISCORDINATOR_MCP_TOKEN,
        DISCORDINATOR_POLICY_FILE: file,
        DISCORDINATOR_MESSAGE_CONTENT: 'true',
        DISCORDINATOR_RESOURCE_URL: '',
        DISCORDINATOR_OAUTH_ISSUER: '',
        DISCORDINATOR_OAUTH_JWKS_URL: '',
    };
    const loaded = await loadConfig(env);
    assert.deepEqual(loaded.policy.allowedUserIds, []);
    await assert.rejects(() => loadConfig({ ...env, DISCORDINATOR_MESSAGE_CONTENT: 'false' }), /Name matching requires/);
    await assert.rejects(() => loadConfig({ ...env, DISCORD_BOT_TOKEN: '' }));
    await assert.rejects(() => loadConfig({ ...env, DISCORDINATOR_MCP_TOKEN: 'short' }));
}
