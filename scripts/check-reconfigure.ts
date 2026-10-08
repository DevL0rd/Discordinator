import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../src/core/config.js';
import { DiscordApi } from '../src/discord/api.js';
import { PolicyWatcher } from '../src/operator/policy-watcher.js';
import { baseEnvironment, changedKeys, environmentStamp, parseEnvironment, reconfigure, watchEnvironment } from '../src/reconfigure.js';
import { until } from './discord-fakes.js';
import { fixture, ids } from './fixtures.js';

const token = 'local-validation-fixture-never-a-real-credential';
const env = (extra = '') => `DISCORD_BOT_TOKEN=bot-token-one\nDISCORDINATOR_MCP_TOKEN=${token}\n${extra}`;

function target(fail = '') {
    const steps: string[] = [];
    const step = (name: string) => () => {
        steps.push(name);
        return fail === name ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve();
    };
    return { steps, target: { movePolicy: step('policy'), restartListener: step('listener'), reconnectGateway: step('gateway') } };
}

function checkParsing(): void {
    const config = parseEnvironment({}, env());
    assert.equal(config.DISCORDINATOR_RESOURCE_URL, 'http://127.0.0.1:8787/mcp', 'The local resource URL is derived from the port');
    assert.throws(() => parseEnvironment({}, 'DISCORD_BOT_TOKEN=x\nDISCORDINATOR_MCP_TOKEN=short'), /Invalid MCP credential/);
    assert.throws(() => parseEnvironment({}, 'DISCORDINATOR_PORT=1'), /Invalid environment configuration/);
    const base = baseEnvironment(
        { PATH: '/bin', GEMINI_API_KEY: 'from-file', DISCORDINATOR_PORT: '9000' },
        'GEMINI_API_KEY=from-file\nDISCORDINATOR_PORT=8787',
    );
    assert.deepEqual(
        base,
        { PATH: '/bin', DISCORDINATOR_PORT: '9000' },
        'Values loaded from .env are dropped so removing them later works',
    );
    assert.deepEqual(changedKeys(config, { ...config, GEMINI_API_KEY: 'gemini-key' }), ['GEMINI_API_KEY']);
}

async function checkReconfigure(): Promise<void> {
    const config = parseEnvironment({}, env('GEMINI_API_KEY=old-gemini-key'));
    const live = target();
    assert.deepEqual(await reconfigure(config, { ...config }, live.target), [], 'Nothing changes when nothing changed');
    assert.deepEqual(await reconfigure(config, parseEnvironment({}, env('GEMINI_API_KEY=new-gemini-key')), live.target), [
        'GEMINI_API_KEY',
    ]);
    assert.deepEqual([config.GEMINI_API_KEY, live.steps], ['new-gemini-key', []], 'Keys change in place without rebuilding anything');
    await reconfigure(config, parseEnvironment({}, env()), live.target);
    assert.equal('GEMINI_API_KEY' in config, false, 'A removed key is removed');
    await reconfigure(config, parseEnvironment({}, env('DISCORDINATOR_MESSAGE_CONTENT=false')), live.target);
    await reconfigure(
        config,
        parseEnvironment({}, env('DISCORDINATOR_MESSAGE_CONTENT=false\nDISCORDINATOR_PORT=9100\nDISCORDINATOR_POLICY_FILE=other.json')),
        live.target,
    );
    assert.deepEqual(live.steps, ['gateway', 'policy', 'listener'], 'Only the affected parts are rebuilt');
    const before = { ...config };
    const broken = target('listener');
    const moved = env(
        'DISCORDINATOR_MESSAGE_CONTENT=false\nDISCORDINATOR_PORT=9200\nDISCORDINATOR_POLICY_FILE=other.json\nDISCORD_BOT_TOKEN=bot-token-two',
    );
    await assert.rejects(reconfigure(config, parseEnvironment({}, moved), broken.target), /listener failed/);
    assert.deepEqual(config, before, 'A failed change is rolled back');
    assert.deepEqual(broken.steps, ['listener', 'listener'], 'Only what was touched is restored; the Discord connection is left alone');
    const signedIn: Config = {
        ...parseEnvironment({}, env()),
        DISCORDINATOR_AUTH_MODE: 'oauth',
        DISCORDINATOR_OAUTH_SERVER: 'bundled',
        DISCORDINATOR_OAUTH_SUBJECTS: 'owner-subject',
    };
    const saved = { ...signedIn, DISCORDINATOR_OAUTH_SUBJECTS: '', GEMINI_API_KEY: 'new-gemini-key' };
    assert.deepEqual(await reconfigure(signedIn, saved, target().target), ['GEMINI_API_KEY']);
    assert.equal(signedIn.DISCORDINATOR_OAUTH_SUBJECTS, 'owner-subject', 'Saving .env keeps the bundled sign-in owner');
}

async function checkWatcher(directory: string): Promise<void> {
    const path = join(directory, 'live.env');
    await writeFile(path, env());
    const applied: Config[] = [];
    const stamps: string[] = [];
    const invalid: string[] = [];
    const errors: string[] = [];
    const log = console.error;
    console.error = (message: string) => errors.push(message);
    const stop = watchEnvironment(
        path,
        {},
        (next, stamp) => {
            applied.push(next);
            stamps.push(stamp);
            return Promise.resolve();
        },
        (stamp) => invalid.push(stamp),
    );
    try {
        await writeFile(path, env('GEMINI_API_KEY=watched-key'));
        await until(() => applied.length === 1, 'a saved .env is applied');
        assert.equal(applied[0]!.GEMINI_API_KEY, 'watched-key');
        assert.deepEqual(stamps, [environmentStamp(env('GEMINI_API_KEY=watched-key'))], 'each applied .env is identified by its stamp');
        await writeFile(path, 'DISCORDINATOR_PORT=1');
        await until(() => errors.length === 1, 'an invalid .env is reported');
        assert.match(errors[0]!, /could not be applied; the current settings stay in effect/);
        assert.equal(applied.length, 1, 'Invalid settings are never applied');
        assert.deepEqual(invalid, [environmentStamp('DISCORDINATOR_PORT=1')], 'and the setup app is told that exact version failed');
    } finally {
        stop();
        console.error = log;
    }
}

async function checkPolicyMove(directory: string): Promise<void> {
    const f = fixture(join(directory, 'move.json'));
    const other = join(directory, 'other-policy.json');
    await writeFile(other, JSON.stringify({ allowedUserIds: [ids.denied] }));
    const watcher = new PolicyWatcher(join(directory, 'missing.json'), f.policy);
    watcher.start();
    const log = console.error;
    console.error = () => undefined;
    try {
        await watcher.move(other);
    } finally {
        console.error = log;
        await watcher.stop();
    }
    assert.deepEqual([watcher.path, f.policy.config.allowedUserIds], [other, [ids.denied]], 'A new policy file is loaded at once');
    const api = new DiscordApi('first-token', f.policy);
    api.setToken('second-token');
}

export async function checkReconfigureLive(directory: string): Promise<void> {
    checkParsing();
    await checkReconfigure();
    await checkWatcher(directory);
    await checkPolicyMove(directory);
}
