import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StatusWriter, statusFile } from '../src/operator/status-file.js';
import { activationBlock, liveSetupStatus } from '../src/operator/setup-model.js';
import { webConnectors } from '../src/operator/web-connectors.js';
import { planReconnect } from '../src/operator/reconnect.js';
import { defaultOperatorConfig } from '../src/operator/config.js';
import { stepView, type State } from '../src/operator/onboarding-copy.js';
import { ownerMatches } from '../src/operator/onboarding-invite.js';
import { wizardFrame } from '../src/operator/onboarding-view.js';
import { color } from '../src/operator/ui/theme.js';
import { hits, span, wrap } from '../src/operator/ui/canvas.js';
import { inScratch } from './onboarding-fakes.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function checkStatusWriter(): Promise<void> {
    let reads = 0;
    const writer = new StatusWriter(() => {
        reads++;
        return { same: true };
    });
    writer.touch();
    await tick();
    await writer.flushed();
    assert.equal(existsSync(statusFile), true);
    await rm(statusFile);
    writer.touch();
    await tick();
    await writer.flushed();
    assert.equal(reads, 2, 'the status is read on every touch');
    assert.equal(existsSync(statusFile), false, 'an unchanged status is not written again');
}

async function checkLiveStatus(): Promise<void> {
    await writeFile(join('.data', 'runtime.lock'), String(process.pid));
    await writeFile(statusFile, JSON.stringify({ operator: { mode: 'off' } }));
    assert.equal(await liveSetupStatus(), null, 'a status without events is not trusted');
    await writeFile(statusFile, 'null');
    assert.equal(await liveSetupStatus(), null);
    await rm(join('.data', 'runtime.lock'));
    const live = { gateway: 'ready', operator: { mode: 'off', appliedConfigAt: null }, events: { subscriptions: 0 } };
    assert.match(activationBlock(defaultOperatorConfig(), live, false)!, /Complete prerequisites first/);
    assert.equal(activationBlock(defaultOperatorConfig(), live, true), undefined);
}

async function checkWebState(): Promise<void> {
    await writeFile(join('.data', 'web-connectors.json'), JSON.stringify({ claude: 5 }));
    assert.deepEqual(await webConnectors(), {}, 'a damaged connector file reads as nothing added');
    await writeFile(join('.data', 'web-connectors.json'), JSON.stringify({ claude: 'https://bot.example.com/mcp' }));
    const change = { id: 'environment.DISCORDINATOR_OAUTH_SERVER', label: 'Sign-in', before: 'a', after: 'b', apply: 'restart' as const };
    const finish = await planReconnect([change], { DISCORDINATOR_RESOURCE_URL: 'https://bot.example.com/mcp' });
    assert.match(await finish(), /Because how apps sign in changed, add Claude \(web\) and ChatGPT \(web\) again/);
    assert.deepEqual(await webConnectors(), {}, 'and the old connectors are forgotten');
}

function checkWizardCopy(): void {
    const base: State = { step: 'connect', input: '', selected: 0, draft: { token: '', ownerId: '', channelId: '' } };
    assert.equal(stepView(base, 0).title, 'Connect Claude Code', 'Claude Code is the default app to connect');
    assert.equal(stepView({ ...base, choice: 'codex-local' }, 0).title, 'Connect Codex');
    assert.equal(stepView({ ...base, choice: 'manual-mcp' }, 0).title, 'Connect Claude Code', 'apps without a local client fall back');
    assert.deepEqual(ownerMatches(undefined, 'any'), [], 'no discovery means no matches');
    const view = { stage: 1, title: 'Pick', body: ['First', '', 'Last'], options: ['a', 'b'], buttons: ['Back'], selected: 2, tick: 0 };
    const picked = wizardFrame(view, 80, 30)
        .map((row) => row.spans.map((item) => item.text).join(''))
        .join('\n');
    assert.ok(picked.includes(' Back ') && picked.includes('First') && picked.includes('Last'), 'buttons follow the options');
    const selected = wizardFrame(view, 80, 30).flatMap((row) => row.spans.filter((item) => item.target === 'btn:0'));
    assert.equal(selected[0]?.bg, color.violet, 'the button after the options can be selected');
    const plain = wizardFrame({ stage: 0, title: 'Go', body: [], buttons: ['Next', 'Stop'], selected: 0, tick: 0 }, 80, 30);
    assert.equal(
        plain.flatMap((row) => row.spans.filter((item) => item.target === 'btn:0'))[0]?.bg,
        color.violet,
        'without options the first button is selected',
    );
    const bare = wizardFrame({ stage: 0, title: 'Wait', body: [], selected: 0, tick: 0 }, 80, 30);
    assert.equal(hits(bare).length, 0, 'a step without buttons has nothing to click');
    assert.equal(span('a\u0007b\u009bc').text, 'a b c', 'control characters never reach the terminal');
    assert.deepEqual(wrap('   ', 10), [''], 'blank text still takes a row');
}

export async function checkSetupFiles(directory: string): Promise<void> {
    await inScratch(directory, async () => {
        await mkdir('.data', { recursive: true });
        await checkStatusWriter();
        await checkLiveStatus();
        await checkWebState();
    });
    checkWizardCopy();
}
