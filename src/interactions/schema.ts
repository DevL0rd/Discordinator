import { z } from 'zod';

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/);
const option = z.object({ key, label: z.string().min(1).max(80) }).strict();
const field = z.object({ key, label: z.string().min(1).max(45),
  placeholder: z.string().max(100).optional(), multiline: z.boolean().default(false),
  required: z.boolean().default(true), maxLength: z.number().int().min(1).max(500).default(500) }).strict();
export const promptSchema = z.object({ content: z.string().min(1).max(2000),
  mode: z.enum(['buttons', 'select', 'modal']), options: z.array(option).max(25).default([]),
  title: z.string().min(1).max(45).default('DotBot input'), fields: z.array(field).max(5).default([]),
}).strict().superRefine((input, context) => {
  if (new Set(input.options.map(item => item.key)).size !== input.options.length || new Set(input.fields.map(item => item.key)).size !== input.fields.length) {
    context.addIssue({ code: 'custom', message: 'Keys must be unique' });
  }
  if (input.mode === 'modal') {
    if (!input.fields.length || input.options.length) context.addIssue({ code: 'custom', message: 'Modal requires fields only' });
  } else if (!input.options.length || input.fields.length || input.mode === 'buttons' && input.options.length > 5) {
    context.addIssue({ code: 'custom', message: 'Buttons/select require valid options only' });
  }
});
export type Prompt = z.infer<typeof promptSchema>;
