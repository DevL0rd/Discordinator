import { createHash } from 'node:crypto';
import { OwnerContexts } from './authorization.js';
import type { Api } from '../discord/api.js';
import { project } from '../discord/api.js';
import { operations } from '../discord/catalog.js';
import type { Operation } from '../discord/operations.js';
import { mentions } from '../discord/operations.js';
import type { Policy } from './policy.js';
import type { ScopeList } from './config.js';
import type { AccessContext, Delivery, EventContext, EventQueue } from './queue.js';
import { MediaAccess } from '../media/access.js';
import { MediaService } from '../media/service.js';
import { Flows } from '../interactions/flows.js';
import type { Journal } from './journal.js';
import { ContextIndex } from './context.js';
import { Directory } from './directory.js';
import type { Approvals } from './approvals.js';
import type { ReplyOrigins } from './reply-origins.js';
import { splitMessage } from '../operator/message-split.js';
import { peopleRevision } from '../operator/people.js';
import { StatusBoard } from './status-board.js';

export type Rich = { content: string; embeds?: import('discord.js').APIEmbed[] };
export interface MutationInput {
    eventId: string;
    idempotencyKey: string;
    approvalId?: string | undefined;
}

const warningColor = 0xf0b232;

export class Bridge {
    private readonly ownerContexts: OwnerContexts;
    readonly context: ContextIndex;
    readonly people: Directory;
    readonly media: MediaService;
    readonly flows: Flows;
    readonly replyOrigins: ReplyOrigins | undefined;
    readonly replyJournal: Journal;
    voice?: import('../voice/service.js').VoiceService;
    constructor(
        readonly policy: Policy,
        readonly queue: EventQueue,
        readonly journal: Journal,
        readonly approvals: Approvals,
        readonly api: Api,
        ...storage: [replyOrigins?: ReplyOrigins, replyJournal?: Journal]
    ) {
        [this.replyOrigins, this.replyJournal = journal] = storage;
        if (this.replyOrigins) queue.durableContext = (id) => (this.replyOrigins!.has(id) ? this.replyOrigins!.context(id) : undefined);
        this.ownerContexts = new OwnerContexts(policy, api);
        queue.ownerContext = (id) => this.ownerContexts.get(id);
        this.context = new ContextIndex(policy, queue);
        this.context.directory = this.people = new Directory(policy, api);
        this.media = new MediaService(new MediaAccess(policy, queue, api));
        this.flows = new Flows(policy, queue, api);
    }

    withOwner<T>(action: () => T): T {
        return this.ownerContexts.run(true, action);
    }
    async authorizeContext(channelId: string, requesterId: string) {
        return this.ownerContexts.create(channelId, requesterId);
    }
    private event(id: string): AccessContext {
        const context = this.queue.authorize(id);
        this.policy.assertOrigin(context.event);
        return context;
    }

    private async authorize(operation: Operation, args: Record<string, unknown>, event?: AccessContext): Promise<void> {
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
        const args = operation.schema.parse(input);
        const event = mutation ? await this.replyEvent(mutation.eventId) : undefined;
        if (operation.mutates && !event) throw new Error('Captured triggering event is required');
        await this.authorize(operation, args, event);
        if (!operation.mutates) return project(await operation.run(args, { api: this.api, policy: this.policy }));
        return this.mutate(operation, args, mutation!);
    }

    private async mutate(operation: Operation, args: Record<string, unknown>, mutation: MutationInput): Promise<unknown> {
        const input = { operation: operation.name, args, eventId: mutation.eventId, idempotencyKey: mutation.idempotencyKey };
        if (operation.sensitive && !mutation.approvalId) return this.approvals.prepare(this.event(mutation.eventId).event, input);
        return this.journal.execute(
            mutation.idempotencyKey,
            input,
            async () => {
                const event = await this.replyEvent(mutation.eventId);
                await this.authorize(operation, args, event);
                if (operation.sensitive) {
                    this.approvals.assert(mutation.approvalId!, event.event, input);
                    this.approvals.consume(mutation.approvalId!);
                }
                return project(await operation.run(args, { api: this.api, policy: this.policy, origin: event }));
            },
            () => {
                if (operation.sensitive) this.approvals.assert(mutation.approvalId!, this.event(mutation.eventId).event, input);
            },
        );
    }

    private readonly typingChecks = new Map<string, { context: AccessContext; until: number }>();
    private readonly statuses = new StatusBoard(
        (message, content) =>
            this.api.patch(`/channels/${message.channel_id}/messages/${message.id}`, { content, allowed_mentions: mentions }),
        (message) => this.api.delete(`/channels/${message.channel_id}/messages/${message.id}`),
    );
    private async replyEvent(id: string): Promise<AccessContext> {
        if (this.ownerContexts.has(id)) return this.event(id);
        if (!this.replyOrigins) return this.event(id);
        let live: EventContext | undefined;
        try {
            live = this.queue.context(id);
        } catch {
            live = undefined;
        }
        if (live && live.event.kind !== 'message') return this.event(id);
        const event = this.replyOrigins.context(id);
        this.policy.assertOrigin(event);
        const source = await this.api.message(event.channelId, event.messageId!);
        if (!matchesReplySource(source, event)) {
            await this.replyOrigins.revokeMessage(event.messageId!);
            throw new Error('Reply source changed, deleted or no longer matches captured author/destination');
        }
        if (event.guildId && (await this.api.channel(event.channelId)).guild_id !== event.guildId) throw new Error('Reply guild mismatch');
        return { event, expiresAt: Number.POSITIVE_INFINITY };
    }

    async respond(input: MutationInput & Rich & { notifyRequester?: boolean; status?: boolean }): Promise<unknown> {
        await this.replyEvent(input.eventId);
        this.policy.assertScope('messages.write');
        return this.replyJournal.execute(input.idempotencyKey, { operation: 'respond', ...input }, async () => {
            const context = await this.replyEvent(input.eventId);
            this.policy.assertResponse(context.event, context.event.channelId);
            if ((input.embeds?.length && context.deliver) || context.respond) return this.interactionReply(context, input, input.status);
            if (input.status)
                return this.statuses.show(input.eventId, input.content, (content) =>
                    this.send(context.event.channelId, { content }, input.idempotencyKey, { replyTo: context.event.messageId }),
                );
            const options = { replyTo: context.event.messageId, ...(input.notifyRequester ? { notify: context.event.actorId } : {}) };
            const sent = await this.send(context.event.channelId, input, input.idempotencyKey, options);
            await this.statuses.settle(
                input.eventId,
                sent.parts ? undefined : { message: sent, content: withMention(input.content, options) },
            );
            return sent;
        });
    }

    private async interactionReply(context: AccessContext, input: MutationInput & Rich, quiet?: boolean): Promise<unknown> {
        const [head = '', ...rest] = input.content ? splitMessage(input.content) : [''];
        const reply =
            input.embeds?.length && context.deliver
                ? await context.deliver({ content: head, embeds: input.embeds })
                : await context.respond!(head, quiet);
        if (rest.length) await this.send(context.event.channelId, { content: rest.join('\n') }, `${input.idempotencyKey}:rest`);
        return project(reply);
    }

    async prompt(input: MutationInput & import('../interactions/schema.js').Prompt): Promise<unknown> {
        await this.replyEvent(input.eventId);
        this.flows.authorize(input.eventId);
        const { eventId, idempotencyKey: _key, approvalId: _approval, ...prompt } = input;
        return this.journal.execute(input.idempotencyKey, { operation: 'prompt', ...input }, async () => {
            const flow = this.flows.prepare(eventId, prompt);
            const reply = (await this.deliver(
                input.eventId,
                prompt.tone === 'warning'
                    ? {
                          content: '',
                          embeds: [{ title: prompt.title, description: input.content, color: warningColor }],
                          components: flow.components,
                      }
                    : { content: input.content, components: flow.components },
                input.idempotencyKey,
            )) as { id: string };
            this.flows.bind(flow.id, reply.id);
            return { id: reply.id, flowId: flow.id, expiresAt: flow.expiresAt };
        });
    }

    private async typingContext(eventId: string): Promise<AccessContext> {
        const cached = this.typingChecks.get(eventId);
        if (cached && cached.until > Date.now()) return cached.context;
        const context = await this.replyEvent(eventId);
        for (const [id, entry] of this.typingChecks) if (entry.until <= Date.now()) this.typingChecks.delete(id);
        this.typingChecks.set(eventId, { context, until: Date.now() + 30_000 });
        return context;
    }
    async typing(eventId: string): Promise<void> {
        const context = await this.typingContext(eventId);
        this.policy.assertScope('messages.write');
        this.policy.assertResponse(context.event, context.event.channelId);
        await this.api.post(`/channels/${context.event.channelId}/typing`, {});
    }
    async deliver(eventId: string, delivery: Delivery, key: string): Promise<unknown> {
        const context = await this.replyEvent(eventId);
        this.policy.assertScope('messages.write');
        this.policy.assertResponse(context.event, context.event.channelId);
        if (context.deliver) return context.deliver(delivery);
        if (context.event.kind === 'interaction') throw new Error('Interaction delivery is unavailable');
        const nonce = createHash('sha256').update(key).digest('hex').slice(0, 24);
        const result = (await this.api.postFiles(
            `/channels/${context.event.channelId}/messages`,
            {
                content: delivery.content,
                components: delivery.components,
                embeds: delivery.embeds,
                allowed_mentions: mentions,
                nonce,
                enforce_nonce: true,
                attachments: delivery.files?.map((file, id) => ({ id, filename: file.name })),
                ...(context.event.messageId
                    ? { message_reference: { message_id: context.event.messageId, fail_if_not_exists: true } }
                    : {}),
            },
            delivery.files,
        )) as { id: string; channel_id: string };
        await this.statuses.settle(eventId);
        return { id: result.id, channel_id: result.channel_id };
    }

    async proactiveDm(input: Rich & { userId: string; idempotencyKey: string }): Promise<unknown> {
        this.policy.assertUser(input.userId);
        this.policy.assertScope('messages.write');
        return this.replyJournal.execute(input.idempotencyKey, { operation: 'proactive_dm', ...input }, async () => {
            this.policy.assertUser(input.userId);
            const dm = (await this.api.post('/users/@me/channels', { recipient_id: input.userId })) as { id: string };
            this.policy.noteDm(dm.id, input.userId);
            return this.send(dm.id, input, input.idempotencyKey);
        });
    }

    async proactive(input: Rich & { channelId: string; idempotencyKey: string; notifyUserId?: string }): Promise<unknown> {
        this.policy.assertProactive(input.channelId);
        if (input.notifyUserId) this.policy.assertUser(input.notifyUserId);
        await this.api.channel(input.channelId);
        return this.replyJournal.execute(input.idempotencyKey, { operation: 'proactive_send', ...input }, async () => {
            this.policy.assertProactive(input.channelId);
            await this.api.channel(input.channelId);
            if (input.notifyUserId) this.policy.assertUser(input.notifyUserId);
            return this.send(input.channelId, input, input.idempotencyKey, input.notifyUserId ? { notify: input.notifyUserId } : {});
        });
    }

    private async send(
        channelId: string,
        message: Rich,
        key: string,
        options: { replyTo?: string; notify?: string } = {},
    ): Promise<{ id: string; channel_id: string; parts?: number }> {
        if (!message.content && !message.embeds?.length) throw new Error('A message needs text or at least one embed');
        const text = withMention(message.content, options);
        const parts = text ? splitMessage(text) : [''];
        const sent: { id: string; channel_id: string }[] = [];
        for (const [index, content] of parts.entries())
            sent.push(
                (await this.api.post(`/channels/${channelId}/messages`, partBody(content, index, parts.length, message, key, options))) as {
                    id: string;
                    channel_id: string;
                },
            );
        return { id: sent[0]!.id, channel_id: sent[0]!.channel_id, ...(sent.length > 1 ? { parts: sent.length } : {}) };
    }

    status() {
        return {
            botId: this.api.botId,
            queueEpoch: this.queue.epoch,
            servers: scopeSummary(this.policy.config.servers),
            channels: scopeSummary(this.policy.config.channels),
            whitelistCount: this.policy.config.allowedUserIds.length,
            approvedPeopleRevision: peopleRevision(this.policy.config.allowedUserIds),
            scopes: this.policy.config.scopes,
            operationCount: operations.length,
            autonomousWake: false,
        };
    }

    async guilds(limit: number, before?: string): Promise<unknown> {
        this.policy.assertScope('guild.read');
        const query = new URLSearchParams({ limit: String(limit) });
        if (before) query.set('before', before);
        const guilds = (await this.api.get('/users/@me/guilds', query)) as { id: string }[];
        return project(guilds.filter((guild) => this.policy.guildAllowed(guild.id)));
    }
}

function withMention(content: string, options: { replyTo?: string; notify?: string }): string {
    if (!options.notify || options.replyTo || new RegExp(`<@!?${options.notify}>`).test(content)) return content;
    return `<@${options.notify}> ${content}`.trim();
}

function partBody(
    content: string,
    index: number,
    count: number,
    message: Rich,
    key: string,
    options: { replyTo?: string; notify?: string },
) {
    const first = index === 0;
    return {
        content,
        ...(index === count - 1 && message.embeds?.length ? { embeds: message.embeds } : {}),
        allowed_mentions:
            first && options.notify ? { ...mentions, users: [options.notify], replied_user: Boolean(options.replyTo) } : mentions,
        nonce: createHash('sha256').update(`${key}:${index}`).digest('hex').slice(0, 24),
        enforce_nonce: true,
        ...(first && options.replyTo ? { message_reference: { message_id: options.replyTo, fail_if_not_exists: true } } : {}),
    };
}

function matchesReplySource(source: import('../discord/api.js').Json, event: EventContext['event']): boolean {
    const author = source.author as { id?: string };
    return (
        source.id === event.messageId &&
        source.channel_id === event.channelId &&
        author?.id === event.actorId &&
        !source.webhook_id &&
        source.content === event.text
    );
}
function scopeSummary(list: ScopeList) {
    return { mode: list.mode, allowed: list.allowed.length, blocked: list.blocked.length };
}
