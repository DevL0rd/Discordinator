import { ProtocolError } from '@modelcontextprotocol/server';
import type { Policy } from '../core/policy.js';
import type { Filters, EventPayload } from './schema.js';
import type { Principal } from './security.js';
import type { Subscription } from './store.js';

export class EventAccess {
    constructor(
        readonly policy: Policy,
        readonly ownerAllowed: (id: string) => boolean,
        readonly now = Date.now,
    ) {}
    authorize(owner: Principal, filters: Filters): void {
        this.assertOwner(owner);
        const config = this.policy.config;
        if (!config.mcpEvents.enabled || (!config.allowedUserIds.length && !config.allowedRoleIds.length))
            throw new ProtocolError(-32602, 'Events disabled');
        this.policy.assertScope('messages.read');
        if (filters.delivery === 'all' && !config.mcpEvents.allowAllMessages)
            throw new ProtocolError(-32602, 'All-message delivery disabled');
        if (filters.guild_id) this.policy.assertGuild(filters.guild_id);
        if (filters.channel_id) this.policy.assertChannel(filters.channel_id);
        if (filters.delivery === 'addressed' && filters.user_id) this.policy.assertUser(filters.user_id);
    }
    private assertOwner(owner: Principal): void {
        if (!this.ownerAllowed(owner.id)) throw new ProtocolError(-32602, 'Event access denied');
        if (owner.expiresAt !== undefined && owner.expiresAt <= this.now()) throw new ProtocolError(-32602, 'Event credential expired');
    }
    /** Kept while its owner and lifetime are valid; settings that block it only pause it until they allow it again. */
    retained(subscription: Subscription): boolean {
        try {
            this.assertOwner({ id: subscription.owner, expiresAt: subscription.ownerExpires });
            return subscription.expires > this.now();
        } catch {
            return false;
        }
    }
    active(subscription: Subscription): boolean {
        return !subscription.suspended && this.valid(subscription);
    }
    valid(subscription: Subscription): boolean {
        try {
            this.authorize({ id: subscription.owner, expiresAt: subscription.ownerExpires }, subscription.arguments);
            return subscription.expires > this.now();
        } catch {
            return false;
        }
    }
    allowsData(subscription: Subscription, data: EventPayload): boolean {
        if (!this.active(subscription)) return false;
        try {
            this.policy.assertObservation(data);
            if (data.addressed) this.policy.assertOrigin(data);
            return !data.authorBot;
        } catch {
            return false;
        }
    }
}
