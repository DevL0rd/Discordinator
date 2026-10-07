import assert from 'node:assert/strict';
import { dispatch, jumpTo } from '../src/operator/ui/intents.js';
import { pickerFor } from '../src/operator/ui/pickers.js';
import { setting } from '../src/operator/ui/items.js';
import { viewOf } from '../src/operator/ui/state.js';
import type { BotServers } from '../src/operator/servers.js';
import { called, fakeServices, models, observed, press, servers, settle, sheetOf, uiStore, type Calls } from './ui-fixtures.js';

const stranger = '999999999999999999';
const crowded: BotServers = {
    ...servers,
    servers: servers.servers.map((server) => ({
        ...server,
        members: [{ id: '111111111111111111', name: 'Owner' }],
        roles: [{ id: '777777777777777777', name: 'Mods' }],
    })),
};

function checkEditors(): void {
    const ui = uiStore(undefined, { extras: { apps: {}, servers: crowded } });
    ui.state = { ...ui.state, drafts: { ...ui.state.drafts, policy: { ...ui.state.drafts.policy, allowedUserIds: [stranger] } } };
    dispatch(ui, { type: 'edit', setting: 'policy.allowedUserIds' });
    const people = sheetOf(ui, 'multi');
    assert.deepEqual(people.field.choices, ['111111111111111111', stranger], 'people come from the servers plus anyone already allowed');
    assert.deepEqual(people.chosen, [stranger]);
    assert.equal(people.labels?.[stranger], `Not in your servers (${stranger})`, 'unknown people are labelled');
    assert.equal(people.label, setting('policy.allowedUserIds').label, 'the picker keeps the setting label');
    dispatch(ui, { type: 'edit', setting: 'policy.allowedRoleIds' });
    const roles = sheetOf(ui, 'multi');
    assert.deepEqual(roles.labels, { '777777777777777777': '@Mods · Guild' }, 'roles name their server');
    assert.deepEqual(roles.chosen, []);
    dispatch(ui, { type: 'edit', setting: 'policy.scopes' });
    const scopes = sheetOf(ui, 'multi');
    assert.equal(scopes.field.id, 'policy.scopes', 'lists with fixed choices open a checklist');
    assert.equal(scopes.labels, undefined);
    dispatch(ui, { type: 'edit', setting: 'environment.DISCORDINATOR_BIND_HOST' });
    assert.match(ui.state.toast?.text ?? '', /fixed for safety/, 'read-only settings explain why they cannot change');
    assert.equal(ui.state.toast?.tone, 'idle');
    const bare = uiStore();
    bare.state = { ...bare.state, drafts: { ...bare.state.drafts, policy: { ...bare.state.drafts.policy, allowedUserIds: ['1', '2'] } } };
    dispatch(bare, { type: 'edit', setting: 'policy.allowedUserIds' });
    assert.equal(sheetOf(bare, 'edit').input, '1, 2', 'without the server list people are typed as text');
    assert.equal(pickerFor(setting('policy.scopes'), ui.state), undefined, 'only people and roles have pickers');
}

function checkModelEditors(): void {
    const withModels = {
        ...models,
        models: [{ id: 'fast', name: 'Fast model', efforts: ['low', 'high'] }],
    };
    const ui = uiStore(undefined, { observed: { ...observed, codex: withModels, claude: withModels } });
    ui.state = { ...ui.state, drafts: { ...ui.state.drafts, operator: { ...ui.state.drafts.operator, codexModel: 'fast' } } };
    for (const provider of ['codex', 'claude'] as const) {
        dispatch(ui, { type: 'edit', setting: `operator.${provider}Model` });
        const model = sheetOf(ui, 'edit');
        assert.deepEqual(model.options, ['', 'fast'], `${provider} models include the default`);
        assert.deepEqual(model.labels, { '': 'Default', fast: 'Fast model' });
        dispatch(ui, { type: 'edit', setting: `operator.${provider}Effort` });
        assert.equal(sheetOf(ui, 'edit').options[0], '', `${provider} effort can go back to the default`);
        assert.deepEqual(sheetOf(ui, 'edit').labels, {});
    }
    dispatch(ui, { type: 'edit', setting: 'operator.codexEffort' });
    assert.deepEqual(sheetOf(ui, 'edit').options, ['', 'low', 'high'], 'efforts follow the chosen model');
    dispatch(ui, { type: 'edit', setting: 'operator.claudeEffort' });
    assert.deepEqual(sheetOf(ui, 'edit').options, ['', 'high'], 'without a model the default efforts apply');
    dispatch(ui, { type: 'edit', setting: 'policy.context.reach' });
    assert.deepEqual(sheetOf(ui, 'edit').options, ['channel', 'server'], 'choices are offered as options');
    dispatch(ui, { type: 'edit', setting: 'operator.instructions' });
    assert.deepEqual(sheetOf(ui, 'edit').options, [], 'free text has no options');
}

function checkModes(): void {
    const ui = uiStore();
    const before = ui.state;
    dispatch(ui, { type: 'mode', mode: 'codex-local' });
    assert.equal(ui.state, before, 'choosing the current responder changes nothing');
    dispatch(ui, { type: 'mode', mode: 'chatgpt-events' });
    assert.equal(ui.state.drafts.operator.mode, 'chatgpt-events');
    assert.deepEqual(ui.state.toast, { text: 'ChatGPT - Dot selected. Press S to save it.', tone: 'info' });
    const local = uiStore();
    local.state = {
        ...local.state,
        drafts: { ...local.state.drafts, environment: { ...local.state.drafts.environment, DISCORDINATOR_RESOURCE_URL: '' } },
    };
    dispatch(local, { type: 'mode', mode: 'chatgpt-events' });
    assert.equal(local.state.drafts.operator.mode, 'codex-local', 'ChatGPT needs a public domain');
    assert.equal(local.state.toast?.tone, 'warn');
    assert.match(local.state.toast?.text ?? '', /needs a public domain/);
}

async function checkActions(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls), { extras: { apps: {}, servers } });
    dispatch(ui, { type: 'page', page: 'apps' });
    assert.equal(ui.state.page, 'apps');
    dispatch(ui, { type: 'toggle', setting: 'policy.media.enabled' });
    assert.equal((ui.state.drafts.policy.media as { enabled: boolean }).enabled, false, 'toggle flips a switch');
    dispatch(ui, { type: 'toggle', setting: 'policy.media.enabled' });
    assert.equal((ui.state.drafts.policy.media as { enabled: boolean }).enabled, true, 'and back');
    dispatch(ui, { type: 'save' });
    assert.deepEqual(ui.state.toast, { text: 'Nothing to save.', tone: 'idle' });
    dispatch(ui, { type: 'toggle', setting: 'policy.media.enabled' });
    assert.equal(viewOf(ui.state).changes.length, 1);
    dispatch(ui, { type: 'discard' });
    assert.equal(viewOf(ui.state).changes.length, 0, 'discard drops every draft');
    assert.deepEqual(ui.state.toast, { text: 'Changes discarded.', tone: 'idle' });
    dispatch(ui, { type: 'info', title: 'About', body: 'Details here.' });
    assert.deepEqual(sheetOf(ui, 'confirm').body, ['Details here.']);
    await press(ui, 'OK');
    assert.equal(ui.state.sheet, undefined, 'OK closes the info sheet');
    dispatch(ui, { type: 'run', action: 'install-service' });
    assert.equal(sheetOf(ui, 'confirm').title, 'Install the background service?', 'run starts the action');
    await press(ui, 'Install');
    assert.equal(called(calls, 'installService').length, 1);
    dispatch(ui, { type: 'server', id: servers.servers[0]!.id });
    assert.equal(sheetOf(ui, 'confirm').title, 'Guild', 'a server card opens its sheet');
    dispatch(ui, { type: 'server' });
    await settle();
    assert.deepEqual(called(calls, 'openUrl').length, 1, 'inviting opens the invite link');
}

function checkJumps(): void {
    const ui = uiStore(undefined, { sheet: { kind: 'help' } });
    jumpTo(ui, 'not-a-real-item');
    assert.deepEqual([ui.state.sheet, ui.state.page], [undefined, 'home'], 'an unknown target just closes the sheet');
    jumpTo(ui, 'install-service');
    assert.deepEqual([ui.state.page, ui.state.focus, ui.state.sheet], ['system', 'content', undefined], 'actions are focused, not run');
    assert.equal(ui.state.cursor.system, 2, 'the cursor lands on the action');
}

export async function checkUiIntents(): Promise<void> {
    checkEditors();
    checkModelEditors();
    checkModes();
    await checkActions();
    checkJumps();
}
