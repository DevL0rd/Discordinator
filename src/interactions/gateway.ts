import {
    ComponentType,
    type ButtonInteraction,
    type StringSelectMenuInteraction,
    type ModalSubmitInteraction,
    type ChatInputCommandInteraction,
    type InteractionEditReplyOptions,
} from 'discord.js';
import type { BotEvent, EventContext, EventInput, EventQueue } from '../core/queue.js';
import type { Policy } from '../core/policy.js';
import type { Flows } from './flows.js';
import { fadeLater } from '../core/fade.js';
import { interactionAuthor } from '../discord/observation.js';

type Respondable = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction | ChatInputCommandInteraction;

export async function captureInteraction(interaction: Respondable, input: EventInput, policy: Policy, queue: EventQueue, quiet = false) {
    let ready: Promise<unknown> = Promise.resolve();
    let eventId = '';
    const deliver: EventContext['deliver'] = async (payload) => {
        await ready;
        policy.assertOrigin(input);
        policy.assertScope('messages.write');
        queue.context(eventId);
        const options: InteractionEditReplyOptions = {
            content: payload.content,
            allowedMentions: { parse: [], repliedUser: false },
            ...(payload.components ? { components: payload.components } : {}),
            ...(payload.embeds ? { embeds: payload.embeds } : {}),
            ...(payload.files ? { files: payload.files.map((file) => ({ attachment: file.data, name: file.name })), attachments: [] } : {}),
        };
        const fleeting = payload.status === true;
        const reply =
            quiet || fleeting
                ? await interaction.followUp({
                      content: payload.content,
                      allowedMentions: { parse: [], repliedUser: false },
                      components: payload.components,
                      embeds: payload.embeds,
                      files: payload.files?.map((file) => ({ attachment: file.data, name: file.name })),
                  })
                : await interaction.editReply(options);
        if (fleeting) fadeLater(() => interaction.deleteReply(reply.id));
        return { id: reply.id, channel_id: reply.channelId };
    };
    const event = queue.add(
        `interaction:${interaction.id}`,
        input,
        (text, status) => deliver({ content: text, ...(status ? { status } : {}) }),
        deliver,
    );
    if (!event) return null;
    eventId = event.id;
    ready = quiet && 'deferUpdate' in interaction ? interaction.deferUpdate() : interaction.deferReply();
    await ready;
    return event;
}

export async function handleControl(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
    flows: Flows,
    policy: Policy,
    queue: EventQueue,
    publish?: (event: BotEvent, interactionId: string) => Promise<void>,
): Promise<void> {
    try {
        policy.assertUser(interaction.user.id);
    } catch {
        await rejectControl(interaction);
        return;
    }
    if (!interaction.channelId) throw new Error('Control has no channel');
    if (!interaction.customId.startsWith('discordinator:')) return;
    const modal = interaction.isModalSubmit();
    let accepted: ReturnType<Flows['accept']>;
    try {
        accepted = flows.accept(controlInput(interaction));
    } catch {
        await rejectControl(interaction);
        return;
    }
    if (accepted.modal) {
        await (interaction as ButtonInteraction).showModal(accepted.modal);
        return;
    }
    const source = accepted.origin;
    const captured = await captureInteraction(
        interaction,
        {
            actorId: source.actorId,
            channelId: source.channelId,
            guildId: source.guildId,
            kind: 'interaction',
            name: modal ? 'discordinator.modal' : 'discordinator.control',
            author: interactionAuthor(interaction),
            ...(source.kind !== 'owner' ? { sourceEventId: source.id } : {}),
            text: accepted.text!,
        },
        policy,
        queue,
        true,
    );
    await clearControl(interaction);
    if (captured) await publish?.(captured, interaction.id);
}
async function clearControl(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<void> {
    if (!interaction.isModalSubmit() && typeof interaction.message.edit === 'function')
        await interaction.message.edit({ components: [] }).catch(() => undefined);
}

function controlInput(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction) {
    const modal = interaction.isModalSubmit();
    return {
        customId: interaction.customId,
        actorId: interaction.user.id,
        applicationId: interaction.applicationId,
        channelId: interaction.channelId!,
        guildId: interaction.guildId,
        modal,
        componentType: modal ? 0 : interaction.componentType,
        ...(!modal ? { messageId: interaction.message.id, messageAuthorId: interaction.message.author.id } : {}),
        ...(interaction.isStringSelectMenu() ? { values: interaction.values } : {}),
        ...(modal ? { fields: modalFields(interaction) } : {}),
    };
}

async function rejectControl(interaction: Respondable): Promise<void> {
    await interaction.reply({
        content: 'This control is only for its original approved requester, or is no longer active.',
        allowedMentions: { parse: [] },
    });
}

function modalFields(interaction: ModalSubmitInteraction): Record<string, string> {
    return Object.fromEntries(
        [...interaction.fields.fields.values()].map((field) => {
            if (field.type !== ComponentType.TextInput || typeof field.value !== 'string')
                throw new Error('Only correlated text inputs are accepted');
            return [field.customId, field.value];
        }),
    );
}
