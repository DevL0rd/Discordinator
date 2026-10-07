import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const mutation = {
    eventId: z
        .uuid()
        .describe(
            'Captured request ID or owner contextId from discordinator_authorize_context. No fresh Discord message or elapsed-time deadline; current permissions are rechecked.',
        ),
    idempotencyKey: z
        .string()
        .min(8)
        .max(128)
        .default(() => randomUUID())
        .describe('Optional. Generated automatically; pass the same key only when retrying an action so it is not repeated.'),
};
