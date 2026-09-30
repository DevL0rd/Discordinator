import type { Message } from 'discord.js';
import type { ObservedMessage } from '../core/context.js';

export function observe(message: Message, hasContentIntent: boolean): ObservedMessage {
  return { actorId: message.author.id, authorBot: message.author.bot, channelId: message.channelId,
    guildId: message.guildId, messageId: message.id, text: message.content,
    timestamp: new Date(message.createdTimestamp ?? Date.now()).toISOString(),
    contentAvailable: hasContentIntent || !message.guildId || message.content.length > 0,
    parentId: message.channel?.isThread() ? message.channel.parentId : null,
    replyToId: message.reference?.messageId ?? null };
}
