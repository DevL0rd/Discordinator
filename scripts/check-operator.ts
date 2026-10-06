import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { defaultOperatorConfig, readOperatorConfig, writeOperatorConfig } from '../src/operator/config.js';
import { activationBlock, endpointError, publicEndpoint, timeoutError } from '../src/operator/setup-model.js';
import { parseServiceStatus, startBlocked } from '../src/operator/service-status.js';

function checkReadiness(): void {
    const absent = parseServiceStatus('LoadState=not-found\nActiveState=inactive\n');
    const stopped = parseServiceStatus('LoadState=loaded\nActiveState=inactive\n');
    const active = parseServiceStatus('LoadState=loaded\nActiveState=active\n');
    assert.equal(absent.installed, false);
    assert.equal(stopped.installed, true);
    assert.equal(stopped.active, false);
    assert.equal(active.active, true);
    assert.equal(startBlocked(absent, true, false), true, 'manual listener prevents managed start');
    assert.equal(startBlocked(absent, false, true), true, 'live manual PID prevents managed start');
    assert.equal(startBlocked(active, false, false), true, 'existing managed service is not restarted on install');
    assert.equal(startBlocked(stopped, false, false), false);
}

export async function checkOperator(): Promise<void> {
    assert.equal(defaultOperatorConfig().workspace, homedir());
    checkReadiness();
    assert.equal(publicEndpoint('bot.example.com'), 'https://bot.example.com/mcp');
    for (const bad of [
        'http://bot.example.com',
        'localhost',
        '127.0.0.1',
        '10.0.0.1',
        'https://u:p@bot.example.com',
        'https://bot.example.com/?token=x',
    ])
        assert.ok(endpointError(bad), bad);
    assert.equal(timeoutError('600'), undefined);
    for (const bad of ['0', '1801', '3.5', 'abc']) assert.ok(timeoutError(bad));
    const live = {
        gateway: 'ready',
        operator: { mode: 'disabled', activeEventId: null, appliedConfigAt: null },
        events: { subscriptions: 1 },
    };
    assert.equal(
        activationBlock({ ...defaultOperatorConfig(), mode: 'codex-local' }, live, true),
        undefined,
        'connected wake-ups never block a local responder',
    );
    assert.equal(activationBlock({ ...defaultOperatorConfig(), mode: 'chatgpt-events' }, live, true), undefined);
    assert.match(activationBlock(defaultOperatorConfig(), null, true)!, /unavailable/);
    assert.match(
        activationBlock(defaultOperatorConfig(), { ...live, operator: { ...live.operator, activeEventId: 'active' } }, true)!,
        /running/,
    );
    const directory = await mkdtemp(join(tmpdir(), 'discordinator-operator-'));
    try {
        const path = join(directory, 'operator.json');
        assert.equal((await readOperatorConfig(path)).mode, 'chatgpt-poll');
        const config = { ...defaultOperatorConfig(), mode: 'codex-local' as const, enabled: true };
        await writeOperatorConfig(config, path);
        assert.equal((await readOperatorConfig(path)).mode, 'codex-local');
        assert.equal((await readFile(path, 'utf8')).includes('token'), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
