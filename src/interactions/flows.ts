import { randomUUID } from 'node:crypto';
import type { APIActionRowComponent, APIComponentInMessageActionRow, APIModalInteractionResponseCallbackData } from 'discord.js';
import type { Policy } from '../core/policy.js';
import type { AccessContext, EventQueue } from '../core/queue.js';
import type { Api } from '../discord/api.js';
import { promptSchema, type Prompt } from './schema.js';

interface Flow {
    id: string;
    eventId: string;
    prompt: Prompt;
    messageId?: string;
    state: 'ready' | 'modal' | 'used';
    modalId: string;
    controls: string[];
    origin: AccessContext['event'];
}
export interface ControlInput {
    customId: string;
    actorId: string;
    channelId: string;
    guildId: string | null;
    applicationId: string;
    messageId?: string;
    messageAuthorId?: string;
    values?: string[];
    fields?: Record<string, string>;
    modal: boolean;
    componentType: number;
}

const buttonStyles = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;

export class Flows {
    private items = new Map<string, Flow>();
    constructor(
        readonly policy: Policy,
        readonly queue: EventQueue,
        readonly api: Api,
        readonly now = Date.now,
    ) {}
    authorize(eventId: string) {
        const context = this.queue.authorize(eventId);
        this.policy.assertOrigin(context.event);
        this.policy.assertScope('interactions.write');
        this.policy.assertScope('messages.write');
        return context;
    }
    prepare(eventId: string, value: Prompt) {
        const origin = this.authorize(eventId).event;
        for (const [id, item] of this.items) if (item.state === 'used') this.items.delete(id);
        if (this.items.size >= 100) throw new Error('Interaction correlation limit reached');
        const prompt = promptSchema.parse(value);
        const id = randomUUID();
        const flow: Flow = {
            id,
            origin,
            eventId,
            prompt,
            state: 'ready',
            modalId: `discordinator:${randomUUID()}`,
            controls: prompt.options.map(() => `discordinator:${randomUUID()}`),
        };
        if (prompt.mode !== 'buttons') flow.controls = [`discordinator:${randomUUID()}`];
        this.items.set(id, flow);
        return { id, expiresAt: null, components: this.components(flow) };
    }
    bind(id: string, messageId: string): void {
        if (!/^\d{17,20}$/.test(messageId)) throw new Error('Invalid prompt message binding');
        this.items.get(id)!.messageId = messageId;
    }
    private components(flow: Flow): APIActionRowComponent<APIComponentInMessageActionRow>[] {
        if (flow.prompt.mode === 'select')
            return [
                {
                    type: 1,
                    components: [
                        {
                            type: 3,
                            custom_id: flow.controls[0]!,
                            min_values: 1,
                            max_values: flow.prompt.maxValues ?? 1,
                            options: flow.prompt.options.map((item) => ({ label: item.label, value: item.key })),
                        },
                    ],
                },
            ];
        const options = flow.prompt.mode === 'modal' ? [{ key: 'input', label: 'Open input' }] : flow.prompt.options;
        return [
            {
                type: 1,
                components: options.map((item, index) => ({
                    type: 2,
                    style: buttonStyles[('style' in item ? item.style : undefined) ?? 'primary'],
                    label: item.label,
                    custom_id: flow.controls[index]!,
                })),
            },
        ];
    }
    accept(input: ControlInput): {
        eventId: string;
        origin: AccessContext['event'];
        text?: string;
        modal?: APIModalInteractionResponseCallbackData;
    } {
        this.policy.assertUser(input.actorId);
        const flow = [...this.items.values()].find((item) => item.controls.includes(input.customId) || item.modalId === input.customId);
        if (!flow || flow.state === 'used') throw new Error('Control is unknown or consumed');
        this.assertSource(flow, input);
        if (input.modal) return this.submit(flow, input);
        if (flow.state !== 'ready' || input.messageId !== flow.messageId || input.messageAuthorId !== this.api.botId)
            throw new Error('Control prompt binding mismatch');
        if (input.componentType !== (flow.prompt.mode === 'select' ? 3 : 2)) throw new Error('Unexpected control type');
        return this.choice(flow, input);
    }
    private assertSource(flow: Flow, input: ControlInput): void {
        const origin = flow.origin;
        this.policy.assertOrigin(origin);
        this.policy.assertScope('interactions.write');
        this.policy.assertScope('messages.write');
        if (origin.kind === 'owner') this.policy.assertProactive(origin.channelId);
        else this.authorize(flow.eventId);
        if (
            input.applicationId !== this.api.botId ||
            input.actorId !== origin.actorId ||
            input.channelId !== origin.channelId ||
            input.guildId !== origin.guildId
        ) {
            throw new Error('Control source or actor mismatch');
        }
    }
    private choice(flow: Flow, input: ControlInput) {
        if (flow.prompt.mode === 'modal') {
            flow.state = 'modal';
            return { eventId: flow.eventId, origin: flow.origin, modal: this.modal(flow) };
        }
        const values = flow.prompt.mode === 'buttons' ? [flow.prompt.options[flow.controls.indexOf(input.customId)]!.key] : input.values;
        if (
            !values ||
            !values.length ||
            values.length > (flow.prompt.maxValues ?? 1) ||
            new Set(values).size !== values.length ||
            values.some((value) => !flow.prompt.options.some((item) => item.key === value))
        )
            throw new Error('Invalid control choice');
        flow.state = 'used';
        return {
            eventId: flow.eventId,
            origin: flow.origin,
            text: JSON.stringify(values.length === 1 ? { choice: values[0] } : { choices: values }),
        };
    }
    private modal(flow: Flow): APIModalInteractionResponseCallbackData {
        return {
            custom_id: flow.modalId,
            title: flow.prompt.title,
            components: flow.prompt.fields.map((field) => ({
                type: 18,
                label: field.label,
                component: {
                    type: 4,
                    custom_id: field.key,
                    style: field.multiline ? 2 : 1,
                    required: field.required,
                    max_length: field.maxLength,
                    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
                },
            })),
        };
    }
    private submit(flow: Flow, input: ControlInput) {
        if (flow.state !== 'modal' || flow.modalId !== input.customId || !input.fields) throw new Error('Modal has no matching launch');
        const keys = Object.keys(input.fields);
        if (keys.length !== flow.prompt.fields.length || keys.some((key) => !flow.prompt.fields.some((field) => field.key === key)))
            throw new Error('Unknown modal fields');
        for (const field of flow.prompt.fields) {
            const value = input.fields[field.key]!;
            if (value.length > field.maxLength || (field.required && !value.length)) throw new Error('Invalid modal field length');
        }
        flow.state = 'used';
        return { eventId: flow.eventId, origin: flow.origin, text: JSON.stringify({ fields: input.fields }) };
    }
}
