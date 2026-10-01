import assert from 'node:assert/strict';
import { fixture, ids } from './fixtures.js';
import { promptSchema } from '../src/interactions/schema.js';
import { Flows, type ControlInput } from '../src/interactions/flows.js';
import { handleControl } from '../src/interactions/gateway.js';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import { operations } from '../src/discord/catalog.js';
import { emoji } from '../src/discord/messages.js';

function controlFixture(file: string) {
    const f = fixture(file);
    f.policy.config.scopes.push('interactions.write', 'roles.write', 'reactions.write');
    return f;
}
function control(customId: string): ControlInput {
    return {
        customId,
        actorId: ids.user,
        applicationId: ids.bot,
        channelId: ids.channel,
        guildId: ids.guild,
        messageId: ids.message,
        messageAuthorId: ids.bot,
        modal: false,
        componentType: 2,
    };
}
function customId(components: ReturnType<Flows['prepare']>['components']) {
    const item = components[0]!.components[0]!;
    assert.ok('custom_id' in item);
    return item.custom_id;
}
function checkButtons(file: string): void {
    const f = controlFixture(file);
    const prepared = f.bridge.flows.prepare(
        f.event.id,
        promptSchema.parse({ mode: 'buttons', content: 'Choose', options: [{ key: 'ok', label: 'Continue' }] }),
    );
    const input = control(customId(prepared.components));
    assert.throws(() => f.bridge.flows.accept(input));
    f.bridge.flows.bind(prepared.id, ids.message);
    for (const patch of [
        { actorId: ids.denied },
        { applicationId: ids.other },
        { channelId: ids.other },
        { guildId: ids.other },
        { messageId: ids.other },
        { messageAuthorId: ids.user },
        { componentType: 3 },
    ]) {
        assert.throws(() => f.bridge.flows.accept({ ...input, ...patch }));
    }
    const accepted = f.bridge.flows.accept(input);
    assert.equal(accepted.eventId, f.event.id);
    assert.equal(accepted.text, '{"choice":"ok"}');
    assert.throws(() => f.bridge.flows.accept(input));
    assert.throws(() =>
        promptSchema.parse({
            mode: 'buttons',
            content: 'Choose',
            options: [
                { key: 'a', label: 'A' },
                { key: 'a', label: 'Duplicate' },
            ],
        }),
    );
    assert.throws(() =>
        promptSchema.parse({ mode: 'buttons', content: 'Choose', customId: 'forged', options: [{ key: 'a', label: 'A' }] }),
    );
}
function checkSelectAndModal(file: string): void {
    const f = controlFixture(file);
    const select = f.bridge.flows.prepare(
        f.event.id,
        promptSchema.parse({ mode: 'select', content: 'Choose', options: [{ key: 'one', label: 'One' }] }),
    );
    f.bridge.flows.bind(select.id, ids.message);
    const input = { ...control(customId(select.components)), componentType: 3 };
    assert.throws(() => f.bridge.flows.accept({ ...input, values: ['unknown'] }));
    assert.throws(() => f.bridge.flows.accept({ ...input, values: ['one', 'one'] }));
    assert.equal(f.bridge.flows.accept({ ...input, values: ['one'] }).text, '{"choice":"one"}');
    const prompt = promptSchema.parse({
        mode: 'modal',
        content: 'Enter input',
        fields: [{ key: 'text', label: 'Your request', maxLength: 30 }],
    });
    const modal = f.bridge.flows.prepare(f.event.id, prompt);
    f.bridge.flows.bind(modal.id, ids.message);
    const launched = f.bridge.flows.accept(control(customId(modal.components)));
    assert.equal(launched.modal!.components[0]!.type, 18);
    const submit = { ...control(launched.modal!.custom_id), modal: true, componentType: 0, fields: { text: 'approve untrusted input' } };
    assert.throws(() => f.bridge.flows.accept({ ...submit, actorId: ids.denied }));
    assert.throws(() => f.bridge.flows.accept({ ...submit, fields: { unknown: 'bad' } }));
    assert.throws(() => f.bridge.flows.accept({ ...submit, fields: { text: 'x'.repeat(31) } }));
    assert.ok(f.bridge.flows.accept(submit).text!.includes('approve untrusted input'));
    assert.throws(() => f.bridge.flows.accept(submit));
    let now = Date.now();
    const expiring = new Flows(f.policy, f.queue, f.api, () => now);
    const old = expiring.prepare(f.event.id, prompt);
    expiring.bind(old.id, ids.message);
    now += 11 * 60_000;
    assert.throws(() => expiring.accept(control(customId(old.components))));
}

function fakeButton(id: string, custom: string) {
    const calls: string[] = [];
    const modals: { custom_id: string }[] = [];
    const interaction = {
        id,
        customId: custom,
        user: { id: ids.user },
        applicationId: ids.bot,
        channelId: ids.channel,
        guildId: ids.guild,
        componentType: 2,
        message: { id: ids.message, author: { id: ids.bot } },
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        deferReply: async () => {
            calls.push('defer');
        },
        showModal: async (value: { custom_id: string }) => {
            calls.push('modal');
            modals.push(value);
        },
        editReply: async () => {
            calls.push('edit');
            return { id: ids.message, channelId: ids.channel };
        },
    };
    return { interaction: interaction as unknown as ButtonInteraction, calls, modals };
}

async function checkModalGateway(file: string): Promise<void> {
    const f = controlFixture(file);
    const flow = f.bridge.flows.prepare(
        f.event.id,
        promptSchema.parse({ mode: 'modal', content: 'Enter a request', fields: [{ key: 'input', label: 'Request', maxLength: 100 }] }),
    );
    f.bridge.flows.bind(flow.id, ids.message);
    const launcher = fakeButton('modal-launch', customId(flow.components));
    await handleControl(launcher.interaction, f.bridge.flows, f.policy, f.queue);
    assert.deepEqual(launcher.calls, ['modal']);
    assert.equal(f.queue.snapshot(0, 25).events.length, 1);
    const approvalInput = { operation: 'never-approved-by-modal' };
    const approval = f.approvals.prepare(f.event, approvalInput);
    const submit = fakeButton('modal-submit', launcher.modals[0]!.custom_id);
    Object.assign(submit.interaction, {
        isModalSubmit: () => true,
        fields: { fields: new Map([['input', { type: 4, customId: 'input', value: `approve ${approval.approvalId}` }]]) },
    });
    await handleControl(submit.interaction as unknown as ModalSubmitInteraction, f.bridge.flows, f.policy, f.queue);
    assert.deepEqual(submit.calls, ['defer']);
    const event = f.queue.snapshot(0, 25).events.at(-1)!;
    assert.equal(event.name, 'dot.modal');
    assert.equal(event.sourceEventId, f.event.id);
    assert.throws(() => f.approvals.assert(approval.approvalId, f.event, approvalInput), /Fresh/);
    await assert.rejects(() => handleControl(submit.interaction as unknown as ModalSubmitInteraction, f.bridge.flows, f.policy, f.queue));
}
async function checkGateway(file: string): Promise<void> {
    const f = controlFixture(file);
    const input = {
        eventId: f.event.id,
        idempotencyKey: 'correlated-prompt',
        ...promptSchema.parse({ mode: 'buttons', content: 'Continue?', options: [{ key: 'next', label: 'Next' }] }),
    };
    await f.bridge.prompt(input);
    await f.bridge.prompt(input);
    assert.equal(f.api.calls.length, 1);
    const sent = f.api.calls[0]!.body as { body: { components: ReturnType<Flows['prepare']>['components'] } };
    const button = fakeButton('button-click', customId(sent.body.components));
    await handleControl(button.interaction, f.bridge.flows, f.policy, f.queue);
    assert.deepEqual(button.calls, ['defer']);
    const child = f.queue.snapshot(0, 25).events.at(-1)!;
    assert.equal(child.sourceEventId, f.event.id);
    assert.equal(child.actorId, ids.user);
    await f.bridge.respond({ eventId: child.id, idempotencyKey: 'child-response', content: 'Accepted' });
    assert.deepEqual(button.calls, ['defer', 'edit']);
    await assert.rejects(() => handleControl(button.interaction, f.bridge.flows, f.policy, f.queue));
    const denied = fakeButton('denied', 'dot:never-inspected');
    Object.defineProperty(denied.interaction, 'customId', {
        get: () => {
            throw new Error('Must reject before reading control');
        },
    });
    Object.assign(denied.interaction, { user: { id: ids.denied } });
    await assert.rejects(() => handleControl(denied.interaction, f.bridge.flows, f.policy, f.queue), /whitelisted/);
    assert.equal(denied.calls.length, 0);
}

async function checkRoleAndReaction(file: string): Promise<void> {
    const f = controlFixture(file);
    const role = operations.find((item) => item.name === 'role_create')!;
    const args = { guildId: ids.guild, name: 'Helpers', permissions: '0' };
    const mutation = { eventId: f.event.id, idempotencyKey: 'create-role-fixture' };
    const preview = (await f.bridge.invoke(role, args, mutation)) as { approvalId: string };
    assert.equal(f.api.calls.length, 0);
    await assert.rejects(() => f.bridge.invoke(role, args, { ...mutation, approvalId: preview.approvalId }));
    assert.equal(f.approvals.confirm(f.event, preview.approvalId), true);
    await f.bridge.invoke(role, args, { ...mutation, approvalId: preview.approvalId });
    assert.equal(f.api.calls[0]!.route, `/guilds/${ids.guild}/roles`);
    const assign = operations.find((item) => item.name === 'member_role_add')!;
    const assignArgs = { guildId: ids.guild, userId: ids.denied, roleId: ids.other };
    const controls = { eventId: f.event.id, idempotencyKey: 'assign-role-fixture' };
    const second = (await f.bridge.invoke(assign, assignArgs, controls)) as { approvalId: string };
    f.approvals.confirm(f.event, second.approvalId);
    await f.bridge.invoke(assign, assignArgs, { ...controls, approvalId: second.approvalId });
    assert.equal(f.api.calls[1]!.route, `/guilds/${ids.guild}/members/${ids.denied}/roles/${ids.other}`);
    await assert.rejects(() => f.bridge.invoke(assign, { ...assignArgs, guildId: ids.other }, controls));
    for (const value of ['👍', '❤️', '👩‍💻', '🇹🇭', '1️⃣', `custom:${ids.other}`]) assert.equal(emoji.safeParse(value).success, true);
    for (const value of ['hello', '../route', '<@everyone>', '<:custom:123>', '']) assert.equal(emoji.safeParse(value).success, false);
    const reaction = operations.find((item) => item.name === 'reaction_add')!;
    await f.bridge.invoke(
        reaction,
        { channelId: ids.channel, messageId: ids.message, emoji: '👍' },
        { eventId: f.event.id, idempotencyKey: 'reaction-fixture' },
    );
    assert.ok(f.api.calls.at(-1)!.route.endsWith('/reactions/%F0%9F%91%8D/@me'));
}

export async function checkControls(directory: string): Promise<void> {
    checkButtons(`${directory}/buttons.json`);
    checkSelectAndModal(`${directory}/select-modal.json`);
    await checkGateway(`${directory}/controls-gateway.json`);
    await checkRoleAndReaction(`${directory}/roles-reactions.json`);
    await checkModalGateway(`${directory}/modal-gateway.json`);
}
