import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { loadConfig } from '../core/config.js';
import { readOperatorConfig, writeOperatorConfig } from './config.js';
import { runtimePresent } from './status.js';
import { bridgeListening, managedServiceStatus, startBlocked } from './service-status.js';

const exec = promisify(execFile);
const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

function serviceUnit(root: string, node: string, path: string): string {
    if (/[\n\r]/.test(root + path)) throw new Error('The Discordinator folder path and PATH cannot contain line breaks.');
    return `[Unit]\nDescription=Discordinator Discord MCP bridge\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${root}\nEnvironment=${quote(`PATH=${path}`)}\nExecStart=${quote(node)} --env-file=${quote(join(root, '.env'))} ${quote(join(root, 'dist/src/main.js'))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

const userPath = () =>
    (process.env.PATH ?? '')
        .split(delimiter)
        .filter((entry) => entry && !entry.includes(`${sep}node_modules${sep}`))
        .filter((entry, index, all) => all.indexOf(entry) === index)
        .join(delimiter);

export async function buildDiscordinator(): Promise<void> {
    await exec(process.execPath, ['node_modules/typescript/bin/tsc'], { timeout: 180_000 });
}

export async function installService(): Promise<string> {
    if (process.platform !== 'linux') throw new Error('Automatic service installation requires Linux systemd.');
    await loadConfig({ ...process.env, ...parseEnv(await readFile('.env', 'utf8')) });
    await buildDiscordinator();
    await writeOperatorConfig(await readOperatorConfig());
    const directory = join(homedir(), '.config/systemd/user');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'discordinator.service'), serviceUnit(process.cwd(), process.execPath, userPath()), {
        mode: 0o600,
    });
    await exec('systemctl', ['--user', 'daemon-reload']);
    await exec('systemctl', ['--user', 'enable', 'discordinator.service']);
    const state = await managedServiceStatus();
    if (startBlocked(state, await bridgeListening(), await runtimePresent()))
        return state.active
            ? 'Service installed and enabled; existing managed runtime left running. No restart performed.'
            : 'Installed / enabled, NOT started: existing manual runtime or listener detected. Arrange a safe manual-to-service transition, then start the service. No process was stopped.';
    await exec('systemctl', ['--user', 'start', 'discordinator.service']);
    await exec('systemctl', ['--user', 'is-active', '--quiet', 'discordinator.service']);
    return 'Service installed, enabled and running.';
}

export async function restartService(): Promise<string> {
    const state = await managedServiceStatus();
    if (!state.available || !state.installed || !state.active) throw new Error('No active managed service to restart.');
    await exec('systemctl', ['--user', 'restart', 'discordinator.service']);
    await exec('systemctl', ['--user', 'is-active', '--quiet', 'discordinator.service']);
    return 'Service restarted; environment and Discord policy changes applied.';
}
