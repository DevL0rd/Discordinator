import { z } from 'zod';
import { snowflake } from '../core/config.js';
import type { ObservedMessage } from '../core/context.js';
import type { BotEvent } from '../core/queue.js';

export const eventName = 'discord.message.created';
export const interactionEventName = 'discord.interaction.created';
export const eventNames = z.enum([eventName, interactionEventName]);
export const filtersSchema = z
    .object({
        delivery: z.enum(['addressed', 'all']).default('addressed'),
        guild_id: snowflake.optional(),
        channel_id: snowflake.optional(),
        user_id: snowflake.optional(),
    })
    .strict();
export type Filters = z.infer<typeof filtersSchema>;
const destinationSchema = z.object({ mode: z.literal('webhook'), url: z.url().max(2048) }).strict();
export const secretSchema = z
    .string()
    .max(100)
    .refine((value) => {
        if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
        const bytes = Buffer.from(value.slice(6), 'base64');
        return bytes.length >= 24 && bytes.length <= 64 && bytes.toString('base64') === value.slice(6);
    }, 'Expected whsec_ followed by canonical base64 for 24–64 bytes');
const identity = { name: eventNames, arguments: filtersSchema, delivery: destinationSchema };
export const unsubscribeSchema = z.object({ ...identity, _meta: z.record(z.string(), z.unknown()).optional() }).strict();
export const subscribeSchema = unsubscribeSchema.extend({
    delivery: destinationSchema.extend({ secret: secretSchema }),
    cursor: z.null().optional(),
    ttlMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});
export type SubscribeInput = z.infer<typeof subscribeSchema>;
export type UnsubscribeInput = z.infer<typeof unsubscribeSchema>;
export const payloadSchema = z
    .object({
        actorId: snowflake,
        channelId: snowflake,
        guildId: snowflake.nullable(),
        messageId: snowflake,
        parentId: snowflake.nullable(),
        replyToId: snowflake.nullable(),
        text: z.string().max(1000),
        contentAvailable: z.boolean(),
        authorBot: z.boolean(),
        timestamp: z.iso.datetime(),
        addressed: z.boolean(),
        trigger_event_id: z.uuid().nullable(),
    })
    .strict();
export type Payload = z.infer<typeof payloadSchema>;
export const interactionPayloadSchema = payloadSchema.omit({ messageId: true, parentId: true, replyToId: true }).extend({
    text: z.string().max(4000),
    interactionId: snowflake,
    interactionName: z.enum(['discordinator', 'discordinator.control', 'discordinator.modal']),
    sourceEventId: z.uuid().nullable(),
});
export type InteractionPayload = z.infer<typeof interactionPayloadSchema>;
export type EventPayload = Payload | InteractionPayload;
export function interactionPayload(input: BotEvent, interactionId: string): InteractionPayload {
    return interactionPayloadSchema.parse({
        actorId: input.actorId,
        channelId: input.channelId,
        guildId: input.guildId,
        interactionId,
        interactionName: input.name,
        sourceEventId: input.sourceEventId ?? null,
        text: input.text,
        contentAvailable: true,
        authorBot: false,
        timestamp: input.receivedAt,
        addressed: true,
        trigger_event_id: input.id,
    });
}
export function payload(input: ObservedMessage, triggerId: string | null): Payload {
    return payloadSchema.parse({ ...input, text: input.text.slice(0, 1000), addressed: triggerId !== null, trigger_event_id: triggerId });
}

export function matches(filters: Filters, data: EventPayload): boolean {
    if (filters.delivery === 'addressed' && !data.addressed) return false;
    return (
        (!filters.guild_id || filters.guild_id === data.guildId) &&
        (!filters.channel_id || filters.channel_id === data.channelId) &&
        (!filters.user_id || filters.user_id === data.actorId)
    );
}
