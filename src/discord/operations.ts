import { z } from 'zod';
import { snowflake, type Scope } from '../core/config.js';
import type { EventContext } from '../core/queue.js';
import type { Policy } from '../core/policy.js';
import type { Api } from './api.js';

export interface OperationContext {
    api: Api;
    policy: Policy;
    origin?: EventContext;
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
export const text = z.string().min(1).max(2000);
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

export function origin(context: OperationContext): EventContext {
    if (!context.origin) throw new Error('Captured triggering event is required');
    return context.origin;
}

export const write = { mutates: true };
export const sensitive = { mutates: true, sensitive: true };
