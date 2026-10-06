import assert from 'node:assert/strict';
import { quit, review } from '../src/operator/ui/effects.js';
import { commitServerChannels, isServerChannels, openServer } from '../src/operator/ui/server-sheet.js';
import { inviteLink } from '../src/operator/onboarding-invite.js';
import { serverState } from '../src/operator/servers.js';
import { called, fakeServices, press, servers, settle, sheetOf, snapshot, uiStore, type Calls, type TestStore } from './ui-fixtures.js';

const drafted = (ui: TestStore, operator: Record<string, unknown>, environment: Record<string, unknown> = {}) =>
    (ui.state = {
        ...ui.state,
        drafts: {
            ...ui.state.drafts,
            operator: { ...ui.state.drafts.operator, ...operator },
            environment: { ...ui.state.drafts.environment, ...environment },
        },
    });

async function checkReview(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    drafted(ui, { mode: 'manual-mcp' });
    review(ui);
    assert.equal(sheetOf(ui, 'confirm').title, 'Save 1 change?');
    assert.ok(sheetOf(ui, 'confirm').body[0]!.includes('→'), 'each change shows before and after');
    await press(ui, 'Keep editing');
    assert.equal(ui.state.sheet, undefined);
    assert.equal(ui.state.drafts.operator.mode, 'manual-mcp', 'keep editing keeps the draft');
    drafted(ui, {}, { DISCORDINATOR_RESOURCE_URL: 'https://other.example.com/mcp' });
    review(ui);
    assert.equal(sheetOf(ui, 'confirm').title, 'Save 2 changes?');
    assert.ok(
        sheetOf(ui, 'confirm').body.some((row) => row.endsWith('(after restart)')),
        'restart-only settings are marked',
    );
    await press(ui, 'Discard all');
    assert.deepEqual(ui.state.drafts, ui.state.snapshot.documents, 'discarding restores the saved files');
    assert.equal(ui.state.toast?.text, 'Changes discarded.');
}

async function checkCommit(): Promise<void> {
    const calls: Calls = [];
    const saved = structuredClone(snapshot);
    saved.documents.operator.mode = 'chatgpt-events';
    const services = fakeServices(calls, {
        applyDraft: (...args) => (
            calls.push(['applyDraft', ...args]),
            Promise.resolve({ snapshot: saved, message: 'Partly.', warning: true })
        ),
        readPanel: () => (calls.push(['readPanel']), Promise.resolve(saved)),
    });
    const ui = uiStore(services);
    drafted(ui, { mode: 'chatgpt-events' });
    review(ui);
    await press(ui, 'Save');
    assert.equal(called(calls, 'applyDraft').length, 1);
    assert.equal(ui.state.snapshot, saved, 'the saved snapshot replaces the old one');
    assert.deepEqual(ui.state.drafts, saved.documents, 'drafts start fresh from the saved files');
    assert.ok(
        ui.state.activity.some((item) => item.text === 'Partly.' && item.tone === 'warn'),
        'a warning from saving is shown as a warning',
    );
    assert.equal(called(calls, 'readPanel').length, 1, 'changing responder triggers a deep refresh');
    assert.equal(sheetOf(ui, 'confirm').title, 'ChatGPT on the web and phone', 'switching to ChatGPT opens its guide');
    const known = uiStore(fakeServices(calls, { webConnectors: () => Promise.resolve({ chatgpt: 'https://bot.example.com/mcp' }) }));
    drafted(known, { mode: 'chatgpt-events' });
    review(known);
    await press(known, 'Save');
    assert.equal(known.state.sheet, undefined, 'the guide is skipped once ChatGPT is connected');
}

async function checkQuit(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    drafted(ui, { mode: 'manual-mcp' });
    quit(ui);
    assert.equal(sheetOf(ui, 'confirm').title, 'Save before leaving?');
    await press(ui, 'Stay');
    assert.equal(ui.exited, false);
    quit(ui);
    await press(ui, 'Quit without saving');
    assert.equal(ui.exited, true);
    assert.equal(called(calls, 'applyDraft').length, 0);
    const saving = uiStore(fakeServices(calls));
    drafted(saving, { mode: 'manual-mcp' });
    quit(saving);
    await press(saving, 'Save and quit');
    assert.equal(called(calls, 'applyDraft').length, 1);
    assert.equal(saving.exited, true, 'saving then quitting leaves after the save');
    const failing = uiStore(fakeServices(calls, { applyDraft: () => Promise.reject(new Error('disk full')) }));
    drafted(failing, { mode: 'manual-mcp' });
    quit(failing);
    await press(failing, 'Save and quit');
    assert.equal(failing.exited, false, 'a failed save keeps the screen open');
    assert.deepEqual(failing.state.toast, { text: 'disk full', tone: 'bad' });
}

async function checkInvite(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    openServer(ui);
    assert.equal(ui.state.toast?.tone, 'warn', 'inviting before the bot loads asks for a refresh');
    assert.equal(called(calls, 'openUrl').length, 0);
    ui.state = { ...ui.state, extras: { ...ui.state.extras, servers } };
    openServer(ui);
    await settle();
    assert.deepEqual(called(calls, 'openUrl'), [['openUrl', inviteLink(servers.botId)]]);
    assert.equal(ui.state.toast?.tone, 'info');
    const rejected = uiStore(fakeServices(calls, { openUrl: () => Promise.reject(new Error('no browser')) }));
    rejected.state = { ...rejected.state, extras: { ...rejected.state.extras, servers } };
    openServer(rejected);
    await settle();
    assert.equal(rejected.state.toast?.tone, 'info', 'a browser failure does not hide the instructions');
}

async function checkServers(): Promise<void> {
    const ui = uiStore(fakeServices([]));
    ui.state = { ...ui.state, extras: { ...ui.state.extras, servers } };
    const guild = servers.servers[0]!;
    openServer(ui, 'missing');
    assert.equal(ui.state.sheet, undefined, 'an unknown server opens nothing');
    openServer(ui, guild.id);
    assert.equal(sheetOf(ui, 'confirm').title, 'Guild');
    assert.match(sheetOf(ui, 'confirm').body[0]!, /answers here in 0 of 2 channels/);
    await press(ui, 'Stop answering here');
    assert.equal(serverState(ui.state.drafts.policy, guild).allowed, false, 'the server is turned off in the draft');
    assert.match(ui.state.toast?.text ?? '', /Guild: turned off/);
    openServer(ui, guild.id);
    assert.match(sheetOf(ui, 'confirm').body[0]!, /does not answer in this server/);
    await press(ui, 'Answer in this server');
    assert.equal(serverState(ui.state.drafts.policy, guild).allowed, true);
    openServer(ui, guild.id);
    await press(ui, 'Choose channels');
    const multi = sheetOf(ui, 'multi');
    assert.equal(isServerChannels(multi), true);
    assert.deepEqual(multi.labels, { '555555555555555555': '#general', '666666666666666666': '#random' });
    assert.deepEqual(multi.chosen, [], 'no channel is on until one is chosen');
    commitServerChannels(ui, { ...multi, chosen: ['555555555555555555'] });
    assert.deepEqual(serverState(ui.state.drafts.policy, guild).channels, ['555555555555555555'], 'only chosen channels stay on');
    assert.equal(ui.state.sheet, undefined);
    const before = ui.state.drafts.policy;
    commitServerChannels(ui, { ...multi, field: { ...multi.field, id: 'server-channels:missing' } });
    assert.equal(ui.state.drafts.policy, before, 'channels for an unknown server are ignored');
    openServer(ui, guild.id);
    await press(ui, 'Close');
    assert.equal(ui.state.sheet, undefined);
}

export async function checkReviewFlows(): Promise<void> {
    await checkReview();
    await checkCommit();
    await checkQuit();
    await checkInvite();
    await checkServers();
}
