import type { Message } from 'discord.js';

/** Check the fetched target itself, never an inherited mention or caller-supplied author. */
export async function replyToBot(message: Message, botId: string): Promise<boolean> {
    const reference = message.reference;
    if (!validReference(message)) return false;
    try {
        const target = await message.fetchReference();
        const sameMessage = target.id === reference!.messageId && target.channelId === message.channelId;
        return sameMessage && target.guildId === message.guildId && target.author.id === botId;
    } catch {
        return false;
    }
}

function validReference(message: Message): boolean {
    const reference = message.reference;
    if (!reference?.messageId || !reference.channelId) return false;
    if (reference.channelId !== message.channelId) return false;
    return reference.guildId === undefined || reference.guildId === message.guildId;
}
