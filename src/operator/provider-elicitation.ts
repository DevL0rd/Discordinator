import { z } from 'zod';
import type { Prompt } from '../interactions/schema.js';

const property = z
    .object({
        type: z.enum(['string', 'number', 'integer', 'boolean']),
        title: z.string().optional(),
        description: z.string().optional(),
        enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
        minLength: z.number().optional(),
        maxLength: z.number().optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
    })
    .strict();
type Property = z.infer<typeof property>;
function stringValue(item: Property): z.ZodType {
    let value = z.string();
    if (item.minLength !== undefined) value = value.min(item.minLength);
    if (item.maxLength !== undefined) value = value.max(item.maxLength);
    return value;
}
function numericValue(item: Property): z.ZodType {
    let value = z.number();
    if (item.type === 'integer') value = value.int();
    if (item.minimum !== undefined) value = value.min(item.minimum);
    if (item.maximum !== undefined) value = value.max(item.maximum);
    return z.string().trim().min(1).transform(Number).pipe(value);
}
function valueSchema(item: Property): z.ZodType {
    let value: z.ZodType;
    switch (item.type) {
        case 'boolean':
            value = z.enum(['true', 'false']).transform((raw) => raw === 'true');
            break;
        case 'string':
            value = stringValue(item);
            break;
        default:
            value = numericValue(item);
    }
    if (item.enum) value = value.refine((entry) => item.enum!.includes(entry as string | number | boolean));
    return value;
}
function formAnswer(
    entries: [string, Property][],
    required: string[],
    nonce: string,
    fields?: Record<string, string>,
): Record<string, unknown> {
    const input = z.record(z.string(), z.string()).parse(fields);
    const allowed = entries.map((_item, index) => `${nonce}_${index}`);
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('Unknown form field');
    const result: Record<string, unknown> = {};
    for (const [index, [key, item]] of entries.entries()) {
        const raw = input[`${nonce}_${index}`] ?? '';
        if (!raw && !required.includes(key)) continue;
        result[key] = valueSchema(item).parse(raw);
    }
    return result;
}
export function providerElicitation(
    schema: unknown,
    nonce: string,
): {
    prompt: Prompt;
    answer(fields: Record<string, string> | undefined): Record<string, unknown>;
} {
    const parsed = z
        .object({
            type: z.literal('object'),
            properties: z.record(z.string(), property),
            required: z.array(z.string()).optional(),
            additionalProperties: z.literal(false).optional(),
        })
        .strict()
        .parse(schema);
    const entries = Object.entries(parsed.properties);
    if (!entries.length || entries.length > 5) throw new Error('Form requires a bounded supported provider schema');
    if (entries.some(([key, item]) => /password|secret|token|credential/i.test(`${key} ${item.title ?? ''}`)))
        throw new Error('Secret form requires secure local handoff');
    const prompt: Prompt = {
        content:
            'The provider requires this form:\n' +
            entries
                .map(([key, item]) => `${key}: ${item.description ?? item.type}${item.enum ? ' (' + item.enum.join(', ') + ')' : ''}`)
                .join('\n'),
        mode: 'modal',
        title: 'Provider form',
        options: [],
        fields: entries.map(([key, item], index) => ({
            key: `${nonce}_${index}`,
            label: (item.title ?? key).slice(0, 45),
            multiline: false,
            required: parsed.required?.includes(key) ?? false,
            maxLength: Math.min(500, item.maxLength ?? 500),
        })),
    };
    if (prompt.content.length > 1900) throw new Error('Form is too large for Discord relay');
    return {
        prompt,
        answer: (fields) => formAnswer(entries, parsed.required ?? [], nonce, fields),
    };
}
