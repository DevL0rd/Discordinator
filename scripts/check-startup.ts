import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EventQueue } from '../src/core/queue.js';
import { localCall } from '../src/mcp/local-client.js';
import { readStatusFile, statusFile } from '../src/operator/status-file.js';
import { launch, type GatewayPort, type Host } from '../src/startup.js';
import { FakeApi } from './fixtures.js';
import { freePort, inDirectory, listen, until, withEnv } from './host-fixture.js';

const lockFile = join('.data', 'runtime.lock');
const refused = 'Discordinator could not start; check local configuration';

class FakeHost extends EventEmitter implements Host {
    exitCode?: typeof process.exitCode;
    exits: number[] = [];
    constructor(readonly env: NodeJS.ProcessEnv) {
        super();
    }
    exit(code: number): void {
        this.exits.push(code);
    }
}

class FakeGateway implements GatewayPort {
    onState?: () => void;
    stopped = 0;
    constructor(
        private readonly queue: EventQueue,
        private readonly refusal?: Error,
    ) {}
    start(): Promise<void> {
        this.onState?.();
        return this.refusal ? Promise.reject(this.refusal) : Promise.resolve();
    }
    stop(): void {
        this.queue.close();
        this.stopped++;
    }
    status() {
        return { gateway: this.refusal ? 'offline' : 'ready', droppedMessages: 0 };
    }
}

interface Started {
    host: FakeHost;
    lines: string[];
    gateway?: FakeGateway;
}

async function captured(work: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const { log, error } = console;
    console.log = (...parts: unknown[]) => lines.push(parts.join(' '));
    console.error = console.log;
    try {
        await work();
    } finally {
        console.log = log;
        console.error = error;
    }
    return lines;
}

async function start(env: NodeJS.ProcessEnv, refusal?: Error): Promise<Started> {
    const started: Started = { host: new FakeHost(env), lines: [] };
    started.lines = await captured(() =>
        launch({
            host: started.host,
            api: (_token, policy) => new FakeApi(policy),
            gateway: (_config, _policy, queue) => (started.gateway = new FakeGateway(queue, refusal)),
        }),
    );
    return started;
}

const settings = (port: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    DISCORD_BOT_TOKEN: 'fake-token-never-real',
    DISCORDINATOR_MCP_TOKEN: 'local-validation-fixture-never-a-real-credential',
    DISCORDINATOR_PORT: String(port),
    DISCORDINATOR_GUILD_MEMBERS: 'false',
    ...extra,
});

async function prepared<T>(root: string, name: string, work: () => Promise<T>): Promise<T> {
    return inDirectory(join(root, name), async () => {
        await mkdir('.data', { recursive: true });
        await writeFile('policy.json', '{}');
        const result = await work();
        await statusSettled();
        return result;
    });
}

async function statusSettled(): Promise<void> {
    const snapshot = () => `${existsSync(`${statusFile}.tmp`)}:${existsSync(statusFile) ? readFileSync(statusFile, 'utf8') : ''}`;
    let previous = snapshot();
    let quiet = 0;
    const settled = await eventually(() => {
        const current = snapshot();
        quiet = current === previous && !current.startsWith('true') ? quiet + 1 : 0;
        previous = current;
        return Promise.resolve(quiet >= 3);
    });
    assert.ok(settled, 'the status file settles before the scenario ends');
}

function refusedAt(started: Started, detail: { stage: string; error: string; code?: string }): void {
    const failed = `Discordinator startup failed ${JSON.stringify(detail)}`;
    assert.equal(started.host.exitCode, 1);
    assert.equal(started.lines.at(-1), refused);
    assert.ok(started.lines.includes(failed), started.lines.join('\n'));
    assert.ok(started.lines.includes('Discordinator initialization failed {"stage":"server","error":"Error"}'));
    assert.equal(started.gateway?.stopped, 1, 'a failed start stops the gateway');
    assert.equal(existsSync(lockFile), false, 'a failed start releases the runtime lock');
}

async function checkEarlyRefusals(root: string): Promise<void> {
    await inDirectory(join(root, 'unconfigured'), async () => {
        const started = await start({});
        assert.deepEqual(started.lines, [refused], 'missing configuration is refused before the lock');
        assert.equal(started.host.exitCode, 1);
        assert.equal(existsSync(lockFile), false);
    });
    await prepared(root, 'locked', async () => {
        await writeFile(lockFile, String(process.ppid));
        const started = await start(settings(await freePort()));
        assert.deepEqual(started.lines, [refused], 'a running instance keeps its lock');
        assert.equal(started.gateway, undefined);
        assert.equal(await readFile(lockFile, 'utf8'), String(process.ppid));
    });
    await prepared(root, 'oauth', async () => {
        const oauth = {
            DISCORDINATOR_AUTH_MODE: 'oauth',
            DISCORDINATOR_RESOURCE_URL: 'https://bot.example/mcp',
            DISCORDINATOR_TRUSTED_PROXIES: '127.0.0.1',
        };
        const started = await start(settings(await freePort(), oauth));
        assert.ok(
            started.lines.includes('Discordinator initialization failed {"stage":"oauth","error":"Error"}'),
            started.lines.join('\n'),
        );
        assert.equal(started.gateway, undefined, 'bundled OAuth without an owner stops before the runtime');
        assert.equal(existsSync(lockFile), false);
    });
}

async function checkStartupFailures(root: string): Promise<void> {
    await prepared(root, 'gateway', async () => {
        refusedAt(await start(settings(await freePort()), new Error('disallowed intents')), { stage: 'gateway', error: 'Error' });
    });
    await prepared(root, 'port', async () => {
        const { server, port } = await listen();
        try {
            refusedAt(await start(settings(port)), { stage: 'http', error: 'Error', code: 'EADDRINUSE' });
        } finally {
            await new Promise((done) => server.close(done));
        }
    });
    await prepared(root, 'events', async () => {
        await mkdir('.data', { recursive: true });
        await writeFile(join('.data', 'presence.json'), '{not json');
        refusedAt(await start(settings(await freePort())), { stage: 'events', error: 'SyntaxError' });
        await lockReleased();
    });
}

async function eventually(check: () => Promise<boolean>): Promise<boolean> {
    for (let attempt = 0; attempt < 150; attempt++) {
        if (await check()) return true;
        await new Promise((done) => setTimeout(done, 100));
    }
    return false;
}

async function lockReleased(): Promise<void> {
    await until(() => !existsSync(lockFile), 15_000);
}

async function checkRunning(root: string): Promise<void> {
    await prepared(root, 'running', async () => {
        const port = await freePort();
        await writeFile('.env', `DOTBOT_PORT=${port}\n`);
        const env = settings(port);
        delete env.DISCORDINATOR_PORT;
        const started = await start(env);
        assert.deepEqual(started.lines, [`Discordinator MCP listening on http://127.0.0.1:${port}/mcp`], 'a renamed setting is applied');
        assert.equal(started.host.exitCode, undefined);
        assert.equal(existsSync(lockFile), true);
        const endpoint = { base: `http://127.0.0.1:${port}`, key: (await readFile(join('.data', 'local.key'), 'utf8')).trim() };
        const tools = (await localCall(endpoint, 'tools/list')).tools as { name: string }[];
        assert.ok(tools.some((tool) => tool.name === 'discord_respond'));
        const ready = await eventually(async () => ((await readStatusFile()) as { gateway?: string } | null)?.gateway === 'ready');
        assert.ok(ready, 'the status file reflects the gateway');
        const failure = Object.assign(new Error('late'), { code: 'ELATE' });
        const reported = await captured(() => Promise.resolve(started.host.emit('unhandledRejection', failure)));
        assert.deepEqual(reported, ['Discordinator unhandled rejection {"stage":"runtime","error":"Error","code":"ELATE"}']);
        started.host.emit('SIGINT');
        await lockReleased();
        started.host.emit('SIGTERM');
        await new Promise((done) => setImmediate(done));
        assert.equal(started.gateway?.stopped, 1, 'shutdown happens once');
        assert.equal(started.host.exitCode, undefined);
        assert.deepEqual(started.host.exits, []);
        await assert.rejects(localCall(endpoint, 'tools/list'), 'the server is closed');
    });
}

async function checkRestart(root: string): Promise<void> {
    await prepared(root, 'restart', () =>
        withEnv({ DISCORDINATOR_SERVICE: '1' }, async () => {
            const started = await start(settings(await freePort()));
            let request = 0;
            const restarted = await captured(() =>
                eventually(async () => {
                    if (started.host.exits.length) return true;
                    await writeFile(join('.data', 'service-restart'), String(++request));
                    return false;
                }),
            );
            assert.deepEqual(started.host.exits, [75], 'a restart request stops and exits for the supervisor');
            assert.ok(restarted.some((line) => line.includes('service-restart changed')));
            assert.equal(existsSync(lockFile), false);
            assert.equal(started.gateway?.stopped, 1);
        }),
    );
}

async function checkFailedShutdown(root: string): Promise<void> {
    await prepared(root, 'failed-stop', async () => {
        const started = await start(settings(await freePort()));
        await rm(lockFile);
        started.host.emit('SIGTERM');
        await until(() => started.host.exitCode === 1, 15_000);
        assert.equal(started.gateway?.stopped, 1);
    });
}

export async function checkStartup(directory: string): Promise<void> {
    const root = resolve(directory, 'startup');
    await withEnv({ DISCORDINATOR_SERVICE: undefined }, async () => {
        await checkEarlyRefusals(root);
        await checkStartupFailures(root);
        await checkRunning(root);
        await checkRestart(root);
        await checkFailedShutdown(root);
    });
}
