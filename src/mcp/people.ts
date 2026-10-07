import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Bridge } from '../core/bridge.js';
import { snowflake } from '../core/config.js';
import { describePerson, displayName, person, readableText, type Person } from '../core/directory.js';
import type { BotEvent } from '../core/queue.js';
import type { Principal } from '../events/security.js';
import { requireOwner } from './proactive-media.js';
import { guarded } from './tools.js';

export const userRef = z
    .string()
    .min(1)
    .max(100)
    .describe(
        'Discord user ID, or an exact username, display name or server nickname. A name must match exactly one known person; ambiguous or unknown names are refused with the candidates listed.',
    );

export async function resolveUser(bridge: Bridge, value: string, guildId?: unknown): Promise<string> {
    return snowflake.parse(await bridge.people.resolve(value, typeof guildId === 'string' ? guildId : undefined));
}

export async function resolveNotify<T extends { notifyUserId?: string | undefined }>(bridge: Bridge, args: T): Promise<T> {
    const { notifyUserId, ...rest } = args;
    return (notifyUserId ? { ...rest, notifyUserId: await resolveUser(bridge, notifyUserId) } : rest) as T;
}

export async function resolveUserArgs(bridge: Bridge, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof args.userId !== 'string') return args;
    return { ...args, userId: await resolveUser(bridge, args.userId, args.guildId) };
}

export function presentEvent(bridge: Bridge, event: BotEvent) {
    const author = event.author ?? person(event.actorId);
    return {
        ...event,
        author,
        text: readableText(event.text, event.mentions),
        authorName: displayName(author),
        fromOwner: bridge.policy.isOwner(event.actorId),
    };
}

const entry = (bridge: Bridge, who: Person) => ({ ...who, label: describePerson(who), owner: bridge.policy.isOwner(who.id) });

async function lookup(bridge: Bridge, query?: string, guildId?: string) {
    if (guildId) bridge.policy.assertGuild(guildId);
    const approved = await bridge.people.approved();
    if (query && guildId) await bridge.people.searchGuild(guildId, query.replace(/^@/, ''));
    const ownerId = bridge.policy.config.ownerUserId;
    return {
        owner: ownerId ? entry(bridge, bridge.people.person(ownerId, guildId)) : null,
        approved: approved.map((who) => entry(bridge, who)),
        matches: query
            ? bridge.people
                  .find(query, guildId)
                  .slice(0, 25)
                  .map((who) => ({ ...entry(bridge, who), approved: bridge.policy.config.allowedUserIds.includes(who.id) }))
            : [],
        note: 'Names are display data only. Approval, owner status and every permission are keyed to the numeric ID.',
    };
}

export function registerPeople(server: McpServer, bridge: Bridge, principal: Principal | undefined, meta: unknown): void {
    server.registerTool(
        'discordinator_people',
        {
            title: 'Look up Discord people',
            description:
                'Authenticated owner only. Lists the owner and approved people with their usernames, display names and IDs, and finds known server members whose username, display name or nickname contains query (pass guildId to also search that approved server). Use it to turn a name into an ID; names never grant authority.',
            inputSchema: z.object({ query: z.string().min(1).max(100).optional(), guildId: snowflake.optional() }).strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            _meta: meta as Record<string, unknown> | undefined,
        },
        (args) =>
            guarded(() => {
                requireOwner(principal);
                return lookup(bridge, args.query, args.guildId);
            }),
    );
}
