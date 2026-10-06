import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localEndpoint, type LocalEndpoint } from '../mcp/local-client.js';
import { codexCommand, codexHome, serverBlock, withoutServers, writeCodexConfig } from './codex-config.js';
import { installPlugin, pluginState, uninstallPlugin } from './claude-plugin.js';

const exec = promisify(execFile);
const name = 'discordinator';
const stale = [name, 'dotbot'];
export type AppId = 'claude-code' | 'codex';
export const statusHint: Record<string, string> = {
    Connected: 'Everything is set up.',
    'Not connected': 'Press Connect to set it up.',
    'Address changed': 'Press Connect to update it to your current public address.',
    'Needs reconnect': 'Press Repair to connect it on this computer again.',
    'Not installed': 'Install the app on this computer first.',
    'Needs a public domain': 'Set your public domain below first.',
};
export const appNames: Record<AppId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
export const responderApps: Partial<Record<string, AppId>> = { 'claude-session': 'claude-code', 'codex-local': 'codex' };
export interface AppState {
    id: AppId;
    cli: boolean;
    connected: boolean;
    status: string;
}
type Runner = (command: string, args: string[]) => Promise<string>;
const run: Runner = async (command, args) =>
    (await exec(command, args, { cwd: tmpdir(), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

export interface CodexDeps {
    runner: Runner;
    codex(args: string[]): Promise<string>;
    home(): Promise<string>;
    endpoint(): Promise<LocalEndpoint>;
}
const runCodex = async (args: string[]) => {
    const { command, env } = await codexCommand();
    return (await exec(command, args, { cwd: tmpdir(), env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
};
const codexDeps: CodexDeps = { runner: run, codex: runCodex, home: codexHome, endpoint: () => localEndpoint() };

async function codexEntry(deps: CodexDeps): Promise<string | undefined> {
    const list = JSON.parse(await deps.codex(['mcp', 'list', '--json'])) as { name: string; transport?: { url?: string } }[];
    return list.find((item) => item.name === name)?.transport?.url;
}

async function codexState(deps: CodexDeps): Promise<AppState> {
    const url = await codexEntry(deps);
    const local = url === `${(await deps.endpoint()).base}/mcp`;
    if (!url) return { id: 'codex', cli: true, connected: false, status: 'Not connected' };
    return { id: 'codex', cli: true, connected: local, status: local ? 'Connected' : 'Needs reconnect' };
}

async function claudeState(): Promise<AppState> {
    const plugin = await pluginState();
    if (!plugin.cli) return { id: 'claude-code', cli: false, connected: false, status: 'Not installed' };
    const connected = plugin.installed && plugin.enabled;
    return { id: 'claude-code', cli: true, connected, status: connected ? 'Connected' : 'Not connected' };
}

export async function appState(id: AppId, deps = codexDeps): Promise<AppState> {
    try {
        return await (id === 'codex' ? codexState(deps) : claudeState());
    } catch {
        return { id, cli: false, connected: false, status: 'Not installed' };
    }
}

async function connectCodex(deps: CodexDeps): Promise<string> {
    await deps.codex(['--version']);
    const endpoint = await deps.endpoint();
    const url = `${endpoint.base}/mcp`;
    await writeCodexConfig(await deps.home(), (toml) => `${withoutServers(toml, stale)}\n\n${serverBlock(name, url, endpoint.key)}`);
    if ((await codexEntry(deps)) !== url) throw new Error('Codex did not pick up the Discordinator connection. Nothing else was changed.');
    return 'Codex connected to Discordinator on this computer. No sign-in needed.';
}

async function removeClaudeEntries(runner: Runner): Promise<void> {
    const file = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
    const config = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { mcpServers?: Record<string, unknown> };
    for (const entry of stale) if (config.mcpServers?.[entry]) await runner('claude', ['mcp', 'remove', entry, '--scope', 'user']);
}

async function connectClaude(runner: Runner): Promise<string> {
    const message = await installPlugin();
    await removeClaudeEntries(runner);
    return `${message} Every Claude Code session now has the Discord tools, no sign-in needed.`;
}

export async function connectApp(id: AppId, deps = codexDeps): Promise<string> {
    return id === 'codex' ? connectCodex(deps) : connectClaude(deps.runner);
}

export async function disconnectApp(id: AppId, deps = codexDeps): Promise<string> {
    if (id === 'claude-code') {
        const message = (await pluginState()).installed ? await uninstallPlugin() : 'The local Claude plugin is not installed.';
        await removeClaudeEntries(deps.runner);
        return message;
    }
    await writeCodexConfig(await deps.home(), (toml) => `${withoutServers(toml, stale)}\n`);
    if (await codexEntry(deps)) throw new Error('Codex still lists Discordinator. Remove it from Codex.');
    return 'Codex disconnected from Discordinator.';
}
