import { policySchema, type ScopeList } from '../core/config.js';
import { Policy } from '../core/policy.js';
import { DiscordApi } from '../discord/api.js';

type Named = { id: string; name: string; bot?: boolean };
export interface ServerInfo {
    id: string;
    name: string;
    channels: Named[];
    members: Named[];
    roles: Named[];
}
export interface BotServers {
    bot: string;
    botId: string;
    servers: ServerInfo[];
}
type RawChannel = { id: string; name?: string; type?: number };
type RawMember = { nick?: string | null; user: { id: string; username: string; global_name?: string | null; bot?: boolean } };
type RawRole = { id: string; name: string; managed?: boolean };
const textTypes = new Set([0, 5, 15]);

function memberName(member: RawMember): Named {
    const display = member.nick ?? member.user.global_name ?? member.user.username;
    return {
        id: member.user.id,
        name: display === member.user.username ? `@${display}` : `${display} (@${member.user.username})`,
        ...(member.user.bot ? { bot: true } : {}),
    };
}

async function loadServer(api: DiscordApi, guild: { id: string; name?: string }, botId: string): Promise<ServerInfo> {
    const read = <T>(route: string) => api.get(route).catch(() => []) as Promise<T[]>;
    const [channels, members, roles] = await Promise.all([
        read<RawChannel>(`/guilds/${guild.id}/channels`),
        read<RawMember>(`/guilds/${guild.id}/members?limit=1000`),
        read<RawRole>(`/guilds/${guild.id}/roles`),
    ]);
    return {
        id: guild.id,
        name: guild.name ?? guild.id,
        channels: channels
            .filter((channel) => textTypes.has(channel.type ?? -1))
            .map((channel) => ({ id: channel.id, name: channel.name ?? channel.id })),
        members: members
            .filter((member) => member.user.id !== botId)
            .map(memberName)
            .sort((a, b) => a.name.localeCompare(b.name)),
        roles: roles.filter((role) => role.id !== guild.id && !role.managed).map((role) => ({ id: role.id, name: role.name })),
    };
}

export async function listServers(token: string): Promise<BotServers> {
    const api = new DiscordApi(token, new Policy(policySchema.parse({})));
    const bot = (await api.get('/users/@me')) as { id?: string; username?: string; bot?: boolean };
    if (!bot.id || !bot.bot) throw new Error('Token did not resolve to a Discord bot identity.');
    const guilds = (await api.get('/users/@me/guilds').catch(() => [])) as { id: string; name?: string }[];
    const servers = await Promise.all(guilds.slice(0, 25).map((guild) => loadServer(api, guild, bot.id!)));
    return { bot: `${bot.username ?? 'bot'} (${bot.id})`, botId: bot.id, servers };
}

export function uniqueMembers(servers: readonly ServerInfo[]): Named[] {
    return [...new Map(servers.flatMap((server) => server.members).map((member) => [member.id, member])).values()];
}

function setScope(list: ScopeList, id: string, on: boolean): ScopeList {
    const allowed = list.allowed.filter((item) => item !== id);
    const blocked = list.blocked.filter((item) => item !== id);
    return list.mode === 'allowlist'
        ? { ...list, allowed: on ? [...allowed, id] : allowed, blocked }
        : { ...list, allowed, blocked: on ? blocked : [...blocked, id] };
}

const scopes = (policy: Record<string, unknown>) => policySchema.parse(policy);

export function serverState(policy: Record<string, unknown>, server: ServerInfo): { allowed: boolean; channels: string[] } {
    const parsed = new Policy(scopes(policy));
    return {
        allowed: parsed.guildAllowed(server.id),
        channels: server.channels.filter((channel) => parsed.channelAllowed(channel.id)).map((channel) => channel.id),
    };
}

export function withServerAllowed(policy: Record<string, unknown>, id: string, on: boolean): Record<string, unknown> {
    return { ...policy, servers: setScope(scopes(policy).servers, id, on) };
}

export function withServerChannels(
    policy: Record<string, unknown>,
    server: ServerInfo,
    chosen: readonly string[],
): Record<string, unknown> {
    let channels = scopes(policy).channels;
    for (const channel of server.channels) channels = setScope(channels, channel.id, chosen.includes(channel.id));
    return { ...policy, channels };
}
