import { createHash } from 'node:crypto';
import type { Api } from '../discord/api.js';
import { project } from '../discord/api.js';
import { operations } from '../discord/catalog.js';
import type { Operation } from '../discord/operations.js';
import { mentions } from '../discord/operations.js';
import type { Policy } from './policy.js';
import type { EventContext, EventQueue } from './queue.js';
import type { Journal } from './journal.js';
import { ContextIndex } from './context.js';
import type { Approvals } from './approvals.js';

export interface MutationInput {
  eventId: string;
  idempotencyKey: string;
  approvalId?: string | undefined;
}

export class Bridge {
  readonly context: ContextIndex;
  constructor(
    readonly policy: Policy, readonly queue: EventQueue, readonly journal: Journal,
    readonly approvals: Approvals, readonly api: Api,
  ) { this.context = new ContextIndex(policy, queue); }

  private event(id: string): EventContext {
    const context = this.queue.context(id);
    this.policy.assertOrigin(context.event);
    return context;
  }

  private async authorize(operation: Operation, args: Record<string, unknown>, event?: EventContext): Promise<void> {
    this.policy.assertScope(operation.scope);
    if (operation.target === 'guild') {
      this.policy.assertGuild(String(args.guildId));
      if (event) this.policy.assertGuildAction(event.event, String(args.guildId));
      return;
    }
    const destination = await this.api.channel(String(args.channelId));
    if (!event) return;
    this.policy.assertGuildAction(event.event, String(destination.guild_id));
    if (['messages.write', 'reactions.write', 'threads.write'].includes(operation.scope)) {
      this.policy.assertResponse(event.event, String(args.channelId));
    }
  }

  async invoke(operation: Operation, input: Record<string, unknown>, mutation?: MutationInput): Promise<unknown> {
    const args = operation.schema.parse(input) as Record<string, unknown>;
    const event = mutation ? this.event(mutation.eventId) : undefined;
    if (operation.mutates && !event) throw new Error('Captured triggering event is required');
    await this.authorize(operation, args, event);
    if (!operation.mutates) return project(await operation.run(args, { api: this.api, policy: this.policy }));
    return this.mutate(operation, args, mutation!);
  }

  private async mutate(operation: Operation, args: Record<string, unknown>, mutation: MutationInput): Promise<unknown> {
    const input = { operation: operation.name, args, eventId: mutation.eventId, idempotencyKey: mutation.idempotencyKey };
    if (operation.sensitive && !mutation.approvalId) return this.approvals.prepare(this.event(mutation.eventId).event, input);
    return this.journal.execute(mutation.idempotencyKey, input, async () => {
      const event = this.event(mutation.eventId);
      await this.authorize(operation, args, event);
      if (operation.sensitive) {
        this.approvals.assert(mutation.approvalId!, event.event, input);
        this.approvals.consume(mutation.approvalId!);
      }
      return project(await operation.run(args, { api: this.api, policy: this.policy, origin: event }));
    }, () => {
      if (operation.sensitive) this.approvals.assert(mutation.approvalId!, this.event(mutation.eventId).event, input);
    });
  }

  async respond(input: MutationInput & { content: string }): Promise<unknown> {
    this.event(input.eventId);
    this.policy.assertScope('messages.write');
    return this.journal.execute(input.idempotencyKey, { operation: 'respond', ...input }, async () => {
      const context = this.event(input.eventId);
      this.policy.assertResponse(context.event, context.event.channelId);
      if (context.respond) return project(await context.respond(input.content));
      return this.send(context.event.channelId, input.content, input.idempotencyKey, context.event.messageId);
    });
  }

  async dm(input: MutationInput & { content: string }): Promise<unknown> {
    this.event(input.eventId);
    this.policy.assertScope('messages.write');
    return this.journal.execute(input.idempotencyKey, { operation: 'dm', ...input }, async () => {
      const context = this.event(input.eventId);
      this.policy.assertUser(context.event.actorId);
      const dm = await this.api.post('/users/@me/channels', { recipient_id: context.event.actorId }) as { id: string };
      this.event(input.eventId);
      return this.send(dm.id, input.content, input.idempotencyKey);
    });
  }

  async proactive(input: { channelId: string; content: string; idempotencyKey: string }): Promise<unknown> {
    this.policy.assertProactive(input.channelId);
    await this.api.channel(input.channelId);
    return this.journal.execute(input.idempotencyKey, { operation: 'proactive_send', ...input }, async () => {
      this.policy.assertProactive(input.channelId);
      await this.api.channel(input.channelId);
      return this.send(input.channelId, input.content, input.idempotencyKey);
    });
  }

  private async send(channelId: string, content: string, key: string, messageId?: string): Promise<unknown> {
    const nonce = createHash('sha256').update(key).digest('hex').slice(0, 24);
    const result = await this.api.post(`/channels/${channelId}/messages`, {
      content, allowed_mentions: mentions, nonce, enforce_nonce: true,
      ...(messageId ? { message_reference: { message_id: messageId, fail_if_not_exists: true } } : {}),
    }) as { id: string; channel_id: string };
    return { id: result.id, channel_id: result.channel_id };
  }

  status() {
    return {
      botId: this.api.botId, queueEpoch: this.queue.epoch,
      guildScope: this.policy.config.guildScope, channelScope: this.policy.config.channelScope,
      whitelistCount: this.policy.config.allowedUserIds.length, scopes: this.policy.config.scopes,
      operationCount: operations.length, proactiveDestinationCount: this.policy.config.proactive.length,
      autonomousWake: false,
    };
  }

  async guilds(limit: number, before?: string): Promise<unknown> {
    this.policy.assertScope('guild.read');
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    const guilds = await this.api.get('/users/@me/guilds', query) as { id: string }[];
    return project(guilds.filter(guild => this.policy.config.guildScope === 'all' || this.policy.config.guildIds.includes(guild.id)));
  }
}
