import type { VoiceConfig } from '../core/config.js';
import type { Person } from '../core/directory.js';
import { concat, loudness, opusCodec, speechRate, toSpeech, wav, type OpusCodec } from './audio.js';
import type { VoiceProviders } from './gemini.js';
import type { VoiceLink } from './link.js';
import type { CallRecord, TranscriptLine, TranscriptStore } from './transcripts.js';

export interface CallHooks {
    settings(): VoiceConfig;
    shouldTranscribe(userId: string): Promise<boolean>;
    speaker(userId: string): Promise<Person>;
    self(): Person;
    heard(line: TranscriptLine): void;
    live(userId: string, pcm: Int16Array): void;
    names(): string[];
    wakeable(userId: string): boolean;
    wake(userId: string, text: string, pcm: Int16Array): boolean;
}

export interface Utterance {
    userId: string;
    startedAt: number;
    pcm: Int16Array;
}

interface Speech {
    userId: string;
    chunks: Int16Array[];
    length: number;
    startedAt: number;
    peekedAt: number;
    peeking: boolean;
    woke: boolean;
}

const silenceMs = 600;
const maxUtteranceSeconds = 30;
const minSeconds = 0.4;
const quiet = 120;
const maxPending = 16;
const workers = 2;
const peekMs = 800;
const peekSeconds = 8;

export class CallSession {
    private pending: Utterance[] = [];
    private running = 0;
    private listening = new Set<string>();
    private closed = false;
    dropped = 0;
    failures = 0;
    badPackets = 0;

    constructor(
        readonly link: VoiceLink,
        readonly call: CallRecord,
        private readonly store: TranscriptStore,
        private readonly providers: VoiceProviders,
        private readonly hooks: CallHooks,
        private readonly options: { codec?: () => OpusCodec; now?: () => number } = {},
    ) {}

    private codec(): OpusCodec {
        return (this.options.codec ?? opusCodec)();
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    start(): void {
        this.link.onSpeaking((userId) => void this.capture(userId).catch(() => undefined));
    }

    get guildId(): string {
        return this.call.guildId;
    }

    private async capture(userId: string): Promise<void> {
        if (this.closed || this.listening.has(userId) || !(await this.hooks.shouldTranscribe(userId))) return;
        this.listening.add(userId);
        const decoder = this.codec();
        const now = this.now();
        const speech: Speech = { userId, chunks: [], length: 0, startedAt: now, peekedAt: now, peeking: false, woke: false };
        try {
            for await (const packet of this.link.listen(userId, silenceMs)) {
                let pcm: Int16Array;
                try {
                    pcm = decoder.decode(packet);
                } catch {
                    // One corrupt packet costs 20 ms of audio, not the speaker's whole utterance.
                    this.badPackets++;
                    continue;
                }
                this.hooks.live(userId, pcm);
                speech.chunks.push(pcm);
                speech.length += pcm.length;
                this.peek(speech);
                if (speech.length < maxUtteranceSeconds * 96_000) continue;
                this.enqueue({ userId, startedAt: speech.startedAt, pcm: concat(speech.chunks) });
                Object.assign(speech, { chunks: [], length: 0, startedAt: this.now() });
            }
        } finally {
            decoder.free();
            this.listening.delete(userId);
        }
        if (speech.chunks.length) this.enqueue({ userId, startedAt: speech.startedAt, pcm: concat(speech.chunks) });
    }

    private peek(speech: Speech): void {
        const now = this.now();
        if (speech.woke || speech.peeking || now - speech.peekedAt < peekMs || !this.hooks.wakeable(speech.userId)) return;
        speech.peekedAt = now;
        const pcm = toSpeech(concat(speech.chunks).subarray(-peekSeconds * 96_000));
        if (pcm.length < minSeconds * speechRate || loudness(pcm) < quiet) return;
        speech.peeking = true;
        const settings = this.hooks.settings();
        void this.providers
            .transcribe(wav(pcm), settings.transcribeModel, settings.language, this.context())
            .then((text) => {
                if (text && !this.closed && !speech.woke) speech.woke = this.hooks.wake(speech.userId, text, concat(speech.chunks));
            })
            .catch(() => undefined)
            .finally(() => (speech.peeking = false));
    }

    enqueue(utterance: Utterance): void {
        if (this.closed) return;
        const speech = toSpeech(utterance.pcm);
        if (speech.length < minSeconds * speechRate || loudness(speech) < quiet) return;
        if (this.pending.length >= maxPending) {
            this.pending.shift();
            this.dropped++;
        }
        this.pending.push({ ...utterance, pcm: speech });
        this.drain();
    }

    private drain(): void {
        while (this.running < workers && this.pending.length) {
            const next = this.pending.shift()!;
            this.running++;
            void this.transcribe(next).finally(() => {
                this.running--;
                this.drain();
            });
        }
    }

    private async transcribe(utterance: Utterance): Promise<void> {
        const settings = this.hooks.settings();
        let text: string;
        try {
            text = await this.providers.transcribe(wav(utterance.pcm), settings.transcribeModel, settings.language, this.context());
        } catch {
            this.failures++;
            return;
        }
        if (!text || this.closed) return;
        const line = {
            at: new Date(utterance.startedAt).toISOString(),
            userId: utterance.userId,
            speaker: await this.hooks.speaker(utterance.userId),
            text,
            bot: false,
        };
        this.store.add(this.call.id, line);
        this.hooks.heard(line);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.pending = [];
        this.link.destroy();
        await this.store.end(this.call.id);
    }

    /** A little context for the transcriber: names it may hear and the last five things said. */
    private context(): string {
        const names = [...new Set(this.hooks.names().filter(Boolean))].join(', ');
        const recent = this.call.lines
            .slice(-5)
            .map(
                (line) =>
                    `${line.bot ? this.hooks.self().username : (line.speaker.nickname ?? line.speaker.globalName ?? line.speaker.username)}: ${line.text}`,
            );
        return [names ? `Names: ${names}` : '', ...recent].filter(Boolean).join('\n').slice(-1500);
    }

    status() {
        return {
            callId: this.call.id,
            channelId: this.call.channelId,
            pending: this.pending.length,
            dropped: this.dropped,
            failures: this.failures,
        };
    }
}
