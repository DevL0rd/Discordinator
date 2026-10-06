import { MessageFlags, type APIEmbed, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandOptions, CommandReply } from '../operator/commands.js';
import { assistants } from '../operator/ui/status.js';
import { responderChoices } from '../operator/commands.js';

export type CommandHandler = (
    name: string,
    options: CommandOptions,
    origin: { guildId: string | null; channelId: string; actorId: string },
) => Promise<CommandReply>;

const everywhere = { contexts: [0, 1], integration_types: [0] };
const text = (name: string, description: string, choices?: { name: string; value: string }[]) => ({
    type: 3,
    name,
    description,
    required: true,
    ...(choices ? { choices } : {}),
});

export const commandDefinitions = [
    { name: 'status', description: 'Show the responder, its model and how full its context is' },
    { name: 'usage', description: 'Show Claude or Codex plan usage and context usage' },
    { name: 'compact', description: 'Compact the current conversation to free up context' },
    { name: 'new', description: 'Start a fresh conversation' },
    { name: 'stop', description: 'Stop what the assistant is working on' },
    {
        name: 'activity',
        description: 'Show or hide step-by-step activity updates',
        options: [
            text('mode', 'On or off', [
                { name: 'on', value: 'on' },
                { name: 'off', value: 'off' },
            ]),
        ],
    },
    {
        name: 'responder',
        description: 'Switch who answers Discord',
        options: [
            text(
                'name',
                'Primary responder',
                responderChoices.map((mode) => ({ name: assistants[mode].name, value: mode })),
            ),
        ],
    },
    { name: 'model', description: 'Change the responder’s model', options: [text('name', 'Model id, or default')] },
].map((definition) => ({ ...definition, ...everywhere }));

export const builtInCommands = new Set(commandDefinitions.map((definition) => definition.name));

const colors = { info: 0x5865f2, good: 0x3ba55d, warn: 0xf0b232 };

export function replyEmbed(reply: CommandReply): APIEmbed {
    const description = reply.lines.join('\n');
    return {
        title: reply.title,
        description: description.length > 4096 ? `${description.slice(0, 4095)}…` : description,
        color: colors[reply.tone],
    };
}

export async function runCommand(interaction: ChatInputCommandInteraction, handler: CommandHandler): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const options: CommandOptions = Object.fromEntries(interaction.options.data.map((option) => [option.name, String(option.value ?? '')]));
    const origin = { guildId: interaction.guildId, channelId: interaction.channelId, actorId: interaction.user.id };
    const reply = await handler(interaction.commandName, options, origin).catch((error: unknown): CommandReply => ({
        title: 'Could not do that',
        tone: 'warn',
        lines: [error instanceof Error ? error.message : 'Something went wrong'],
    }));
    await interaction.editReply({ embeds: [replyEmbed(reply)], allowedMentions: { parse: [] } });
}

export async function denyCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({ content: 'You are not approved to use Discordinator here.', flags: MessageFlags.Ephemeral });
}
