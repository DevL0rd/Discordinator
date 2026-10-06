import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { loadConfig } from '../core/config.js';
import { readOperatorConfig, writeOperatorConfig } from './config.js';
import { runtimePresent } from './status.js';
import { bridgeListening, managedServiceStatus, startBlocked } from './service-status.js';
import { installWindowsService, requestRestart, startWindowsService, supervisorPidFile, supervisorRunning } from './windows-service.js';
import { waitForFile } from './file-watch.js';
import { runFile, type Runner } from './run.js';

export interface ServiceHost {
    platform: NodeJS.Platform;
    home: string;
    run: Runner;
}
const localHost = (): ServiceHost => ({ platform: process.platform, home: homedir(), run: runFile });
const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

export function serviceUnit(root: string, node: string, path: string): string {
    if (/[\n\r]/.test(root + path)) throw new Error('The Discordinator folder path and PATH cannot contain line breaks.');
    return `[Unit]\nDescription=Discordinator Discord MCP bridge\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${root}\nEnvironment=${quote(`PATH=${path}`)}\nEnvironment=DISCORDINATOR_SERVICE=1\nExecStart=${quote(node)} --env-file=${quote(join(root, '.env'))} ${quote(join(root, 'dist/src/main.js'))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

const userPath = () =>
    (process.env.PATH ?? '')
        .split(delimiter)
        .filter((entry) => entry && !entry.includes(`${sep}node_modules${sep}`))
        .filter((entry, index, all) => all.indexOf(entry) === index)
        .join(delimiter);

export async function buildDiscordinator(run: Runner = runFile): Promise<void> {
    await run(process.execPath, ['node_modules/typescript/bin/tsc'], { timeout: 180_000 });
}

async function registerService({ platform, home, run }: ServiceHost): Promise<void> {
    if (platform === 'win32') return installWindowsService(process.cwd(), process.execPath, run);
    const directory = join(home, '.config/systemd/user');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'discordinator.service'), serviceUnit(process.cwd(), process.execPath, userPath()), {
        mode: 0o600,
    });
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', 'discordinator.service']);
}

async function startService({ platform, run }: ServiceHost): Promise<void> {
    if (platform !== 'win32') {
        await run('systemctl', ['--user', 'start', 'discordinator.service']);
        await run('systemctl', ['--user', 'is-active', '--quiet', 'discordinator.service']);
        return;
    }
    await rm(supervisorPidFile, { force: true });
    const started = waitForFile(supervisorPidFile, 15_000);
    await startWindowsService(process.cwd(), run);
    if (!(await started) || !(await supervisorRunning()))
        throw new Error('The Discordinator service did not start. See .data/service.log.');
}

export async function installService(host = localHost()): Promise<string> {
    if (host.platform !== 'linux' && host.platform !== 'win32')
        throw new Error('Automatic service installation supports Linux (systemd) and Windows.');
    await loadConfig({ ...process.env, ...parseEnv(await readFile('.env', 'utf8')) });
    await buildDiscordinator(host.run);
    await writeOperatorConfig(await readOperatorConfig());
    await registerService(host);
    const state = await managedServiceStatus(host.platform, host.run);
    if (startBlocked(state, await bridgeListening(), await runtimePresent()))
        return state.active
            ? 'Service installed and enabled; existing managed runtime left running. No restart performed.'
            : 'Installed / enabled, NOT started: existing manual runtime or listener detected. Arrange a safe manual-to-service transition, then start the service. No process was stopped.';
    await startService(host);
    return 'Service installed, enabled and running.';
}

export async function restartService({ platform, run } = localHost()): Promise<string> {
    const state = await managedServiceStatus(platform, run);
    if (!state.available || !state.installed || !state.active) throw new Error('No active managed service to restart.');
    if (platform === 'win32') {
        await requestRestart();
        return 'Restart requested. Discordinator restarts as soon as its current work is done.';
    }
    await run('systemctl', ['--user', 'restart', 'discordinator.service']);
    await run('systemctl', ['--user', 'is-active', '--quiet', 'discordinator.service']);
    return 'Service restarted; environment and Discord policy changes applied.';
}
