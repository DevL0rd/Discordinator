import type { Interaction, Message } from 'discord.js';
import type { ObservedMessage } from '../core/context.js';
import { person, rawPerson, type Person, type RawMember, type RawUser } from '../core/directory.js';

const maxMentions = 20;

export function author(message: Pick<Message, 'author' | 'member'>): Person {
    return person(message.author.id, message.author.username, message.author.globalName, message.member?.nickname);
}

export function mentioned(message: Pick<Message, 'mentions'>): Person[] {
    const users = message.mentions?.users ? [...message.mentions.users.values()].slice(0, maxMentions) : [];
    return users.map((user) => person(user.id, user.username, user.globalName, message.mentions.members?.get(user.id)?.nickname));
}

type BotIdentity = {
    user: { username: string; globalName: string | null } | null;
    application: { name: string | null } | null;
    guilds: { cache: Map<string, { members: { me: { nickname: string | null } | null } }> };
};

/** What the bot is called: its app name, then its server nicknames, display name and username. */
export function botNames(client: BotIdentity): string[] {
    const nicknames = [...client.guilds.cache.values()].map((guild) => guild.members.me?.nickname);
    const names = [client.application?.name, ...nicknames, client.user?.globalName, client.user?.username];
    return [...new Set(names.filter((name): name is string => Boolean(name?.trim())))];
}

export function interactionAuthor(interaction: Pick<Interaction, 'user' | 'member'>): Person {
    const member = interaction.member;
    const nickname = member && 'nickname' in member ? member.nickname : (member?.nick ?? null);
    return person(interaction.user.id, interaction.user.username, interaction.user.globalName, nickname);
}

export function observe(message: Message, hasContentIntent: boolean): ObservedMessage {
    return {
        actorId: message.author.id,
        author: author(message),
        mentions: mentioned(message),
        authorBot: message.author.bot,
        channelId: message.channelId,
        guildId: message.guildId,
        messageId: message.id,
        text: message.content,
        timestamp: new Date(message.createdTimestamp ?? Date.now()).toISOString(),
        contentAvailable: hasContentIntent || !message.guildId || message.content.length > 0,
        parentId: message.channel?.isThread() ? message.channel.parentId : null,
        replyToId: message.reference?.messageId ?? null,
    };
}

export interface RawMessage {
    id: string;
    channel_id: string;
    content: string;
    timestamp: string;
    author: RawUser;
    member?: RawMember;
    mentions?: (RawUser & { member?: RawMember })[];
    message_reference?: { message_id?: string };
}

export function observeRaw(message: RawMessage, guildId: string | null, parentId: string | null): ObservedMessage {
    return {
        actorId: message.author.id,
        author: rawPerson(message.author, message.member),
        mentions: (message.mentions ?? []).slice(0, maxMentions).map((user) => rawPerson(user, user.member)),
        authorBot: message.author.bot === true,
        channelId: message.channel_id,
        guildId,
        messageId: message.id,
        text: message.content,
        timestamp: new Date(message.timestamp).toISOString(),
        contentAvailable: !guildId || message.content.length > 0,
        parentId,
        replyToId: message.message_reference?.message_id ?? null,
    };
}
