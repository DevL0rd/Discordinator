import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { builtInCommands, commandDefinitions, denyCommand, runCommand, type CommandHandler } from './commands.js';
import type { Message, PartialMessage, ChatInputCommandInteraction, Interaction } from 'discord.js';
import type { Config, PolicyConfig } from '../core/config.js';
import type { Policy } from '../core/policy.js';
import type { EventQueue } from '../core/queue.js';
import type { Approvals } from '../core/approvals.js';
import { Triggers } from '../core/triggers.js';
import type { ContextIndex } from '../core/context.js';
import { author, botNames, interactionAuthor, mentioned, observe } from './observation.js';
import type { Directory } from '../core/directory.js';
import type { VoiceService } from '../voice/service.js';
import { discordConnect } from '../voice/link.js';
import { discordGuilds } from '../voice/guilds.js';
import { replyToBot } from './replies.js';
import { payload, interactionPayload, interactionEventName } from '../events/schema.js';
import type { EventsService } from '../events/service.js';
import type { Api } from './api.js';
import type { MediaService } from '../media/service.js';
import type { Flows } from '../interactions/flows.js';
import { captureInteraction, handleControl } from '../interactions/gateway.js';
import type { ReplyOrigins } from '../core/reply-origins.js';

export function gatewayIntents(config: Config): number[] {
    const intents = [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
    ];
    if (config.DISCORDINATOR_MESSAGE_CONTENT === 'true') intents.push(GatewayIntentBits.MessageContent);
    if (config.DISCORDINATOR_GUILD_MEMBERS === 'true') intents.push(GatewayIntentBits.GuildMembers);
    return intents;
}

const attachmentKeys = (message: Pick<Message, 'attachments'>) => [...message.attachments.keys()].sort().join(',');
export class Gateway {
    readonly client: Client;
    private readonly triggers: Triggers;
    private state = 'offline';
    private readonly unknownMembers = new Map<string, number>();
    private rolesCheckedFor?: PolicyConfig;
    private seen = new Map<string, number>();
    private activeMessages = 0;
    private droppedMessages = 0;
    readonly context?: ContextIndex;
    readonly events?: EventsService;
    readonly media?: MediaService;
    readonly flows?: Flows;
    readonly replyOrigins?: ReplyOrigins;
    readonly commands?: CommandHandler;
    readonly people?: Directory;
    readonly voice?: VoiceService;

    constructor(
        readonly config: Config,
        readonly policy: Policy,
        readonly queue: EventQueue,
        readonly approvals: Approvals,
        readonly api: Api,
        services: {
            context?: ContextIndex;
            events?: EventsService;
            media?: MediaService;
            flows?: Flows;
            replyOrigins?: ReplyOrigins;
            commands?: CommandHandler;
            people?: Directory;
            voice?: VoiceService;
        } = {},
    ) {
        this.context = services.context;
        this.events = services.events;
        this.media = services.media;
        this.flows = services.flows;
        this.replyOrigins = services.replyOrigins;
        this.commands = services.commands;
        this.people = services.people;
        this.voice = services.voice;
        this.triggers = new Triggers(policy);
        this.client = new Client({
            intents: gatewayIntents(config),
            partials: [Partials.Channel],
            allowedMentions: { parse: [], repliedUser: false },
            rest: { retries: 0, timeout: 15_000 },
        });
        this.bindEvents();
        this.voice?.attach(discordConnect(this.client), discordGuilds(this.client));
    }

    private bindMembers(): void {
        this.client.on(Events.GuildMemberUpdate, (_old, member) => {
            if (member.id === this.client.user?.id) this.nameBot();
            this.policy.noteRoles(member.id, member.guild.id, member.roles.cache.keys());
            this.people?.learnVisible(author({ author: member.user, member }), member.guild.id, true);
        });
        this.client.on(Events.GuildMemberRemove, (member) => this.policy.noteRoles(member.id, member.guild.id, []));
        this.client.on(Events.VoiceStateUpdate, (old, state) =>
            this.safely(() => this.voice?.stateChanged(state.guild.id, state.id, old.channelId, state.channelId) ?? Promise.resolve()),
        );
    }

    private bindEvents(): void {
        this.client.on(Events.MessageCreate, (message) => this.safely(() => this.message(message)));
        this.client.on(Events.MessageDelete, (message) => this.remove(message.id));
        this.client.on(Events.MessageBulkDelete, (messages) => {
            for (const id of messages.keys()) this.remove(id);
        });
        this.client.on(Events.MessageUpdate, (old, message) => {
            if (!message.partial) this.edited(old, message);
        });
        this.client.on(Events.ThreadCreate, (thread) => {
            if (thread.parentId) this.policy.noteThread(thread.id, thread.parentId);
        });
        this.bindMembers();
        this.client.on(Events.InteractionCreate, (interaction) => {
            noteInteractionRoles(this.policy, interaction);
            if (interaction.isChatInputCommand()) this.safely(() => this.interaction(interaction));
            if (this.flows && (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) {
                this.safely(() =>
                    handleControl(
                        interaction,
                        this.flows!,
                        this.policy,
                        this.queue,
                        (event, id) => this.events?.emit(interactionPayload(event, id), interactionEventName) ?? Promise.resolve(),
                    ),
                );
            }
        });
        this.client.once(Events.ClientReady, (client) => this.ready(client));
        this.client.on(Events.ShardReconnecting, () => {
            this.setState('reconnecting');
        });
        this.client.on(Events.ShardResume, () => {
            this.setState('ready');
        });
        this.client.on(Events.ShardReady, () => {
            this.setState('ready');
        });
        this.client.on(Events.ShardDisconnect, () => {
            this.setState('disconnected');
        });
        this.client.on(Events.Error, () => {
            this.setState('error');
            console.error('Discord client error; inspect configuration and connectivity');
        });
        this.client.on(Events.ShardError, () => {
            this.setState('error');
        });
    }

    private remove(id: string): void {
        this.safely(async () => {
            await this.replyOrigins?.revokeMessage(id);
        });
        this.context?.remove(id);
        this.media?.index.remove(id);
    }

    private observeMedia(message: Message, addressed: boolean): void {
        if (!this.media) return;
        try {
            this.media.index.ingest(
                {
                    id: message.id,
                    channel_id: message.channelId,
                    author: { id: message.author.id },
                    timestamp: new Date(message.createdTimestamp).toISOString(),
                    attachments: [...message.attachments.values()].map((file) => ({
                        id: file.id,
                        filename: file.name,
                        size: file.size,
                        content_type: file.contentType ?? undefined,
                        url: file.url,
                        width: file.width,
                        height: file.height,
                    })),
                },
                message.guildId,
                addressed,
            );
        } catch {
            return;
        }
    }

    private ready(client: Client<true>): void {
        this.api.botId = client.user.id;
        this.nameBot();
        this.safely(async () => {
            await client.application.fetch();
            this.nameBot();
        });
        this.api.applicationId = client.application.id;
        this.setState('ready');
        if (this.voice) this.safely(() => this.voice!.ready());
        if (this.commands)
            this.safely(async () => {
                await this.api.put(`/applications/${client.application.id}/commands`, commandDefinitions);
            });
    }

    private nameBot(): void {
        this.policy.botNames = botNames(this.client);
    }

    private safely(action: () => Promise<void>): void {
        void action().catch(() => undefined);
    }

    async message(message: Message): Promise<void> {
        if (!this.claimMessage(message.id)) return;
        if (message.channel?.isThread() && message.channel.parentId) this.policy.noteThread(message.channelId, message.channel.parentId);
        if (message.member && message.guildId) this.policy.noteRoles(message.author.id, message.guildId, message.member.roles.cache.keys());
        for (const who of [author(message), ...mentioned(message)])
            this.people?.learnVisible(who, message.guildId, who.id === message.author.id && Boolean(message.member));
        this.activeMessages++;
        try {
            await this.capture(message);
        } finally {
            this.activeMessages--;
        }
    }

    private claimMessage(id: string): boolean {
        const now = Date.now();
        for (const [key, expires] of this.seen) if (expires <= now) this.seen.delete(key);
        if (this.seen.has(id)) return false;
        if (this.activeMessages >= 32) {
            this.droppedMessages++;
            return false;
        }
        if (this.seen.size >= 2000) this.seen.delete(this.seen.keys().next().value!);
        this.seen.set(id, now + 10 * 60_000);
        return true;
    }

    private async capture(message: Message): Promise<void> {
        const trigger = await this.authorizedTrigger(message);
        this.observeMedia(message, trigger !== null);
        if (!this.policy.config.context.enabled && !this.policy.config.mcpEvents.enabled) return;
        const observed = observe(message, this.config.DISCORDINATOR_MESSAGE_CONTENT === 'true');
        try {
            this.policy.assertObservation(observed);
        } catch {
            return;
        }
        this.context?.ingest(observed, trigger !== null);
        if (this.deliverable(message)) {
            await this.events!.emit(payload(observed, trigger?.id ?? null));
        }
    }

    private deliverable(message: Message): boolean {
        return Boolean(this.events) && message.author.id !== this.api.botId && !message.webhookId && this.policy.config.mcpEvents.enabled;
    }

    private recentlyUnknown(userId: string): boolean {
        if (this.rolesCheckedFor !== this.policy.config) {
            this.rolesCheckedFor = this.policy.config;
            this.unknownMembers.clear();
        }
        return (this.unknownMembers.get(userId) ?? 0) > Date.now();
    }

    private async learnRoles(userId: string): Promise<void> {
        if (!this.policy.config.allowedRoleIds.length || this.policy.userAllowed(userId)) return;
        if (this.recentlyUnknown(userId)) return;
        for (const guild of this.client.guilds.cache.values()) {
            const member = await guild.members.fetch(userId).catch(() => undefined);
            if (member) this.policy.noteRoles(userId, guild.id, member.roles.cache.keys());
        }
        for (const [id, until] of this.unknownMembers) if (until <= Date.now()) this.unknownMembers.delete(id);
        if (!this.policy.userAllowed(userId)) this.unknownMembers.set(userId, Date.now() + 10 * 60_000);
    }

    private edited(old: Message | PartialMessage, message: Message): void {
        this.safely(async () => {
            await this.replyOrigins?.edit(message.id, message.content);
        });
        this.context?.update(message.id, message.content, this.config.DISCORDINATOR_MESSAGE_CONTENT === 'true' || !message.guildId);
        if (old.partial || attachmentKeys(old) === attachmentKeys(message)) return;
        this.media?.index.remove(message.id);
        this.observeMedia(message, false);
    }

    private async allowedAuthor(message: Message): Promise<boolean> {
        if (message.guildId === null) await this.learnRoles(message.author.id);
        return this.policy.userAllowed(message.author.id) && message.author.id !== this.api.botId && !message.webhookId;
    }

    private async authorizedTrigger(message: Message) {
        if (!(await this.allowedAuthor(message))) return null;
        const event = {
            actorId: message.author.id,
            channelId: message.channelId,
            guildId: message.guildId,
            messageId: message.id,
            kind: 'message' as const,
            text: message.content,
            author: author(message),
            mentions: mentioned(message),
        };
        this.policy.assertOrigin(event);
        if (!(await this.addressed(message))) return null;
        if (this.replyOrigins?.findMessage(message.channelId, message.id)) return null;
        const queued = this.queue.add(`message:${message.id}`, event);
        if (!queued) return null;
        await this.replyOrigins?.capture(queued);
        const approvalId = await this.approvalIn(message);
        if (approvalId) this.approvals.confirm(event, approvalId);
        return queued;
    }
    private async approvalIn(message: Message): Promise<string | null> {
        const prefixed = this.triggers.approvalId(message.content, this.api.botId, message.guildId === null);
        if (prefixed) return prefixed;
        const bare = this.triggers.approvalId(message.content, this.api.botId, true);
        return bare && (await replyToBot(message, this.api.botId)) ? bare : null;
    }
    private async addressed(message: Message): Promise<boolean> {
        if (message.guildId === null) return true;
        if (this.triggers.accepts(message.author.id, message.content, this.api.botId)) return true;
        const botRole = message.guild?.members.me?.roles.botRole?.id;
        if (botRole && message.mentions?.roles.has(botRole)) return true;
        return this.policy.config.triggers.replyToBot && (await replyToBot(message, this.api.botId));
    }

    async interaction(interaction: ChatInputCommandInteraction): Promise<void> {
        if (interaction.applicationId !== this.api.applicationId) return;
        const origin = { actorId: interaction.user.id, channelId: interaction.channelId, guildId: interaction.guildId };
        try {
            this.policy.assertUser(origin.actorId);
            this.policy.assertOrigin(origin);
        } catch {
            return denyCommand(interaction);
        }
        if (this.commands && builtInCommands.has(interaction.commandName)) return runCommand(interaction, this.commands);
        if (interaction.commandName !== 'discordinator') return;
        const event = {
            actorId: interaction.user.id,
            channelId: interaction.channelId,
            guildId: interaction.guildId,
            kind: 'interaction' as const,
            name: 'discordinator',
            text: interaction.options.getString('text') ?? '',
            author: interactionAuthor(interaction),
        };
        this.policy.assertScope('messages.write');
        const queued = await captureInteraction(interaction, event, this.policy, this.queue);
        if (!queued) return;
        await this.events?.emit(interactionPayload(queued, interaction.id), interactionEventName);
        const approvalId = this.triggers.approvalId(event.text, this.api.botId, true);
        if (approvalId) this.approvals.confirm(event, approvalId);
    }

    onState?: () => void;

    private setState(state: typeof this.state): void {
        this.state = state;
        this.onState?.();
    }

    status() {
        return { gateway: this.state, droppedMessages: this.droppedMessages };
    }
    async start(): Promise<void> {
        try {
            await this.client.login(this.config.DISCORD_BOT_TOKEN);
        } catch (error) {
            if (/disallowed intents/i.test(error instanceof Error ? error.message : ''))
                console.error(
                    'Discord refused the bot’s privileged intents. In the Discord Developer Portal under Bot, turn on Message Content Intent and Server Members Intent, then restart Discordinator.',
                );
            throw error;
        }
    }
    stop(): void {
        this.queue.close();
        void this.client.destroy().catch(() => undefined);
        this.setState('offline');
    }
}

function noteInteractionRoles(policy: Policy, interaction: Interaction): void {
    const member = interaction.member;
    if (!member || !interaction.guildId) return;
    policy.noteRoles(interaction.user.id, interaction.guildId, Array.isArray(member.roles) ? member.roles : member.roles.cache.keys());
}
