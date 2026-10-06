import { z } from 'zod';
import { snowflake, type Scope } from '../core/config.js';
import type { AccessContext } from '../core/queue.js';
import type { Policy } from '../core/policy.js';
import type { Api } from './api.js';

export interface OperationContext {
    api: Api;
    policy: Policy;
    origin?: AccessContext;
}
export interface Operation {
    name: string;
    description: string;
    scope: Scope;
    target: 'guild' | 'channel';
    mutates: boolean;
    sensitive: boolean;
    schema: z.ZodObject;
    run: (input: unknown, context: OperationContext) => Promise<unknown>;
}

export const channel = { channelId: snowflake };
export const guild = { guildId: snowflake };
export const member = { ...guild, userId: snowflake };
export const message = { ...channel, messageId: snowflake };
export const pagination = { limit: z.number().int().min(1).max(100).default(25), before: snowflake.optional() };
export const forwardPagination = { limit: z.number().int().min(1).max(100).default(25), after: snowflake.optional() };
export const text = z.string().min(1).max(2000);
const embed = z
    .object({
        title: z.string().max(256).optional(),
        description: z.string().max(4096).optional(),
        url: z.url().optional(),
        color: z.number().int().min(0).max(0xffffff).optional(),
        fields: z
            .array(
                z.object({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024), inline: z.boolean().optional() }).strict(),
            )
            .max(25)
            .optional(),
        footer: z
            .object({ text: z.string().min(1).max(2048) })
            .strict()
            .optional(),
        image: z.object({ url: z.url() }).strict().optional(),
        thumbnail: z.object({ url: z.url() }).strict().optional(),
        timestamp: z.iso.datetime().optional(),
    })
    .strict();
type Embed = z.infer<typeof embed>;
const embedLength = (item: Embed) =>
    (item.title?.length ?? 0) +
    (item.description?.length ?? 0) +
    (item.footer?.text.length ?? 0) +
    (item.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);

export const rich = {
    content: z.string().max(2000).default('').describe('Message text. Optional when embeds are given.'),
    embeds: z
        .array(embed)
        .max(10)
        .refine((items) => items.reduce((total, item) => total + embedLength(item), 0) <= 6000, {
            message: 'Embeds can hold at most 6000 characters in total; split the content across messages',
        })
        .optional()
        .describe(
            'Discord embeds for structured, non-conversational output: reports, results, lists, status. Keep normal chat as plain content.',
        ),
};
export const shortName = z.string().min(1).max(100);
export const reason = z.string().min(1).max(300);
export const mentions = { parse: [], replied_user: false };

export function define<S extends z.ZodRawShape>(
    name: string,
    description: string,
    access: Pick<Operation, 'scope' | 'target'>,
    shape: S,
    run: (input: z.infer<z.ZodObject<S>>, context: OperationContext) => Promise<unknown>,
    options: { mutates?: boolean; sensitive?: boolean } = {},
): Operation {
    const schema = z.object(shape).strict();
    return {
        name,
        description,
        ...access,
        schema,
        mutates: options.mutates ?? false,
        sensitive: options.sensitive ?? false,
        run: (input, context) => run(schema.parse(input), context),
    };
}

export function query(input: Record<string, unknown>): URLSearchParams {
    return new URLSearchParams(
        Object.entries(input)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
    );
}

export function origin(context: OperationContext): AccessContext {
    if (!context.origin) throw new Error('Captured triggering event is required');
    return context.origin;
}

export const write = { mutates: true };
export const sensitive = { mutates: true, sensitive: true };
