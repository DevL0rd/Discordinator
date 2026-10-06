import { z } from 'zod';
import type { Prompt } from '../interactions/schema.js';

const questionSchema = z.object({
    id: z.string().optional(),
    header: z.string().optional(),
    question: z.string().min(1),
    isSecret: z.boolean().optional(),
    multiSelect: z.boolean().optional(),
    options: z
        .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
        .nullable()
        .optional(),
});
export function providerQuestion(
    payload: unknown,
    nonce: string,
): {
    prompt: Prompt;
    answer(choice: string | undefined, fields: Record<string, string> | undefined): Record<string, string[]>;
} {
    const wrapper = z.object({ input: z.unknown().optional() }).loose().parse(payload);
    const { questions } = z.object({ questions: z.array(questionSchema).min(1).max(5) }).parse(wrapper.input ?? payload);
    if (questions.some((item) => item.isSecret)) throw new Error('Secret input requires secure handoff');
    const single = questions.length === 1 ? questions[0]! : undefined;
    const options = single?.options;
    const content = questionContent(questions);
    if (content.length > 1900) throw new Error('Provider question is too long for safe Discord relay');
    const choices = useChoices(single);
    const prompt = questionPrompt(questions, nonce, content, choices ? options! : undefined);
    return {
        prompt,
        answer(choice, fields) {
            if (choices) {
                const index = Number(choice?.slice(nonce.length + 1));
                if (!Number.isInteger(index) || !choice?.startsWith(`${nonce}_`) || !options![index])
                    throw new Error('Unknown provider question choice');
                return { [single!.id ?? single!.question]: [options![index].label] };
            }
            return fieldAnswers(questions, nonce, fields);
        },
    };
}
type Question = z.infer<typeof questionSchema>;
function useChoices(single?: Question): boolean {
    return Boolean(single && single.options?.length && !single.multiSelect && single.options.length <= 25);
}
function questionPrompt(questions: Question[], nonce: string, content: string, options?: NonNullable<Question['options']>): Prompt {
    return {
        content: `The harness needs your input:\n${content}`,
        mode: options ? (options.length <= 5 ? 'buttons' : 'select') : 'modal',
        title: 'Provider question',
        options: options ? options.map((item, index) => ({ key: `${nonce}_${index}`, label: item.label.slice(0, 80) })) : [],
        fields: options
            ? []
            : questions.map((item, index) => ({
                  key: `${nonce}_${index}`,
                  label: (item.header ?? `Answer ${index + 1}`).slice(0, 45),
                  multiline: false,
                  required: true,
                  maxLength: 500,
              })),
    };
}
function questionContent(questions: Question[]): string {
    return questions
        .map(
            (item, index) =>
                `${index + 1}. ${item.question}${item.options?.length ? '\nChoices: ' + item.options.map((option) => option.label).join(', ') : ''}`,
        )
        .join('\n\n');
}
function fieldAnswers(questions: Question[], nonce: string, fields?: Record<string, string>): Record<string, string[]> {
    if (!fields || Object.keys(fields).length !== questions.length) throw new Error('Incomplete provider answers');
    return Object.fromEntries(
        questions.map((item, index) => {
            const value = fields[`${nonce}_${index}`];
            if (!value?.trim()) throw new Error('Provider answer is empty');
            const selected = item.multiSelect ? value.split(',').map((value) => value.trim()) : [value];
            if (item.options?.length && selected.some((label) => !item.options!.some((option) => option.label === label)))
                throw new Error('Provider answer must use the requested option labels');
            return [item.id ?? item.question, selected];
        }),
    );
}
