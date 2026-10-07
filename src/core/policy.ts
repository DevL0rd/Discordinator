import type { PolicyConfig, Scope, ScopeList } from './config.js';

export const admit = (list: ScopeList, id: string): ScopeList => ({
    mode: list.mode,
    allowed: list.mode === 'allowlist' ? [...new Set([...list.allowed, id])] : list.allowed,
    blocked: list.blocked.filter((item) => item !== id),
});
const inScope = (list: ScopeList, id: string): boolean =>
    !list.blocked.includes(id) && (list.mode === 'blocklist' || list.allowed.includes(id));

export interface Origin {
    actorId: string;
    channelId: string;
    guildId: string | null;
    messageId?: string;
}

export class Policy {
    private readonly memberRoles = new Map<string, Map<string, Set<string>>>();

    private readonly listeners = new Set<(previous: PolicyConfig) => void>();

    constructor(public config: PolicyConfig) {}

    update(next: PolicyConfig): void {
        const previous = this.config;
        this.config = next;
        for (const listener of this.listeners) {
            try {
                listener(previous);
            } catch {
                console.error('A part of Discordinator could not apply the new settings');
            }
        }
    }

    onChange(listener: (previous: PolicyConfig) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private readonly threadParents = new Map<string, string>();
    botNames: string[] = [];

    /** What the bot answers to: its own Discord name first, then any extra names from settings. */
    names(): string[] {
        const seen = new Set<string>();
        return [...this.botNames, ...this.config.triggers.names].filter((name) => {
            const key = name.trim().toLocaleLowerCase();
            if (key.length < 2 || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    noteRoles(userId: string, guildId: string, roleIds: Iterable<string>): void {
        const guilds = this.memberRoles.get(userId) ?? new Map<string, Set<string>>();
        guilds.set(guildId, new Set(roleIds));
        this.memberRoles.set(userId, guilds);
    }

    userAllowed(userId: string): boolean {
        if (this.config.allowedUserIds.includes(userId)) return true;
        const guilds = [...(this.memberRoles.get(userId)?.values() ?? [])];
        return this.config.allowedRoleIds.some((role) => guilds.some((roles) => roles.has(role)));
    }

    isOwner(userId: string): boolean {
        return this.config.ownerUserId !== undefined && this.config.ownerUserId === userId;
    }

    assertUser(userId: string): void {
        if (!this.userAllowed(userId)) throw new Error('Discord user is not whitelisted');
    }

    assertScope(scope: Scope): void {
        if (!this.config.scopes.includes(scope)) throw new Error('Capability is not approved');
    }

    guildAllowed(guildId: string): boolean {
        return inScope(this.config.servers, guildId);
    }

    noteThread(threadId: string, parentId: string): void {
        this.threadParents.set(threadId, parentId);
    }

    channelAllowed(channelId: string): boolean {
        const parent = this.threadParents.get(channelId);
        const list = this.config.channels;
        if (!parent) return inScope(list, channelId);
        if (list.blocked.includes(channelId) || list.blocked.includes(parent)) return false;
        return list.mode === 'blocklist' || list.allowed.includes(channelId) || list.allowed.includes(parent);
    }

    assertGuild(guildId: string): void {
        if (!this.guildAllowed(guildId)) throw new Error('Guild is not approved');
    }

    assertChannel(channelId: string): void {
        if (!this.channelAllowed(channelId)) throw new Error('Channel or thread is not approved');
    }

    assertOrigin(origin: Origin): void {
        this.assertUser(origin.actorId);
        if (!origin.guildId) return;
        this.assertGuild(origin.guildId);
        this.assertChannel(origin.channelId);
    }

    assertObservation(origin: Origin): void {
        this.assertScope('messages.read');
        if (!origin.guildId) {
            this.assertUser(origin.actorId);
            return;
        }
        this.assertGuild(origin.guildId);
        this.assertChannel(origin.channelId);
    }

    assertResponse(origin: Origin, channelId: string): void {
        this.assertOrigin(origin);
        if (channelId !== origin.channelId) throw new Error('Response destination must match its captured event');
    }

    private readonly dms = new Map<string, string>();

    /** Remembers the DM channel with an approved person, so anything that may be sent to them can go there. */
    noteDm(channelId: string, userId: string): void {
        this.dms.set(channelId, userId);
    }

    dmUser(channelId: string): string | undefined {
        return this.dms.get(channelId);
    }

    assertProactive(channelId: string): void {
        this.assertScope('messages.write');
        const dmUser = this.dms.get(channelId);
        if (dmUser) return this.assertUser(dmUser);
        this.assertChannel(channelId);
    }

    assertGuildAction(origin: Origin, guildId: string): void {
        this.assertOrigin(origin);
        this.assertGuild(guildId);
        if (origin.guildId !== guildId) throw new Error('Mutation guild must match its captured event');
    }
}
