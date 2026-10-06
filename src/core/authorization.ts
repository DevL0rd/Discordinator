import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Policy } from './policy.js';
import type { Api } from '../discord/api.js';
import type { AccessContext } from './queue.js';

export class OwnerContexts {
    private readonly owner = new AsyncLocalStorage<boolean>();
    private readonly contexts = new Map<string, AccessContext>();
    constructor(
        readonly policy: Policy,
        readonly api: Api,
    ) {}
    run<T>(authenticated: boolean, action: () => T): T {
        return this.owner.run(authenticated, action);
    }
    has(id: string): boolean {
        return this.contexts.has(id);
    }
    get(id: string): AccessContext | undefined {
        const context = this.contexts.get(id);
        if (context) {
            this.assertOwner();
            this.policy.assertProactive(context.event.channelId);
            this.policy.assertOrigin(context.event);
        }
        return context;
    }
    async create(channelId: string, requesterId: string) {
        this.assertOwner();
        this.policy.assertProactive(channelId);
        this.policy.assertUser(requesterId);
        const channel = await this.api.channel(channelId);
        const guildId = typeof channel.guild_id === 'string' ? channel.guild_id : null;
        if (!guildId) throw new Error('Direct context requires an existing approved guild destination');
        this.policy.assertGuild(guildId);
        if (this.contexts.size >= 1000) throw new Error('Direct authorization context capacity reached');
        const contextId = randomUUID();
        this.contexts.set(contextId, {
            event: { kind: 'owner', id: contextId, actorId: requesterId, channelId, guildId },
            expiresAt: Infinity,
        });
        return {
            contextId,
            channelId,
            requesterId,
            instruction:
                'Use contextId in the legacy eventId field. This is an owner authorization context, not a Discord event or reply reference.',
        };
    }
    private assertOwner(): void {
        if (!this.owner.getStore()) throw new Error('Authenticated owner required for direct authorization context');
    }
}
