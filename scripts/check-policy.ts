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
    for (const text of ['DotBot help', 'DOT, help', '(dot)', 'dot+ help', `<@${ids.bot}> help`, `<@!${ids.bot}> help`]) {
        assert.equal(triggers.accepts(ids.user, text, ids.bot), true);
    }
    for (const text of ['anecdotal', 'dotnet', 'adot', 'dot2', '_dot_', 'éDotBot', 'dotЖ', 'ordinary chat']) {
        assert.equal(triggers.accepts(ids.user, text, ids.bot), false);
    }
    assert.throws(() => triggers.accepts(ids.denied, 'DOT help', ids.bot));
    const mentionOnly = new Triggers(new Policy(policySchema.parse({ allowedUserIds: [ids.user] })));
    assert.equal(mentionOnly.accepts(ids.user, 'dot', ids.bot), false);
    assert.equal(mentionOnly.accepts(ids.user, `<@${ids.bot}>`, ids.bot), true);
    const approvalId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assert.equal(triggers.approvalId(`DotBot approve ${approvalId}`, ids.bot), approvalId);
    assert.equal(triggers.approvalId(`<@${ids.bot}> approve ${approvalId}`, ids.bot), approvalId);
    assert.equal(triggers.approvalId(`approve ${approvalId}`, ids.bot, true), approvalId);
    assert.equal(triggers.approvalId(`DotBot do not approve ${approvalId}`, ids.bot), null);
    assert.equal(triggers.approvalId(`DotBot approve ${approvalId} please cancel`, ids.bot), null);
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
    await gateway.message(message(ids.denied, 'DotBot hello', 'denied'));
    await gateway.message(message(ids.user, 'anecdotal', 'quiet'));
    await gateway.message(message(ids.user, 'DotBot hello', 'accepted'));
    await gateway.message(message(ids.user, 'DotBot hello', 'accepted'));
    assert.equal(f.queue.snapshot(0, 25).events.length, 2);
    let deferred = 0;
    let edited = 0;
    const interaction = {
        id: 'interaction',
        user: { id: ids.user },
        applicationId: ids.bot,
        commandName: 'dot',
        channelId: ids.channel,
        guildId: ids.guild,
        options: { getString: () => 'hello' },
        deferReply: async () => {
            deferred++;
        },
        editReply: async () => {
            edited++;
            return { id: ids.message, channelId: ids.channel };
        },
    } as unknown as ChatInputCommandInteraction;
    await gateway.interaction(interaction);
    await gateway.interaction(interaction);
    assert.equal(deferred, 1);
    const event = f.queue.snapshot(0, 25).events.at(-1)!;
    await f.bridge.respond({ eventId: event.id, content: 'reply', idempotencyKey: 'interaction-reply' });
    assert.equal(edited, 1);
    const denied = { ...interaction, user: { id: ids.denied } } as unknown as ChatInputCommandInteraction;
    await assert.rejects(() => gateway.interaction(denied));
    assert.equal(deferred, 1);
    gateway.stop();
}

export async function checkPolicy(directory: string): Promise<void> {
    const empty = new Policy(policySchema.parse({}));
    assert.throws(() => empty.assertUser(ids.user));
    assert.throws(() => empty.assertGuild(ids.guild));
    assert.throws(() => empty.assertChannel(ids.channel));
    assert.throws(() => empty.assertScope('messages.write'));
    assert.equal(policySchema.safeParse({ allowedUserIds: [Number(ids.user)] }).success, false);
    const f = fixture(`${directory}/policy.json`);
    f.policy.assertGuild(ids.other);
    f.policy.assertChannel(ids.other);
    assert.throws(() => f.policy.assertUser(ids.denied));
    assert.throws(() => f.policy.assertProactive(ids.channel));
    assert.throws(() => f.policy.assertResponse(f.event, ids.other));
    assert.throws(() => f.policy.assertGuildAction(f.event, ids.other));
    checkTriggers(f.policy);
    assert.equal(gatewayIntents(fakeConfig()).length, 4);
    assert.equal(gatewayIntents({ ...fakeConfig(), DOTBOT_MESSAGE_CONTENT: 'false' }).length, 3);
    await checkGateway(`${directory}/gateway.json`);
    await checkConfig(`${directory}/config.json`);
}

async function checkConfig(file: string): Promise<void> {
    await writeFile(file, JSON.stringify(policySchema.parse({ triggers: { matchNames: true, names: ['DotBot'] } })));
    const env = {
        DISCORD_BOT_TOKEN: 'offline-validation-only',
        DOTBOT_AUTH_MODE: 'bearer',
        DOTBOT_MCP_TOKEN: fakeConfig().DOTBOT_MCP_TOKEN,
        DOTBOT_POLICY_FILE: file,
        DOTBOT_MESSAGE_CONTENT: 'true',
        DOTBOT_RESOURCE_URL: '',
        DOTBOT_OAUTH_ISSUER: '',
        DOTBOT_OAUTH_JWKS_URL: '',
    };
    const loaded = await loadConfig(env);
    assert.deepEqual(loaded.policy.allowedUserIds, []);
    await assert.rejects(() => loadConfig({ ...env, DOTBOT_MESSAGE_CONTENT: 'false' }), /Name matching requires/);
    await assert.rejects(() => loadConfig({ ...env, DISCORD_BOT_TOKEN: '' }));
    await assert.rejects(() => loadConfig({ ...env, DOTBOT_MCP_TOKEN: 'short' }));
}
