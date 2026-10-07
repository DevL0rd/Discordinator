import type { VoiceConfig } from '../core/config.js';
import { describePerson, type Directory } from '../core/directory.js';
import type { Policy } from '../core/policy.js';
import type { Api } from '../discord/api.js';
import type { CallSession } from './call.js';
import { Conversation, type ConversationHooks } from './conversation.js';
import type { VoiceProviders } from './gemini.js';
import { liveInstructions } from './instructions.js';
import { postToCall, spokenBy, type VoiceRequests } from './requests.js';
import type { VoiceGuilds } from './service.js';
import type { TranscriptLine, TranscriptStore } from './transcripts.js';

export interface LiveHost {
    policy: Policy;
    api: Api;
    people: Directory;
    store: TranscriptStore;
    providers: VoiceProviders;
    requests: VoiceRequests;
    guilds(): VoiceGuilds;
    names(): string[];
    owner(): string;
}

/** Opens Gemini Live when an approved person says the bot's name, and lets it drift back to just listening. */
export class LiveVoices {
    private readonly conversations = new Map<string, Conversation>();

    constructor(private readonly host: LiveHost) {}

    private get settings(): VoiceConfig {
        return this.host.policy.config.voice;
    }

    active(guildId: string): boolean {
        return this.conversations.get(guildId)?.active === true;
    }

    muted(session: CallSession): boolean {
        return session.link.muted || this.host.guilds().serverMuted(session.guildId);
    }

    /** Unmuted with a live voice it speaks instead of typing; muted it types instead. */
    speaks(session: CallSession): boolean {
        return this.host.policy.config.scopes.includes('voice.speak') && this.host.providers.configured && !this.muted(session);
    }

    heard(session: CallSession, line: TranscriptLine): void {
        if (line.bot) return;
        const approved = this.host.policy.userAllowed(line.userId);
        const conversation = this.conversations.get(session.guildId);
        if (conversation?.active) {
            if (!approved) conversation.note(`[Transcript] ${describePerson(line.speaker)}: ${line.text}`);
            return;
        }
        if (!approved || !this.host.requests.named(line.text)) return;
        if (!this.speaks(session)) {
            this.host.requests.request(session, line.speaker, spokenBy(session, line.userId) || line.text);
            return;
        }
        void this.engage(session, line.userId, `${describePerson(line.speaker)} said to you: "${line.text}"`).catch(() =>
            this.host.requests.request(session, line.speaker, spokenBy(session, line.userId) || line.text),
        );
    }

    /** Live audio from the call; only approved people are heard by the live voice. */
    audio(session: CallSession, userId: string, pcm: Int16Array): void {
        const conversation = this.conversations.get(session.guildId);
        if (conversation?.active && this.host.policy.userAllowed(userId)) conversation.hear(userId, pcm);
    }

    /** A task reply, told by the live voice as its own work: on the task's own call at the next pause, or by coming back to say it. */
    result(session: CallSession, eventId: string, actorId: string, text: string): void {
        const conversation = this.conversations.get(session.guildId);
        if (conversation?.taskUpdate(eventId, text.slice(0, 4000))) return;
        const update = `[Task update] ${text.slice(0, 4000)}\nTell them how it went now, briefly and in your own words, as your own work.`;
        if (conversation?.active) return conversation.prompt(update);
        if (this.speaks(session)) void this.engage(session, actorId, update).catch(() => undefined);
    }

    /** Says something in the call at any time. Muted, it is only typed in the call chat. */
    async say(session: CallSession, speakerId: string, text: string): Promise<boolean> {
        if (!this.speaks(session)) {
            this.host.policy.assertScope('messages.write');
            await postToCall(this.host.api, session.call.channelId, { content: text.slice(0, 2000) });
            return false;
        }
        const instruction = `[Say this to the call now, naturally and in your own words] ${text}`;
        const conversation = this.conversations.get(session.guildId);
        if (conversation?.active) conversation.prompt(instruction);
        else await this.engage(session, speakerId, instruction);
        return true;
    }

    async end(guildId: string): Promise<void> {
        await this.conversations.get(guildId)?.end();
    }

    private async engage(session: CallSession, speakerId: string, first: string): Promise<void> {
        const existing = this.conversations.get(session.guildId);
        if (existing?.active) return existing.prompt(first);
        const conversation = new Conversation(this.host.providers, session.link, speakerId, this.hooks(session, speakerId));
        this.conversations.set(session.guildId, conversation);
        try {
            await conversation.start(first);
        } catch (error) {
            await conversation.end();
            throw error;
        }
    }

    private hooks(session: CallSession, speakerId: string): ConversationHooks {
        const guilds = this.host.guilds();
        const speaker = () => guilds.person(session.guildId, speakerId);
        return {
            settings: () => this.settings,
            system: () =>
                liveInstructions({
                    names: this.host.names(),
                    owner: this.host.owner(),
                    call: session.call,
                    present: guilds.occupants(session.guildId, session.call.channelId).map((id) => guilds.person(session.guildId, id)),
                    speaker: speaker(),
                    contextMinutes: this.settings.contextMinutes,
                }),
            record: (text) => {
                const self = guilds.self();
                this.host.store.add(session.call.id, { at: new Date().toISOString(), userId: self.id, speaker: self, text, bot: true });
            },
            task: (task) => {
                const said = spokenBy(session, speakerId);
                const text = said ? `${task}\n\nIn their own words: "${said}"` : task;
                return this.host.requests.request(session, speaker(), text)?.id ?? null;
            },
            ended: (conversation) => {
                if (this.conversations.get(session.guildId) === conversation) this.conversations.delete(session.guildId);
            },
        };
    }
}
