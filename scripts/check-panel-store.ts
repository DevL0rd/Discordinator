import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { applyDraft, persistentWorkBlock, readPanel, startSaved, type Documents, type PanelSnapshot } from '../src/operator/panel-store.js';
import { readOperatorConfig, writeOperatorConfig } from '../src/operator/config.js';
import { editPublicDomain } from '../src/operator/connection-domain.js';
import { statusFile } from '../src/operator/status-file.js';
import { discordRoutes, fake, inScratch, liveFake, withDiscord, withLocal, type LiveFake } from './onboarding-fakes.js';

const noReconnect = () => Promise.resolve(() => Promise.resolve(''));
const environment = [
    'DISCORD_BOT_TOKEN=fixture-token',
    'DISCORDINATOR_MCP_TOKEN=fixture-credential-at-least-32-characters',
    'DISCORDINATOR_AUTH_MODE=bearer',
    'DISCORDINATOR_POLICY_FILE=policy.json',
    'DISCORDINATOR_PORT=not-a-port',
].join('\n');

function edited(snapshot: PanelSnapshot, patch: Partial<Record<keyof Documents, Record<string, unknown>>>): Documents {
    const documents = structuredClone(snapshot.documents);
    for (const [source, values] of Object.entries(patch)) Object.assign(documents[source as keyof Documents], values);
    return documents;
}

async function checkReading(): Promise<void> {
    await writeFile('.env', `${environment}\n`);
    const fresh = await readPanel();
    assert.equal(fresh.documents.environment.DISCORDINATOR_PORT, 'not-a-port', 'invalid values are kept for the editor to show');
    assert.equal(fresh.originals.policy, '', 'a missing policy file reads as empty');
    assert.deepEqual(fresh.documents.policy.allowedUserIds, [], 'and as the default policy');
    await mkdir('policy.json');
    await assert.rejects(readPanel(), 'an unreadable policy file is an error');
    await rm('policy.json', { recursive: true });
    await writeFile('.env', `${environment.replace('not-a-port', '8787')}\nDISCORDINATOR_MESSAGE_CONTENT=false\n`);
    await writeFile('policy.json', '{}\n');
    const snapshot = await readPanel();
    assert.deepEqual(await applyDraft(snapshot, structuredClone(snapshot.documents), noReconnect), {
        snapshot,
        message: 'No changes to save.',
    });
}

async function checkRefusals(): Promise<void> {
    await writeFile('policy.json', '{"triggers":{"matchNames":false}}\n');
    const snapshot = await readPanel();
    const refuse = (patch: Parameters<typeof edited>[1], error: RegExp) =>
        assert.rejects(applyDraft(snapshot, edited(snapshot, patch), noReconnect), error);
    await refuse({ policy: { triggers: { replyToBot: true, matchNames: true, names: ['dot'] } } }, /Name triggers require Message Content/);
    await refuse({ operator: { mode: 'chatgpt-events' } }, /needs a public domain/);
    await writeFile('not-a-folder', '');
    await refuse({ operator: { mode: 'codex-local', workspace: resolve('not-a-folder') } }, /Workspace must be an existing directory/);
    const signIn = {
        ...editPublicDomain(snapshot.documents.environment, 'bot.example.com'),
        DISCORDINATOR_OAUTH_DATA_DIR: '.data/oauth-check',
    };
    await refuse({ environment: signIn }, /Set a sign-in password first/);
    const routes = { ...discordRoutes(), '/users/222222222222222224': { id: '222222222222222224', bot: true } };
    await withDiscord(routes, () => refuse({ policy: { allowedUserIds: ['222222222222222224'] } }, /could not be verified as a human/));
    await withDiscord(routes, () => refuse({ policy: { allowedUserIds: ['222222222222222225'] } }, /request failed \(404\)/));
    const added = await withDiscord(routes, () =>
        applyDraft(snapshot, edited(snapshot, { policy: { allowedUserIds: [fake.owner] } }), noReconnect),
    );
    assert.equal(added.message, 'Discord settings saved and applied.', 'a verified person is added');
    assert.deepEqual((JSON.parse(await readFile('policy.json', 'utf8')) as { allowedUserIds: string[] }).allowedUserIds, [fake.owner]);
}

async function checkRollback(): Promise<void> {
    const snapshot = await readPanel();
    const before = await readFile(snapshot.paths.operator, 'utf8').catch(() => '');
    const drafts = edited(snapshot, {
        operator: { mode: 'manual-mcp', instructions: 'Rolled back' },
        environment: { bad_key: 'x', DISCORDINATOR_PORT: 9000 },
    });
    await assert.rejects(applyDraft(snapshot, drafts, noReconnect), /Invalid environment key/);
    assert.equal(await readFile(snapshot.paths.operator, 'utf8'), before, 'files already written are put back');
    assert.doesNotMatch(await readFile('.env', 'utf8'), /9000/, 'the failing file is untouched');
}

function checkWorkBlocks(): void {
    const live = (controller: Record<string, unknown> | null, appliedConfigAt: string | null = 'rev') => ({
        gateway: 'ready',
        events: { subscriptions: 0 },
        operator: { mode: 'codex-local', appliedConfigAt, controller },
    });
    assert.equal(persistentWorkBlock(null, 'rev'), undefined, 'nothing running blocks nothing');
    assert.match(persistentWorkBlock(live({ busy: 1 }), 'rev')!, /controller work/);
    assert.match(persistentWorkBlock(live({ approvals: 2 }), 'rev')!, /controller work/);
    assert.match(persistentWorkBlock(live({ tasks: [{}, { state: 'queued' }] }), 'rev')!, /controller work/);
    assert.match(persistentWorkBlock(live({ queued: 1 }), 'rev')!, /delivery is pending/);
    assert.match(persistentWorkBlock(live({ pendingDelivery: 1 }), 'rev')!, /delivery is pending/);
    assert.match(persistentWorkBlock(live(null, 'old'), 'rev')!, /still pending application/);
    assert.equal(persistentWorkBlock(live({}, null), 'rev'), undefined);
    assert.equal(persistentWorkBlock(live({ tasks: [{ state: 'done' }] }), 'rev'), undefined);
}

async function checkStarting(live: LiveFake): Promise<void> {
    const snapshot = await readPanel();
    const start = (operator: Record<string, unknown>, enabled: boolean, patch: Parameters<typeof edited>[1] = {}) =>
        startSaved({ ...snapshot, documents: edited(snapshot, { ...patch, operator }) }, enabled);
    assert.match(await start({ mode: 'manual-mcp' }, true), /start your assistant in its MCP client/);
    await assert.rejects(start({ mode: 'chatgpt-events' }, true), /Connect automatic wake-ups in ChatGPT first/);
    live.online = true;
    live.subscriptions = 1;
    await assert.rejects(start({ mode: 'chatgpt-events' }, true), /needs a public domain/);
    const domain = { environment: { DISCORDINATOR_RESOURCE_URL: 'https://bot.example.com/mcp' } };
    assert.match(await start({ mode: 'chatgpt-events' }, true, domain), /wake-up connection selected/);
    assert.equal((await readOperatorConfig()).enabled, true);
    assert.match(await start({ mode: 'chatgpt-events' }, false), /Local assistant paused/);
    assert.equal((await readOperatorConfig()).enabled, false);
    await writeFile(
        statusFile,
        JSON.stringify({
            gateway: 'ready',
            events: { subscriptions: 1 },
            operator: { mode: 'off', appliedConfigAt: null, controller: { busy: 1 } },
        }),
    );
    await assert.rejects(start({ mode: 'manual-mcp' }, false), /still working/);
    await writeFile(
        statusFile,
        JSON.stringify({
            gateway: 'ready',
            events: { subscriptions: 1 },
            operator: { mode: 'off', appliedConfigAt: null, activeEventId: 'event' },
        }),
    );
    await assert.rejects(start({ mode: 'chatgpt-events' }, true, domain), /A local request is running/);
    live.online = false;
    await assert.rejects(start({ mode: 'chatgpt-events' }, true, domain), /Connect automatic wake-ups/);
    live.subscriptions = 0;
    assert.match(
        await start({ mode: 'manual-mcp' }, false),
        /Request saved. Waiting for Discordinator to respond./,
        'a stopped bridge applies later',
    );
}

async function checkMessages(live: LiveFake): Promise<void> {
    await writeFile('.env', `${environment.replace('not-a-port', '8787')}\nDISCORDINATOR_RESOURCE_URL=https://bot.example.com/mcp\n`);
    await writeOperatorConfig({ ...(await readOperatorConfig()), mode: 'manual-mcp', enabled: false });
    await writeFile('policy.json', '{"mcpEvents":{"enabled":false}}\n');
    live.online = true;
    const save = async (operator: Record<string, unknown>, reconnect = noReconnect) => {
        const snapshot = await readPanel();
        return (await applyDraft(snapshot, edited(snapshot, { operator }), reconnect)).message;
    };
    const chatgpt = await save({ mode: 'chatgpt-events' });
    assert.match(chatgpt, /ChatGPT has no wake-up connection/, 'switching to ChatGPT without a wake-up connection warns');
    assert.match(chatgpt, /Wake-up events are now allowed/);
    assert.match(await save({ mode: 'manual-mcp' }), /Another MCP app is now the primary responder/);
    const failed = await save({ instructions: 'Changed' }, () => Promise.resolve(() => Promise.reject(new Error('plain failure'))));
    assert.match(failed, /^Saved, but plain failure/);
    live.online = false;
    assert.match(await save({ instructions: 'Later' }), /takes over once Discordinator finishes/, 'a stopped bridge applies later');
}

export async function checkPanelStore(directory: string): Promise<void> {
    await inScratch(directory, async () => {
        const live = liveFake();
        await withLocal(live, async () => {
            await checkReading();
            await checkRefusals();
            await checkRollback();
            checkWorkBlocks();
            await checkStarting(live);
            await checkMessages(live);
        });
        await rm(join('.data', 'runtime.lock'), { force: true });
    });
}
