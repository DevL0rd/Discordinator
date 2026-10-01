import type { PolicyConfig, Scope } from './config.js';

export interface Origin {
    actorId: string;
    channelId: string;
    guildId: string | null;
    messageId?: string;
}

export class Policy {
    constructor(readonly config: PolicyConfig) {}

    assertUser(userId: string): void {
        if (!this.config.allowedUserIds.includes(userId)) throw new Error('Discord user is not whitelisted');
    }

    assertScope(scope: Scope): void {
        if (!this.config.scopes.includes(scope)) throw new Error('Capability is not approved');
    }

    assertGuild(guildId: string): void {
        if (this.config.guildScope !== 'all' && !this.config.guildIds.includes(guildId)) throw new Error('Guild is not approved');
    }

    assertChannel(channelId: string): void {
        if (this.config.channelScope !== 'all' && !this.config.channelIds.includes(channelId))
            throw new Error('Channel or thread is not approved');
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

    assertProactive(channelId: string): void {
        this.assertScope('messages.write');
        this.assertChannel(channelId);
        const grant = this.config.proactive.find((item) => item.channelId === channelId);
        if (!grant?.scopes.includes('message.send')) throw new Error('Proactive destination is not approved');
    }

    assertGuildAction(origin: Origin, guildId: string): void {
        this.assertOrigin(origin);
        this.assertGuild(guildId);
        if (origin.guildId !== guildId) throw new Error('Mutation guild must match its captured event');
    }
}
