import { MessageFlags, type ButtonInteraction, type StringSelectMenuInteraction, type ModalSubmitInteraction,
  type ChatInputCommandInteraction, type InteractionEditReplyOptions } from 'discord.js';
import type { EventContext, EventInput, EventQueue } from '../core/queue.js';
import type { Policy } from '../core/policy.js';
import type { Flows } from './flows.js';

type Respondable = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction | ChatInputCommandInteraction;

export async function captureInteraction(interaction: Respondable, input: EventInput, policy: Policy, queue: EventQueue) {
  let ready: Promise<unknown> = Promise.resolve();
  let eventId = '';
  const deliver: EventContext['deliver'] = async payload => {
    await ready; policy.assertOrigin(input); policy.assertScope('messages.write'); queue.context(eventId);
    const options: InteractionEditReplyOptions = { content: payload.content, allowedMentions: { parse: [], repliedUser: false },
      ...(payload.components ? { components: payload.components } : {}),
      ...(payload.files ? { files: payload.files.map(file => ({ attachment: file.data, name: file.name })), attachments: [] } : {}),
    };
    const reply = await interaction.editReply(options);
    return { id: reply.id, channel_id: reply.channelId };
  };
  const event = queue.add(`interaction:${interaction.id}`, input, text => deliver({ content: text }), deliver);
  if (!event) return null;
  eventId = event.id;
  ready = interaction.deferReply({ flags: MessageFlags.Ephemeral }); await ready;
  return event;
}

export async function handleControl(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  flows: Flows, policy: Policy, queue: EventQueue): Promise<void> {
  policy.assertUser(interaction.user.id);
  if (!interaction.channelId) throw new Error('Control has no channel');
  if (!interaction.customId.startsWith('dot:')) return;
  const modal = interaction.isModalSubmit();
  const accepted = flows.accept({ customId: interaction.customId, actorId: interaction.user.id,
    applicationId: interaction.applicationId, channelId: interaction.channelId, guildId: interaction.guildId, modal,
    componentType: modal ? 0 : interaction.componentType,
    ...(!modal ? { messageId: interaction.message.id, messageAuthorId: interaction.message.author.id } : {}),
    ...(interaction.isStringSelectMenu() ? { values: interaction.values } : {}),
    ...(modal ? { fields: modalFields(interaction) } : {}),
  });
  if (accepted.modal) { await (interaction as ButtonInteraction).showModal(accepted.modal); return; }
  const source = flows.authorize(accepted.eventId).event;
  await captureInteraction(interaction, { actorId: source.actorId, channelId: source.channelId, guildId: source.guildId,
    kind: 'interaction', name: modal ? 'dot.modal' : 'dot.control', sourceEventId: source.id, text: accepted.text! }, policy, queue);
}

function modalFields(interaction: ModalSubmitInteraction): Record<string, string> {
  return Object.fromEntries([...interaction.fields.fields.values()].map(field => {
    if (field.type !== 4 || typeof field.value !== 'string') throw new Error('Only correlated text inputs are accepted');
    return [field.customId, field.value];
  }));
}
