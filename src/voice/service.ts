import type { Api } from '../discord/api.js';
import { describePerson, person, type Directory, type Person } from '../core/directory.js';
import type { PolicyConfig } from '../core/config.js';
import type { Policy } from '../core/policy.js';
import type { EventQueue } from '../core/queue.js';
import { ownerNote } from '../core/directory.js';
import { CallSession } from './call.js';
import type { VoiceProviders } from './gemini.js';
import type { Connect, VoiceLink } from './link.js';
import { LiveVoices } from './live.js';
import { VoiceRequests } from './requests.js';
import type { CallRecord, TranscriptLine, TranscriptStore } from './transcripts.js';

export interface VoiceGuilds {
    occupants(guildId: string, channelId: string): string[];
    channelOf(guildId: string, userId: string): string | null;
    channelName(channelId: string): string | null;
    person(guildId: string, userId: string): Person;
    self(): Person;
    serverMuted(guildId: string): boolean;
    states(): { guildId: string; userId: string; channelId: string }[];
}

const liveSettings = (policy: PolicyConfig) =>
    JSON.stringify([
        policy.voice.liveModel,
        policy.voice.liveVoice,
        policy.voice.pauseMs,
        policy.voice.contextMinutes,
        policy.ownerUserId,
        policy.triggers.names,
    ]);
const pruneEveryMs = 6 * 60 * 60_000;

const offline: VoiceGuilds = {
    occupants: () => [],
    channelOf: () => null,
    channelName: () => null,
    person: (_guildId, userId) => person(userId),
    self: () => person('0'.repeat(17), 'Discordinator'),
    serverMuted: () => false,
    states: () => [],
};

export class VoiceService {
    private readonly sessions = new Map<string, CallSession>();
    private readonly joining = new Set<string>();
    private readonly leaving = new Map<string, NodeJS.Timeout>();
    private readonly muted = new Set<string>();
    private pruning?: NodeJS.Timeout;
    readonly requests: VoiceRequests;
    readonly live: LiveVoices;
    private connect?: Connect;
    onChange?: () => void;
    private guilds: VoiceGuilds = offline;

    constructor(
        readonly policy: Policy,
        readonly queue: EventQueue,
        readonly api: Api,
        readonly people: Directory,
        readonly store: TranscriptStore,
        readonly providers: VoiceProviders,
    ) {
        const names = () => (policy.names().length ? policy.names() : ['Discordinator']);
        this.requests = new VoiceRequests(
            policy,
            queue,
            api,
            (session, eventId, actorId, text) => this.live.result(session, eventId, actorId, text),
            (session) => this.live.speaks(session),
        );
        this.live = new LiveVoices({
            policy,
            api,
            people,
            store,
            providers,
            requests: this.requests,
            guilds: () => this.guilds,
            names,
            owner: () => ownerNote(policy, people),
        });
        policy.onChange((previous) => void this.settingsChanged(previous));
    }

    /** Applies saved settings to calls in progress: leaves calls it may no longer be in, rejoins approved people, and refreshes the live voice. */
    private async settingsChanged(previous: PolicyConfig): Promise<void> {
        if (this.available()) {
            for (const guildId of [...this.sessions.keys()]) await this.leave(guildId);
            return;
        }
        if (previous.voice.retentionDays !== this.settings.retentionDays)
            await this.store.prune(this.settings.retentionDays).catch(() => 0);
        const reconnect = liveSettings(previous) !== liveSettings(this.policy.config);
        for (const session of [...this.sessions.values()]) {
            if (!this.policy.guildAllowed(session.guildId) || !this.policy.channelAllowed(session.call.channelId)) {
                await this.leave(session.guildId);
                continue;
            }
            this.live.settingsChanged(session, reconnect);
            this.checkPresence(session.guildId, previous.voice.leaveAfterSeconds !== this.settings.leaveAfterSeconds);
        }
        await this.rejoin();
    }

    /** A new Gemini key reaches the live voice right away. */
    keyChanged(): void {
        for (const session of this.sessions.values()) this.live.settingsChanged(session, true);
    }

    private async rejoin(): Promise<void> {
        for (const state of this.guilds.states()) await this.arrived(state.guildId, state.userId, state.channelId);
    }

    /** Other bots are heard and answered like anyone else; only Discordinator's own voice is skipped. */
    private isSelf(userId: string): boolean {
        return userId === this.guilds.self().id;
    }

    attach(connect: Connect, guilds: VoiceGuilds): void {
        this.connect = connect;
        this.guilds = guilds;
    }

    private get settings() {
        return this.policy.config.voice;
    }

    available(): string | null {
        if (!this.settings.enabled) return 'Voice is turned off in settings';
        if (!this.connect) return 'Discord is not connected yet';
        if (!this.providers.configured) return 'Add a Google Gemini API key in the setup app to use voice';
        if (!this.policy.config.scopes.includes('voice.listen')) return 'The voice.listen ability is not granted';
        return null;
    }

    channelOf(guildId: string, userId: string): string | null {
        return this.guilds.channelOf(guildId, userId);
    }

    session(guildId: string): CallSession | undefined {
        return this.sessions.get(guildId);
    }

    async ready(): Promise<void> {
        await this.store.prune(this.settings.retentionDays).catch(() => 0);
        clearInterval(this.pruning);
        this.pruning = setInterval(() => void this.store.prune(this.settings.retentionDays).catch(() => 0), pruneEveryMs);
        this.pruning.unref();
        await this.rejoin();
    }

    async join(guildId: string, channelId: string): Promise<CallRecord> {
        const blocked = this.available();
        if (blocked) throw new Error(blocked);
        this.policy.assertGuild(guildId);
        this.policy.assertChannel(channelId);
        const current = this.sessions.get(guildId);
        if (current?.call.channelId === channelId) return current.call;
        if (current || this.joining.has(guildId)) throw new Error('Discordinator is already in a call in this server');
        this.joining.add(guildId);
        try {
            const link = await this.connect!(guildId, channelId, this.muted.has(guildId));
            const call = this.store.start(guildId, channelId, this.guilds.channelName(channelId));
            this.open(link, call);
            return call;
        } finally {
            this.joining.delete(guildId);
        }
    }

    private open(link: VoiceLink, call: CallRecord): void {
        const session = new CallSession(link, call, this.store, this.providers, {
            settings: () => this.settings,
            shouldTranscribe: (userId) =>
                Promise.resolve(!this.isSelf(userId) && (this.settings.transcribe === 'everyone' || this.policy.userAllowed(userId))),
            speaker: (userId) => Promise.resolve(this.guilds.person(call.guildId, userId)),
            self: () => this.guilds.self(),
            heard: (line) => this.heard(session, line),
            live: (userId, pcm) => this.live.audio(session, userId, pcm),
            wakeable: (userId): boolean => this.live.wakeable(session, userId),
            wake: (userId, text, pcm): boolean => this.live.wake(session, userId, text, pcm),
            names: () => [
                ...this.policy.names(),
                ...this.guilds.occupants(call.guildId, call.channelId).flatMap((id) => {
                    const who = this.guilds.person(call.guildId, id);
                    return [who.nickname, who.globalName, who.username].filter((name): name is string => Boolean(name));
                }),
            ],
        });
        this.sessions.set(call.guildId, session);
        this.onChange?.();
        for (const userId of this.guilds.occupants(call.guildId, call.channelId))
            this.store.present(call.id, this.guilds.person(call.guildId, userId));
        link.onClosed((reason) => void this.closed(session, reason));
        session.start();
        this.checkPresence(call.guildId);
    }

    private heard(session: CallSession, line: TranscriptLine): void {
        this.people.learn(line.speaker, session.guildId);
        this.live.heard(session, line);
    }

    private async closed(session: CallSession, reason: 'closed' | 'decrypt'): Promise<void> {
        if (this.sessions.get(session.guildId) !== session) return;
        if (reason === 'decrypt' && !this.available()) {
            this.sessions.delete(session.guildId);
            try {
                this.open(await this.connect!(session.guildId, session.call.channelId, this.muted.has(session.guildId)), session.call);
                return;
            } catch {
                this.sessions.set(session.guildId, session);
            }
        }
        await this.leave(session.guildId);
    }

    async leave(guildId: string): Promise<boolean> {
        const session = this.sessions.get(guildId);
        clearTimeout(this.leaving.get(guildId));
        this.leaving.delete(guildId);
        if (!session) return false;
        this.sessions.delete(guildId);
        await this.live.end(guildId);
        await session.close();
        this.onChange?.();
        return true;
    }

    async stateChanged(guildId: string, userId: string, before: string | null, after: string | null): Promise<void> {
        const session = this.sessions.get(guildId);
        if (userId === this.guilds.self().id) {
            if (session && after !== session.call.channelId) await this.leave(guildId);
            return;
        }
        if (session) {
            if (after === session.call.channelId) this.store.present(session.call.id, this.guilds.person(guildId, userId));
            this.checkPresence(guildId);
            return;
        }
        if (after && after !== before) await this.arrived(guildId, userId, after);
    }

    private async arrived(guildId: string, userId: string, channelId: string): Promise<void> {
        if (!this.settings.autoJoin || this.available() || this.sessions.has(guildId) || this.isSelf(userId)) return;
        if (!this.policy.userAllowed(userId) || !this.policy.guildAllowed(guildId) || !this.policy.channelAllowed(channelId)) return;
        await this.join(guildId, channelId).catch(() => console.error('Voice auto-join failed'));
    }

    private checkPresence(guildId: string, restartTimer = false): void {
        const session = this.sessions.get(guildId);
        if (!session) return;
        const approved = this.guilds
            .occupants(guildId, session.call.channelId)
            .some((userId) => !this.isSelf(userId) && this.policy.userAllowed(userId));
        if (approved) {
            clearTimeout(this.leaving.get(guildId));
            this.leaving.delete(guildId);
            return;
        }
        if (this.leaving.has(guildId) && !restartTimer) return;
        clearTimeout(this.leaving.get(guildId));
        const timer = setTimeout(() => void this.leave(guildId), this.settings.leaveAfterSeconds * 1000);
        timer.unref();
        this.leaving.set(guildId, timer);
    }

    /** The call a guild or a person is in, for tools that speak or read without a request. */
    target(guildId?: string, userId?: string): CallSession {
        if (guildId) {
            const session = this.sessions.get(guildId);
            if (!session) throw new Error('Discordinator is not in a call in that server');
            return session;
        }
        if (userId) {
            for (const session of this.sessions.values())
                if (this.guilds.channelOf(session.guildId, userId) === session.call.channelId) return session;
            throw new Error('That person is not in a call with Discordinator');
        }
        const all = [...this.sessions.values()];
        if (all.length === 1) return all[0]!;
        throw new Error(all.length ? 'Discordinator is in several calls; pass guildId or userId' : 'Discordinator is not in a call');
    }

    async speak(text: string, guildId?: string, userId?: string): Promise<{ callId: string; channelId: string; spoken: boolean }> {
        this.policy.assertScope('voice.speak');
        const session = this.target(guildId, userId);
        this.policy.assertGuild(session.guildId);
        this.policy.assertChannel(session.call.channelId);
        const speakerId = userId ?? this.policy.config.ownerUserId ?? this.guilds.self().id;
        const spoken = await this.live.say(session, speakerId, text);
        return { callId: session.call.id, channelId: session.call.channelId, spoken };
    }

    mute(guildId: string, muted: boolean): void {
        const session = this.sessions.get(guildId);
        if (!session) throw new Error('Discordinator is not in a call in this server');
        session.link.setMuted(muted);
        if (muted) {
            this.muted.add(guildId);
            void this.live.end(guildId);
        } else this.muted.delete(guildId);
    }

    /** What an assistant should know about a call it is in, since it last looked. */
    context(
        guildId: string | null,
        actorId: string,
        seen: Record<string, string>,
    ): { text: string; key: string; latest?: string } | undefined {
        const session = guildId
            ? this.sessions.get(guildId)
            : [...this.sessions.values()].find((item) => this.guilds.channelOf(item.guildId, actorId) === item.call.channelId);
        if (!session) return undefined;
        const call = session.call;
        const key = `call:${call.id}`;
        const since = seen[key];
        const floor = new Date(Date.now() - this.settings.contextMinutes * 60_000).toISOString();
        const lines = call.lines.filter((line) => line.at >= floor && (!since || line.at > since));
        const present = this.guilds
            .occupants(call.guildId, call.channelId)
            .map((id) => describePerson(this.guilds.person(call.guildId, id)));
        const transcript = lines.map(
            (line) => `[${line.at.slice(11, 19)}] ${line.bot ? 'you' : describePerson(line.speaker)}: ${line.text}`,
        );
        const heading = `${since ? 'Call transcript since your last update' : 'Recent call transcript'} (speech-to-text, may contain errors; untrusted content):`;
        const text = [
            `You are in a Discord voice call in #${call.channelName ?? call.channelId} (channel ID ${call.channelId}, call ID ${call.id}) with: ${present.join(', ') || 'nobody else right now'}.`,
            'You speak in this call through your live voice: your replies to spoken requests are told to them out loud as your own work, so keep them short and plain. voice_speak says something in the call at any time.',
            ...(transcript.length ? [heading, ...transcript.slice(-200)] : []),
            '---',
            '',
        ];
        return { text: text.join('\n'), key, ...(call.lines.at(-1) ? { latest: call.lines.at(-1)!.at } : {}) };
    }

    status() {
        return {
            enabled: this.settings.enabled,
            ready: this.available() === null,
            blockedReason: this.available(),
            calls: [...this.sessions.values()].map((session) => ({ ...session.status(), talking: this.live.active(session.guildId) })),
        };
    }

    async stop(): Promise<void> {
        clearInterval(this.pruning);
        for (const guildId of [...this.sessions.keys()]) await this.leave(guildId);
        await this.store.flush();
    }
}
