import type { Api } from '../discord/api.js';
import { mentions } from '../discord/operations.js';
import type { Person } from '../core/directory.js';
import type { Policy } from '../core/policy.js';
import type { BotEvent, Delivery, EventQueue } from '../core/queue.js';
import { Triggers } from '../core/triggers.js';
import { fadeLater } from '../core/fade.js';
import type { CallSession } from './call.js';

export async function postToCall(api: Api, channelId: string, payload: Delivery): Promise<{ id: string; channel_id: string }> {
    const body = { content: payload.content, embeds: payload.embeds, components: payload.components, allowed_mentions: mentions };
    const route = `/channels/${channelId}/messages`;
    const posted = (
        payload.files?.length
            ? await api.postFiles(
                  route,
                  { ...body, attachments: payload.files.map((file, id) => ({ id, filename: file.name })) },
                  payload.files,
              )
            : await api.post(route, body)
    ) as { id: string; channel_id: string };
    return { id: posted.id, channel_id: posted.channel_id };
}

const requestWindowMs = 60_000;
const spokenOnly = (payload: Delivery) => !payload.files?.length && !payload.embeds?.length && !payload.components?.length;

/** What a person said in the last minute of a call, verbatim, so a request keeps their own words. */
export function spokenBy(session: CallSession, userId: string): string {
    const since = new Date(Date.now() - requestWindowMs).toISOString();
    return session.call.lines
        .filter((line) => line.userId === userId && !line.bot && line.at >= since)
        .map((line) => line.text)
        .join(' ')
        .slice(-3000);
}

export type TaskResult = (session: CallSession, eventId: string, actorId: string, text: string) => void;

/** Turns spoken work into responder requests from the approved person who asked, and routes the replies back to the voice. */
export class VoiceRequests {
    private readonly triggers: Triggers;
    publish?: (event: BotEvent) => Promise<void>;

    constructor(
        private readonly policy: Policy,
        private readonly queue: EventQueue,
        private readonly api: Api,
        private readonly result: TaskResult,
        private readonly speaks: (session: CallSession) => boolean = () => false,
    ) {
        this.triggers = new Triggers(policy);
    }

    named(text: string): boolean {
        return this.triggers.named(text);
    }

    request(session: CallSession, actor: Person, text: string): BotEvent | null {
        const input = {
            kind: 'voice' as const,
            actorId: actor.id,
            channelId: session.call.channelId,
            guildId: session.call.guildId,
            name: 'discordinator.voice',
            text: text.slice(0, 4000),
            author: actor,
        };
        try {
            this.policy.assertUser(actor.id);
            this.policy.assertOrigin(input);
        } catch {
            return null;
        }
        let eventId = '';
        const reply = (payload: Delivery, quiet?: boolean) => this.reply(session, eventId, actor.id, payload, quiet);
        const event = this.queue.add(
            `voice:${session.call.id}:${Date.now()}:${actor.id}`,
            input,
            (content, quiet) => reply({ content }, quiet),
            (payload) => reply(payload),
        );
        if (!event) return null;
        eventId = event.id;
        void this.publish?.(event).catch(() => console.error('Voice request could not be published'));
        return event;
    }

    private async reply(session: CallSession, eventId: string, actorId: string, payload: Delivery, quiet = false): Promise<unknown> {
        this.policy.assertScope('messages.write');
        const tell = !quiet && Boolean(payload.content);
        const posted =
            spokenOnly(payload) && this.speaks(session) ? { spoken: tell } : await postToCall(this.api, session.call.channelId, payload);
        if (quiet && 'id' in posted) fadeLater(() => this.api.delete(`/channels/${posted.channel_id}/messages/${posted.id}`));
        if (tell) this.result(session, eventId, actorId, payload.content);
        return posted;
    }
}
