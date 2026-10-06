import { claudeProgram } from './executables.js';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { dirname, join, resolve } from 'node:path';
import { buildDiscordinator } from './install.js';
import { runFile, type Runner } from './run.js';

const marketplace = 'discordinator-local';
const plugin = 'discordinator';
const pluginId = `${plugin}@${marketplace}`;

export interface PluginState {
    cli: boolean;
    marketplace: boolean;
    installed: boolean;
    enabled: boolean;
}

function pluginFiles(home: string): Record<string, unknown> {
    const description = 'Discord messages from Discordinator arrive in this Claude session, and replies go back to the same conversation.';
    return {
        '.claude-plugin/marketplace.json': {
            name: marketplace,
            description: 'Discordinator plugins generated on this computer',
            owner: { name: 'Discordinator' },
            plugins: [{ name: plugin, description, source: `./${plugin}` }],
        },
        [`${plugin}/.claude-plugin/plugin.json`]: {
            name: plugin,
            version: '1.0.0',
            description,
            author: { name: 'DevL0rd' },
            keywords: ['discord', 'channel'],
        },
        [`${plugin}/.mcp.json`]: {
            mcpServers: {
                discordinator: {
                    command: process.execPath,
                    args: [join(home, 'dist/src/channel/bridge.js')],
                    env: { DISCORDINATOR_HOME: home },
                },
            },
        },
    };
}

async function writeIfChanged(path: string, value: unknown): Promise<boolean> {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if ((await readFile(path, 'utf8').catch(() => '')) === text) return false;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(`${path}.tmp`, text, { mode: 0o600 });
    await replaceFile(`${path}.tmp`, path);
    return true;
}

async function claudeJson(args: string[], run: Runner): Promise<unknown> {
    const claude = await claudeProgram();
    const { stdout } = await run(claude.command, [...claude.args, ...args, '--json'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const line = stdout.trim().split('\n').at(-1) ?? '[]';
    return JSON.parse(stdout.trim().startsWith('[') ? stdout : line);
}

export async function pluginState(run: Runner = runFile): Promise<PluginState> {
    try {
        const [plugins, marketplaces] = (await Promise.all([
            claudeJson(['plugin', 'list'], run),
            claudeJson(['plugin', 'marketplace', 'list'], run),
        ])) as [{ id: string; enabled?: boolean }[], { name: string }[]];
        const installed = plugins.find((item) => item.id === pluginId);
        return {
            cli: true,
            marketplace: marketplaces.some((item) => item.name === marketplace),
            installed: Boolean(installed),
            enabled: installed?.enabled !== false && Boolean(installed),
        };
    } catch {
        return { cli: false, marketplace: false, installed: false, enabled: false };
    }
}

export async function runClaude(args: string[], run: Runner = runFile): Promise<void> {
    const claude = await claudeProgram();
    await run(claude.command, [...claude.args, ...args], { timeout: 120_000 });
}

async function register(root: string, before: PluginState, changed: boolean, run: Runner): Promise<void> {
    if (!before.marketplace) await runClaude(['plugin', 'marketplace', 'add', root, '--scope', 'user'], run);
    else if (changed) await runClaude(['plugin', 'marketplace', 'update', marketplace], run);
    if (!before.installed) await runClaude(['plugin', 'install', pluginId, '--scope', 'user'], run);
    else if (changed) await runClaude(['plugin', 'update', pluginId], run);
    if (before.installed && !before.enabled) await runClaude(['plugin', 'enable', pluginId], run);
}

export async function installPlugin(home = process.cwd(), run: Runner = runFile): Promise<string> {
    const root = resolve(home, '.data/claude-plugin');
    await buildDiscordinator(run);
    await access(join(home, 'dist/src/channel/bridge.js'));
    let changed = false;
    for (const [path, value] of Object.entries(pluginFiles(resolve(home))))
        changed = (await writeIfChanged(join(root, path), value)) || changed;
    const before = await pluginState(run);
    if (!before.cli) throw new Error('Claude Code is not installed or not signed in. Install it, run claude once, then try again.');
    await register(root, before, changed, run);
    const after = await pluginState(run);
    if (!after.installed || !after.enabled) throw new Error('Claude did not report the Discordinator plugin as installed and enabled.');
    return 'Discordinator plugin installed in Claude Code. Start a Claude session to begin listening.';
}

export async function uninstallPlugin(run: Runner = runFile): Promise<string> {
    if ((await pluginState(run)).installed) await runClaude(['plugin', 'uninstall', pluginId], run);
    if ((await pluginState(run)).installed) throw new Error('Claude Code still lists the Discordinator plugin.');
    return 'Discordinator removed from Claude Code.';
}
