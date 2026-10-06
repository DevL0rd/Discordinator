import type { Message } from 'discord.js';
import type { ObservedMessage } from '../core/context.js';

export function observe(message: Message, hasContentIntent: boolean): ObservedMessage {
    return {
        actorId: message.author.id,
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
    author: { id: string; bot?: boolean };
    message_reference?: { message_id?: string };
}

export function observeRaw(message: RawMessage, guildId: string | null, parentId: string | null): ObservedMessage {
    return {
        actorId: message.author.id,
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
