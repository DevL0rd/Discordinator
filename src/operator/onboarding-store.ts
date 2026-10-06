import { randomBytes } from 'node:crypto';
import { listServers, uniqueMembers } from './servers.js';
import { requestOwnerPassword } from '../oauth/provision.js';
import { oauthDirectory } from '../oauth/registration.js';
import { codexCommand } from './codex-config.js';
import { claudeProgram } from './executables.js';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { parseEnv } from 'node:util';
import { policySchema, snowflake, type PolicyConfig } from '../core/config.js';
import { DiscordApi } from '../discord/api.js';
import { Policy, admit } from '../core/policy.js';
import { readOperatorConfig, writeOperatorConfig, type OperatingMode } from './config.js';
import { domainEndpoint, editPublicDomain } from './connection-domain.js';
import { probeConnection } from './onboarding-connection.js';

const exec = promisify(execFile);
export interface DiscordDraft {
    token: string;
    ownerId: string;
    channelId: string;
}
export interface DiscordIdentity {
    bot: string;
    owner: string;
    channel: string;
    guildId: string;
}
export type AiChoice = OperatingMode;
export interface OnboardingFiles {
    environment?: string;
    policy?: string;
    marker?: string;
}
export type OnboardingPhase = 'discord' | 'ai' | 'service' | 'verify' | 'complete';
const read = async (path: string) =>
    readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
    });

export async function onboardingPhase(environment: Record<string, unknown>, marker = '.data/onboarding.json'): Promise<OnboardingPhase> {
    const token = environment.DISCORD_BOT_TOKEN;
    if (typeof token !== 'string' || !token.trim()) return 'discord';
    const saved = await read(marker);
    if (!saved) return 'complete';
    try {
        const phase = (JSON.parse(saved) as { phase?: unknown }).phase;
        return phase === 'ai' || phase === 'service' || phase === 'verify' || phase === 'complete' ? phase : 'discord';
    } catch {
        return 'discord';
    }
}
export async function needsOnboarding(environment: Record<string, unknown>, marker?: string): Promise<boolean> {
    return (await onboardingPhase(environment, marker)) !== 'complete';
}
export interface DiscordDiscovery {
    bot: string;
    botId: string;
    servers: string[];
    intents: { messageContent: boolean; members: boolean };
    members: { id: string; name: string }[];
    channels: { id: string; name: string; guild: string }[];
}
export async function discoverDiscord(token: string): Promise<DiscordDiscovery> {
    const { bot, botId, servers } = await listServers(token);
    const api = new DiscordApi(token, new Policy(policySchema.parse({})));
    const flags = Number(((await api.get('/applications/@me').catch(() => ({}))) as { flags?: number }).flags ?? 0);
    return {
        bot,
        botId,
        servers: servers.map((server) => server.name),
        members: uniqueMembers(servers),
        intents: { messageContent: (flags & (0b11 << 18)) !== 0, members: (flags & (0b11 << 14)) !== 0 },
        channels: servers.flatMap((server) => server.channels.map((channel) => ({ ...channel, guild: server.name }))),
    };
}
export async function verifyDiscord(draft: DiscordDraft): Promise<DiscordIdentity> {
    snowflake.parse(draft.ownerId);
    snowflake.parse(draft.channelId);
    const api = new DiscordApi(draft.token, new Policy(policySchema.parse({})));
    const [bot, owner, channel] = (await Promise.all([
        api.get('/users/@me'),
        api.get(`/users/${draft.ownerId}`),
        api.get(`/channels/${draft.channelId}`),
    ])) as [
        { id?: string; username?: string; bot?: boolean },
        { id?: string; username?: string; bot?: boolean },
        { id?: string; name?: string; guild_id?: string; type?: number },
    ];
    if (!bot.id || !bot.bot) throw new Error('Token did not resolve to a Discord bot identity.');
    if (owner.id !== draft.ownerId || owner.bot) throw new Error('Owner must resolve to the selected human Discord user.');
    if (channel.id !== draft.channelId || !channel.guild_id) throw new Error('Channel must resolve to a Discord server channel.');
    return {
        bot: `${bot.username ?? 'bot'} (${bot.id})`,
        owner: `${owner.username ?? 'owner'} (${owner.id})`,
        channel: `${channel.name ?? 'channel'} (${channel.id})`,
        guildId: channel.guild_id,
    };
}
function envText(original: string, values: Record<string, string>): string {
    let text = original;
    for (const [key, value] of Object.entries(values)) {
        const encoded = JSON.stringify(value);
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        text = pattern.test(text) ? text.replace(pattern, `${key}=${encoded}`) : `${text.trimEnd()}\n${key}=${encoded}\n`;
    }
    return text;
}
function mergedPolicy(original: string, draft: DiscordDraft, identity: DiscordIdentity): PolicyConfig {
    const policy = policySchema.parse(original ? JSON.parse(original) : {});
    return policySchema.parse({
        ...policy,
        allowedUserIds: [...new Set([...policy.allowedUserIds, draft.ownerId])],
        servers: admit(policy.servers, identity.guildId),
        channels: admit(policy.channels, draft.channelId),
        scopes: [...new Set([...policy.scopes, 'messages.read', 'messages.write'])],
    });
}
async function atomicWrite(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.onboarding.tmp`;
    await writeFile(temporary, text, { mode: 0o600, flush: true });
    await rename(temporary, path);
}
export async function saveDiscord(draft: DiscordDraft, identity: DiscordIdentity, files: OnboardingFiles = {}): Promise<void> {
    const environmentPath = files.environment ?? '.env';
    const originalEnvironment = await read(environmentPath);
    const environment = parseEnv(originalEnvironment);
    const policyPath = files.policy ?? environment.DISCORDINATOR_POLICY_FILE ?? 'policy.json';
    const originalPolicy = await read(policyPath);
    const policy = mergedPolicy(originalPolicy, draft, identity);
    const values: Record<string, string> = { DISCORD_BOT_TOKEN: draft.token, DISCORDINATOR_POLICY_FILE: policyPath };
    if (!environment.DISCORDINATOR_MCP_TOKEN) values.DISCORDINATOR_MCP_TOKEN = randomBytes(32).toString('base64url');
    if (!environment.DISCORDINATOR_AUTH_MODE) values.DISCORDINATOR_AUTH_MODE = 'bearer';
    await writePhase('ai', files.marker);
    await atomicWrite(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    await atomicWrite(environmentPath, envText(originalEnvironment, values));
}
export async function writePhase(phase: Exclude<OnboardingPhase, 'discord'>, marker = '.data/onboarding.json'): Promise<void> {
    await atomicWrite(marker, `${JSON.stringify({ phase })}\n`);
}
async function cliAuthenticated(command: 'claude' | 'codex', args: string[]): Promise<void> {
    try {
        const cli = command === 'codex' ? await codexCommand() : { ...(await claudeProgram()), env: process.env };
        const { stdout, stderr } = await exec(cli.command, [...cli.args, ...args], { env: cli.env, timeout: 8_000, maxBuffer: 128 * 1024 });
        if (command === 'codex') {
            if (!/Logged in using (ChatGPT|an API key)/.test(`${stdout}\n${stderr}`)) throw new Error('not authenticated');
        } else {
            const status = JSON.parse(stdout) as { loggedIn?: boolean; authenticated?: boolean };
            if (status.loggedIn !== true && status.authenticated !== true) throw new Error('not authenticated');
        }
    } catch {
        throw new Error(`${command} is unavailable or not authenticated. Sign in with the provider CLI, then retry.`);
    }
}
export async function validateAi(choice: AiChoice, endpoint = ''): Promise<string> {
    const validators: Record<AiChoice, () => Promise<string>> = {
        'codex-local': async () => {
            await cliAuthenticated('codex', ['login', 'status']);
            return 'Codex CLI reported authenticated.';
        },
        'claude-session': () => claudeReady(),
        'chatgpt-events': () => cloudValidation(endpoint),
        'chatgpt-poll': () => cloudValidation(endpoint),
        'manual-mcp': async () => validateManual(endpoint),
    };
    return validators[choice]();
}
async function claudeReady(): Promise<string> {
    await cliAuthenticated('claude', ['auth', 'status', '--json']);
    return 'Claude Code is installed and signed in.';
}
async function cloudValidation(domain: string): Promise<string> {
    const url = domainEndpoint(domain);
    return `Domain format valid. ${await probeConnection(url)} Finish the handoff in ChatGPT; Save keeps it paused.`;
}
async function validateManual(endpoint: string): Promise<string> {
    if (!/^https?:\/\//i.test(endpoint.trim())) throw new Error('Enter the full endpoint URL, including https:// and the path.');
    const url = new URL(endpoint.trim());
    if (url.username || url.password || url.search || url.hash)
        throw new Error('Manual endpoint must not contain credentials, query, or fragment.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
        throw new Error('Manual endpoint must use public HTTPS or loopback HTTP.');
    return `Format valid. ${await probeConnection(url.href)} Save keeps it paused.`;
}
function connectionDomain(value: string): { resourceUrl: string } {
    return { resourceUrl: domainEndpoint(value) };
}
async function saveDomain(endpoint: string, files: OnboardingFiles): Promise<void> {
    const environmentPath = files.environment ?? '.env';
    const original = await read(environmentPath);
    const before = parseEnv(original);
    const after = editPublicDomain(before, endpoint);
    const updates = Object.fromEntries(
        Object.entries(after)
            .filter(([key, value]) => value !== before[key])
            .map(([key, value]) => [key, String(value)]),
    );
    await atomicWrite(environmentPath, envText(original, updates));
}
function endpointFor(choice: AiChoice, endpoint: string): string | undefined {
    if (choice.startsWith('chatgpt-')) return connectionDomain(endpoint).resourceUrl;
    if (choice === 'manual-mcp' && endpoint.startsWith('https://')) return endpoint.trim();
}
export async function saveAi(choice: AiChoice, endpoint = '', files: OnboardingFiles = {}): Promise<void> {
    const current = await readOperatorConfig();
    const publicUrl = endpointFor(choice, endpoint) ?? current.publicEndpoint;
    if (choice.startsWith('chatgpt-')) await saveDomain(endpoint, files);
    await writeOperatorConfig({ ...current, mode: choice, enabled: false, ...(publicUrl ? { publicEndpoint: publicUrl } : {}) });
    await atomicWrite('.data/operator-settings.json', `${JSON.stringify(await readOperatorConfig(), null, 2)}\n`);
    await writePhase('service', files.marker);
}

export async function savePassword(password: string, files: OnboardingFiles = {}): Promise<void> {
    const environment = parseEnv(await read(files.environment ?? '.env'));
    await requestOwnerPassword(oauthDirectory.parse(environment.DISCORDINATOR_OAUTH_DATA_DIR), password);
}
