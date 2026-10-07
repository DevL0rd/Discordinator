import { join } from 'node:path';
import { Readable } from 'node:stream';
import { person, type Person } from '../src/core/directory.js';
import { opusCodec, opusFrames } from '../src/voice/audio.js';
import type { AudioOut, VoiceLink } from '../src/voice/link.js';
import type { LiveEvents, LiveOptions, LiveSession, ToolDelivery, VoiceProviders } from '../src/voice/gemini.js';
import { VoiceService, type VoiceGuilds } from '../src/voice/service.js';
import { TranscriptStore } from '../src/voice/transcripts.js';
import { fixture, ids } from './fixtures.js';

export const voiceChannel = '888888888888888801';
export const otherVoice = '888888888888888802';
export const stranger = '999999999999999993';
export const botUser = '999999999999999994';

export function tone(seconds: number, volume = 8000): Buffer[] {
    const pcm = new Int16Array(Math.round(seconds * 48_000) * 2);
    for (let index = 0; index < pcm.length / 2; index++) {
        const value = Math.round(Math.sin((index / 48_000) * 2 * Math.PI * 440) * volume);
        pcm[index * 2] = value;
        pcm[index * 2 + 1] = value;
    }
    const codec = opusCodec();
    try {
        return opusFrames(pcm, codec);
    } finally {
        codec.free();
    }
}

class FakeLink implements VoiceLink {
    muted = false;
    talkers: string[] = [];
    outputs: { frames: Buffer[]; ended: boolean }[] = [];
    stopped = 0;
    destroyed = false;
    private speakingListener?: (userId: string) => void;
    private closedListener?: (reason: 'closed' | 'decrypt') => void;
    private readonly streams = new Map<string, Buffer[]>();
    constructor(readonly channelId: string) {}
    onSpeaking(listener: (userId: string) => void): void {
        this.speakingListener = listener;
    }
    talking(): string[] {
        return this.talkers;
    }
    setMuted(muted: boolean): void {
        this.muted = muted;
    }
    listen(userId: string): AsyncIterable<Buffer> {
        const packets = this.streams.get(userId) ?? [];
        this.streams.delete(userId);
        return Readable.from(packets);
    }
    talk(userId: string, packets: Buffer[]): void {
        this.streams.set(userId, packets);
        this.speakingListener?.(userId);
    }
    get playing(): boolean {
        return this.outputs.some((item) => !item.ended);
    }
    stream(): AudioOut {
        const entry = { frames: [] as Buffer[], ended: false };
        this.outputs.push(entry);
        return { push: (frames) => entry.frames.push(...frames), end: () => (entry.ended = true) };
    }
    stop(): void {
        this.stopped++;
        for (const entry of this.outputs) entry.ended = true;
    }
    onClosed(listener: (reason: 'closed' | 'decrypt') => void): void {
        this.closedListener = listener;
    }
    close(reason: 'closed' | 'decrypt'): void {
        this.closedListener?.(reason);
    }
    destroy(): void {
        this.destroyed = true;
    }
}

class FakeLive implements LiveSession {
    sent = 0;
    loud = 0;
    texts: { text: string; respond: boolean }[] = [];
    results: { id: string; name: string; response: Record<string, unknown>; delivery?: ToolDelivery }[] = [];
    closed = false;
    constructor(
        readonly options: LiveOptions,
        readonly events: LiveEvents,
    ) {}
    audio(pcm: Int16Array): void {
        this.sent++;
        if (pcm.some((sample) => sample !== 0)) this.loud++;
    }
    text(text: string, respond: boolean): void {
        this.texts.push({ text, respond });
    }
    toolResult(id: string, name: string, response: Record<string, unknown>, delivery?: ToolDelivery): void {
        this.results.push({ id, name, response, ...(delivery ? { delivery } : {}) });
    }
    close(): void {
        this.closed = true;
    }
    reply(text: string, seconds = 0.2): void {
        this.events.audio(new Int16Array(Math.round(seconds * 24_000)).fill(1000));
        this.events.said(text);
        this.events.turnComplete();
    }
}

class FakeProviders implements VoiceProviders {
    configured = true;
    heard: string[] = [];
    contexts: string[] = [];
    sessions: FakeLive[] = [];
    failNext = false;
    failLive = false;
    transcribe(_audio: Buffer, model: string, _language: string, context = ''): Promise<string> {
        this.contexts.push(context);
        if (this.failNext) {
            this.failNext = false;
            return Promise.reject(new Error('down'));
        }
        return Promise.resolve(this.heard.shift() ?? `heard by ${model}`);
    }
    live(options: LiveOptions, events: LiveEvents): Promise<LiveSession> {
        if (this.failLive) return Promise.reject(new Error('live down'));
        const session = new FakeLive(options, events);
        this.sessions.push(session);
        return Promise.resolve(session);
    }
    get session(): FakeLive {
        return this.sessions.at(-1)!;
    }
}

class FakeGuilds implements VoiceGuilds {
    people = new Map<string, Person>([
        [ids.user, person(ids.user, 'devl0rd', 'DevL0rd', null)],
        [stranger, person(stranger, 'mallory', 'Mallory', 'DevL0rd')],
        [botUser, person(botUser, 'otherbot', null, null)],
    ]);
    seats = new Map<string, string>();
    serverMute = false;
    serverMuted(): boolean {
        return this.serverMute;
    }
    occupants(_guildId: string, channelId: string): string[] {
        return [...this.seats].filter(([, channel]) => channel === channelId).map(([id]) => id);
    }
    channelOf(_guildId: string, userId: string): string | null {
        return this.seats.get(userId) ?? null;
    }
    channelName(channelId: string): string | null {
        return channelId === voiceChannel ? 'Hangout' : null;
    }
    isBot(userId: string): boolean {
        return userId === botUser;
    }
    person(_guildId: string, userId: string): Person {
        return this.people.get(userId) ?? person(userId);
    }
    self(): Person {
        return person(ids.bot, 'Discordinator', null, null);
    }
    states() {
        return [...this.seats].map(([userId, channelId]) => ({ guildId: ids.guild, userId, channelId }));
    }
}

export function voiceHarness(directory: string, name: string, f = fixture(join(directory, `${name}.json`))) {
    f.policy.config.scopes.push('voice.listen', 'voice.speak', 'messages.read');
    f.policy.config.ownerUserId = ids.user;
    f.policy.config.voice = { ...f.policy.config.voice, enabled: true };
    const providers = new FakeProviders();
    const store = new TranscriptStore(join(directory, `${name}-voice`));
    const voice = new VoiceService(f.policy, f.queue, f.api, f.bridge.people, store, providers);
    const guilds = new FakeGuilds();
    const links: FakeLink[] = [];
    voice.attach((_guildId, channelId) => {
        const link = new FakeLink(channelId);
        links.push(link);
        return Promise.resolve(link);
    }, guilds);
    f.bridge.voice = voice;
    return { ...f, voice, providers, store, guilds, links, link: () => links.at(-1)! };
}
