import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Events, type ChatInputCommandInteraction, type Interaction } from 'discord.js';
import type { Flows } from '../src/interactions/flows.js';
import { replyEmbed, type CommandHandler } from '../src/discord/commands.js';
import { ids } from './fixtures.js';
import { gatewayHarness, snowflakeId, until } from './discord-fakes.js';

const role = '900000000000000001';
const notAnError = 'plain failure' as unknown as Error;
type Sent = { kind: string; body: unknown };

function fakeInteraction(overrides: Record<string, unknown> = {}) {
    const sent: Sent[] = [];
    const push = (kind: string) => (body: unknown) => {
        sent.push({ kind, body });
        return Promise.resolve({ id: ids.message, channelId: ids.channel });
    };
    const interaction = {
        id: snowflakeId(9000),
        user: { id: ids.user },
        applicationId: ids.bot,
        commandName: 'discordinator',
        channelId: ids.channel,
        guildId: ids.guild,
        member: null,
        customId: 'discordinator:x',
        options: { getString: () => 'hello', data: [] },
        deferReply: push('defer'),
        editReply: push('edit'),
        reply: push('reply'),
        isChatInputCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        ...overrides,
    };
    return { interaction: interaction as unknown as ChatInputCommandInteraction & Interaction, sent };
}

const embedOf = (sent: Sent[]) =>
    (sent.find((item) => item.kind === 'edit')!.body as { embeds: { title: string; description: string }[] }).embeds[0]!;

async function checkBuiltIns(file: string): Promise<void> {
    const seen: unknown[][] = [];
    const commands: CommandHandler = (name, options, origin) => {
        seen.push([name, options, origin]);
        if (name === 'stop') return Promise.reject(new Error('Nothing is running'));
        if (name === 'new') return Promise.reject(notAnError);
        return Promise.resolve({ title: 'Activity', lines: ['On'], tone: 'good' });
    };
    const h = gatewayHarness(file, { commands });
    const data = [
        { name: 'mode', value: 'on' },
        { name: 'empty', value: undefined },
    ];
    const activity = fakeInteraction({ commandName: 'activity', options: { data } });
    await h.gateway.interaction(activity.interaction);
    assert.deepEqual(activity.sent[0], { kind: 'defer', body: undefined });
    assert.deepEqual(seen[0], ['activity', { mode: 'on', empty: '' }, { guildId: ids.guild, channelId: ids.channel, actorId: ids.user }]);
    assert.deepEqual(embedOf(activity.sent), { title: 'Activity', description: 'On', color: 0x3ba55d });
    const stop = fakeInteraction({ commandName: 'stop' });
    await h.gateway.interaction(stop.interaction);
    assert.deepEqual(embedOf(stop.sent), { title: 'Could not do that', description: 'Nothing is running', color: 0xf0b232 });
    const odd = fakeInteraction({ commandName: 'new' });
    await h.gateway.interaction(odd.interaction);
    assert.equal(embedOf(odd.sent).description, 'Something went wrong', 'non-Error failures get a generic message');
    const unknown = fakeInteraction({ commandName: 'unknown' });
    await h.gateway.interaction(unknown.interaction);
    assert.deepEqual(unknown.sent, [], 'unknown commands are ignored');
    const long = replyEmbed({ title: 'Long', lines: ['y'.repeat(5000)], tone: 'info' });
    assert.equal(long.description!.length, 4096);
    assert.ok(long.description!.endsWith('…'));
    h.gateway.stop();
}

async function checkAsk(file: string): Promise<void> {
    const h = gatewayHarness(file);
    const foreign = fakeInteraction({ applicationId: ids.other });
    await h.gateway.interaction(foreign.interaction);
    assert.deepEqual(foreign.sent, [], 'commands for another application are ignored');
    const builtIn = fakeInteraction({ commandName: 'status' });
    await h.gateway.interaction(builtIn.interaction);
    assert.deepEqual(builtIn.sent, [], 'built-in commands do nothing without a command handler');
    const ask = fakeInteraction({ id: snowflakeId(9001), options: { getString: () => 'do the thing' } });
    await h.gateway.interaction(ask.interaction);
    assert.equal(h.emitted.at(-1)![1], 'discord.interaction.created');
    assert.equal(h.emitted.at(-1)![0].text, 'do the thing');
    const blank = fakeInteraction({ id: snowflakeId(9002), options: { getString: () => null } });
    await h.gateway.interaction(blank.interaction);
    assert.equal(h.queued().at(-1)!.text, '', 'a missing text option becomes empty text');
    const before = h.emitted.length;
    await h.gateway.interaction(blank.interaction);
    assert.equal(h.emitted.length, before, 'a repeated interaction is captured once');
    const blocked = fakeInteraction({ id: snowflakeId(9003), channelId: ids.other });
    h.policy.config.channels.blocked.push(ids.other);
    await h.gateway.interaction(blocked.interaction);
    assert.match(JSON.stringify(blocked.sent), /not approved to use Discordinator here/);
    h.policy.config.scopes = h.policy.config.scopes.filter((scope) => scope !== 'messages.write');
    await assert.rejects(h.gateway.interaction(fakeInteraction({ id: snowflakeId(9004) }).interaction), /Capability is not approved/);
    h.gateway.stop();
}

async function checkInteractionEvents(file: string): Promise<void> {
    const h = gatewayHarness(file, { flows: {} as Flows });
    h.policy.config.allowedRoleIds.push(role);
    const roleUser = '151515151515151515';
    const apiMember = fakeInteraction({ user: { id: roleUser }, member: { roles: [role] }, isChatInputCommand: () => false });
    h.gateway.client.emit(Events.InteractionCreate, apiMember.interaction);
    assert.equal(h.policy.userAllowed(roleUser), true, 'raw member roles are learned from interactions');
    const cached = fakeInteraction({ user: { id: roleUser }, member: { roles: { cache: new Map() } }, isChatInputCommand: () => false });
    h.gateway.client.emit(Events.InteractionCreate, cached.interaction);
    assert.equal(h.policy.userAllowed(roleUser), false, 'cached member roles replace older ones');
    const dm = fakeInteraction({ user: { id: roleUser }, guildId: null, member: { roles: [role] }, isChatInputCommand: () => false });
    h.gateway.client.emit(Events.InteractionCreate, dm.interaction);
    assert.equal(h.policy.userAllowed(roleUser), false, 'roles outside a guild are ignored');
    const slash = fakeInteraction({ id: snowflakeId(9010) });
    h.gateway.client.emit(Events.InteractionCreate, slash.interaction);
    await until(() => slash.sent.some((item) => item.kind === 'defer'), 'the slash command to be deferred');
    const button = fakeInteraction({ user: { id: ids.denied }, isChatInputCommand: () => false, isButton: () => true });
    h.gateway.client.emit(Events.InteractionCreate, button.interaction);
    await until(() => button.sent.length > 0, 'the control to be rejected');
    assert.match(JSON.stringify(button.sent[0]!.body), /only for its original approved requester/);
    for (const kind of ['isStringSelectMenu', 'isModalSubmit']) {
        const control = fakeInteraction({ user: { id: ids.denied }, isChatInputCommand: () => false, [kind]: () => true });
        h.gateway.client.emit(Events.InteractionCreate, control.interaction);
        await until(() => control.sent.length > 0, `the ${kind} control to be rejected`);
    }
    const plain = gatewayHarness(`${file}.plain`);
    const ignored = fakeInteraction({ user: { id: ids.denied }, isChatInputCommand: () => false, isButton: () => true });
    plain.gateway.client.emit(Events.InteractionCreate, ignored.interaction);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ignored.sent, [], 'controls are ignored without interactive flows');
    h.gateway.stop();
    plain.gateway.stop();
}

export async function checkGatewayInteractions(directory: string): Promise<void> {
    await checkBuiltIns(join(directory, 'gateway-builtins.json'));
    await checkAsk(join(directory, 'gateway-ask.json'));
    await checkInteractionEvents(join(directory, 'gateway-interaction-events.json'));
}
