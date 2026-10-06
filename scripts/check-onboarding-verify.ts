import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { savedPublicUrl, verifyChecks, verifyLines } from '../src/operator/onboarding-verify.js';
import { readOperatorConfig, writeOperatorConfig, type OperatingMode } from '../src/operator/config.js';
import { presenceFile } from '../src/operator/presence.js';
import { assistants, chatgptHowTo } from '../src/operator/ui/status.js';
import { inScratch, withLocal, type LiveFake } from './onboarding-fakes.js';

const summary = (checks: { label: string; ok: boolean }[]) => checks.map((check) => `${check.ok ? '+' : '-'} ${check.label}`);

async function select(mode: OperatingMode, enabled: boolean): Promise<void> {
    await writeOperatorConfig({ ...(await readOperatorConfig()), mode, enabled });
}

async function checkRunning(live: LiveFake): Promise<void> {
    assert.equal(await savedPublicUrl(), 'https:///mcp', 'without a domain the address is incomplete');
    await select('manual-mcp', false);
    const offline = await verifyChecks();
    assert.deepEqual(summary(offline), ['- Discordinator is running'], 'another MCP app only needs Discordinator running');
    const lines = verifyLines(offline);
    assert.equal(lines[0], '○ Discordinator is running');
    assert.match(lines[1]!, /^Next: Go back and install the background service/);
    live.online = true;
    assert.deepEqual(summary(await verifyChecks('manual-mcp')), ['+ Discordinator is running']);
    assert.deepEqual(verifyLines(await verifyChecks('manual-mcp')), ['✓ Discordinator is running', 'Everything is connected and working.']);
}

async function checkChatgpt(live: LiveFake): Promise<void> {
    await writeFile('.env', 'DISCORDINATOR_RESOURCE_URL="https://bot.example.com/mcp"\n');
    assert.equal(await savedPublicUrl(), 'https://bot.example.com/mcp');
    await select('chatgpt-poll', false);
    const waiting = await verifyChecks();
    assert.deepEqual(summary(waiting), [
        '+ Discordinator is running',
        '- ChatGPT is connected',
        '- Automatic wake-ups are on',
        `- ${assistants['chatgpt-events'].name} is answering`,
    ]);
    assert.match(waiting[1]!.hint, /create a connector named Discordinator with https:\/\/bot\.example\.com\/mcp/);
    assert.equal(waiting[2]!.hint, chatgptHowTo);
    assert.equal(waiting[3]!.start, true, 'the responder can be started from the wizard');
    assert.equal(waiting[3]!.hint, 'Choose Finish to start it.');
    await writeFile(presenceFile, JSON.stringify({ remoteAt: '2026-01-01T00:00:00.000Z', subscriptions: 1 }));
    live.subscriptions = 1;
    await select('chatgpt-events', true);
    assert.ok(
        (await verifyChecks()).every((check) => check.ok),
        'connected, waking up and answering',
    );
    live.mode = 'off';
    const switching = await verifyChecks('chatgpt-events');
    assert.equal(switching[3]!.ok, false);
    assert.equal(switching[3]!.hint, 'Discordinator is switching to it. Check again in a moment.');
    live.mode = undefined;
    live.blockedReason = 'Waiting for the public domain.';
    const blocked = await verifyChecks('chatgpt-events');
    assert.equal(blocked[3]!.ok, false, 'a blocked responder is not answering');
    assert.equal(blocked[3]!.hint, 'Waiting for the public domain.');
    live.blockedReason = undefined;
}

export async function checkOnboardingVerify(directory: string): Promise<void> {
    await inScratch(directory, async () => {
        const live: LiveFake = { subscriptions: 0, online: false, probes: [] };
        await withLocal(live, async () => {
            await checkRunning(live);
            await checkChatgpt(live);
        });
        assert.deepEqual(live.probes, [], 'verifying never reaches the public domain');
    });
}
