import type { VoiceConfig } from '../core/config.js';
import { concat, loudness, OpusFramer, opusCodec, toSpeech, type OpusCodec } from './audio.js';
import type { LiveSession, LiveTool, VoiceProviders } from './gemini.js';
import type { AudioOut, VoiceLink } from './link.js';

export interface ConversationHooks {
    settings(): VoiceConfig;
    system(): string;
    record(text: string): void;
    task(task: string): string | null;
    ended(conversation: Conversation): void;
}

const liveTools: LiveTool[] = [
    {
        name: 'do_task',
        description:
            'Do something that is more than conversation: actions, Discord changes, sending messages, files, code, research, checking or looking things up. It runs in the background while you keep talking. Results come back to you as [Task update] notes; tell them about it then.',
        parameters: { task: 'What to do, in full, with every name, place, detail and preference they gave.' },
    },
    {
        name: 'stop_listening',
        description:
            'End this conversation when it is over, they are talking to someone else, or you only hear noise not meant for you. You keep the call transcript and come back when someone says your name.',
    },
];

const stopGraceMs = 5000;
const tickMs = 100;
const tickSamples = 1600;
const speaking = 300;

/** One stretch of live, spoken conversation with Gemini Live in a call. */
export class Conversation {
    private session?: LiveSession;
    private resume?: string;
    private out?: AudioOut;
    private readonly framer: OpusFramer;
    private readonly codec: OpusCodec;
    private said = '';
    private readonly heard = new Map<string, Int16Array[]>();
    private timer?: NodeJS.Timeout;
    private lastActivity: number;
    private closed = false;
    private stopping = false;
    private turnDone = false;
    private stopTimer?: NodeJS.Timeout;
    private reconnected = false;
    private generation = 0;
    private readonly tasks = new Map<string, { id: string; name: string }>();

    constructor(
        private readonly providers: VoiceProviders,
        private readonly link: VoiceLink,
        readonly speakerId: string,
        private readonly hooks: ConversationHooks,
        private readonly now = Date.now,
    ) {
        this.codec = opusCodec();
        this.framer = new OpusFramer(this.codec);
        this.lastActivity = now();
    }

    get active(): boolean {
        return !this.closed;
    }

    async start(first?: string): Promise<void> {
        this.session = await this.open();
        if (first) this.session.text(first, true);
        this.timer = setInterval(() => this.tick(), tickMs);
        this.timer.unref();
    }

    private open(): Promise<LiveSession> {
        const settings = this.hooks.settings();
        const generation = ++this.generation;
        const current = () => generation === this.generation;
        return this.providers.live(
            {
                model: settings.liveModel,
                voice: settings.liveVoice,
                pauseMs: settings.pauseMs,
                system: this.hooks.system(),
                tools: liveTools,
                ...(this.resume ? { resume: this.resume } : {}),
            },
            {
                audio: (pcm) => current() && this.play(pcm),
                said: (text) => {
                    if (current()) this.said += text;
                },
                interrupted: () => current() && this.cut(),
                turnComplete: () => current() && this.finishTurn(),
                tool: (id, name, args) => current() && this.tool(id, name, args),
                resumable: (handle) => {
                    if (current()) this.resume = handle;
                },
                closed: () => current() && void this.dropped(),
            },
        );
    }

    private play(pcm: Int16Array): void {
        if (this.closed) return;
        this.lastActivity = this.now();
        this.out ??= this.link.stream();
        this.out.push(this.framer.live(pcm));
    }

    private cut(): void {
        this.link.stop();
        this.out = undefined;
        this.framer.reset();
        this.flushSaid();
    }

    private finishTurn(): void {
        if (this.stopping) this.turnDone = true;
        if (this.out) {
            this.out.push(this.framer.flush());
            this.out.end();
            this.out = undefined;
        }
        this.flushSaid();
    }

    private flushSaid(): void {
        const text = this.said.replace(/\s+/g, ' ').trim();
        this.said = '';
        if (!text) return;
        this.hooks.record(text);
    }

    private tool(id: string, name: string, args: Record<string, unknown>): void {
        if (name === 'stop_listening') {
            this.session?.toolResult(id, name, { ok: true });
            this.stopping = true;
            this.stopTimer ??= setTimeout(() => void this.end(), stopGraceMs);
            this.stopTimer.unref();
            return;
        }
        if (name !== 'do_task') return this.session?.toolResult(id, name, { error: 'Unknown tool' });
        this.startTask(id, name, args);
    }

    private startTask(id: string, name: string, args: Record<string, unknown>): void {
        const task = typeof args.task === 'string' ? args.task.trim() : '';
        const eventId = task ? this.hooks.task(task) : null;
        if (!eventId) return this.session?.toolResult(id, name, { error: task ? 'That cannot be done from here' : 'No task was given' });
        this.tasks.set(eventId, { id, name });
        this.session?.toolResult(id, name, { status: 'started; it is running now' }, { scheduling: 'idle', more: true });
    }

    /** A reply about a task this conversation started, delivered on that task's tool call at the next natural pause. */
    taskUpdate(eventId: string, text: string): boolean {
        const call = this.tasks.get(eventId);
        if (this.closed || !call || !this.session) return false;
        this.lastActivity = this.now();
        const scheduling = this.hooks.settings().resultTiming === 'immediately' ? 'interrupt' : 'idle';
        this.session.toolResult(call.id, call.name, { update: text }, { scheduling, more: true });
        return true;
    }

    async reopen(): Promise<void> {
        if (this.closed || !this.session) return;
        const previous = this.session;
        this.session = undefined;
        this.generation++;
        this.cut();
        previous.close();
        const next = await this.open()
            .catch(() => {
                this.resume = undefined;
                return this.open();
            })
            .catch(() => undefined);
        if (this.closed) return next?.close();
        if (!next) return this.end();
        this.session = next;
    }

    private async dropped(): Promise<void> {
        if (this.closed) return;
        if (this.reconnected || !this.resume) return this.end();
        this.reconnected = true;
        try {
            this.session = await this.open();
        } catch {
            await this.end();
        }
    }

    /** Live audio from an approved person in the call (48 kHz stereo), mixed into what Gemini hears. */
    hear(userId: string, pcm: Int16Array): void {
        if (this.closed) return;
        const speech = toSpeech(pcm);
        if (loudness(speech) > speaking) this.lastActivity = this.now();
        const queue = this.heard.get(userId) ?? [];
        queue.push(speech);
        this.heard.set(userId, queue);
    }

    /** Something said by a person whose voice is not sent live, added as context without a reply. */
    note(text: string): void {
        if (!this.closed) this.session?.text(text, false);
    }

    /** Asks it to say something now, in its own words. */
    prompt(text: string): void {
        if (this.closed) return;
        this.lastActivity = this.now();
        this.session?.text(text, true);
    }

    private take(userId: string): Int16Array {
        const joined = concat(this.heard.get(userId) ?? []);
        this.heard.set(userId, joined.length > tickSamples ? [joined.slice(tickSamples)] : []);
        return joined.subarray(0, tickSamples);
    }

    private backlog(): boolean {
        return [...this.heard.values()].some((queue) => queue.reduce((total, chunk) => total + chunk.length, 0) >= tickSamples);
    }

    private mix(): Int16Array {
        const mixed = new Int32Array(tickSamples);
        for (const userId of this.heard.keys()) this.take(userId).forEach((sample, index) => (mixed[index] = mixed[index]! + sample));
        return Int16Array.from(mixed, (sample) => Math.max(-32768, Math.min(32767, sample)));
    }

    private tick(): void {
        if (this.closed || !this.session) return;
        do this.session?.audio(this.mix());
        while (this.backlog());
        if (this.turnDone && !this.out && !this.link.playing) return void this.end();
        if (!this.out && this.now() - this.lastActivity > this.hooks.settings().idleSeconds * 1000) void this.end();
    }

    async end(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.timer);
        clearTimeout(this.stopTimer);
        this.cut();
        this.session?.close();
        this.codec.free();
        this.hooks.ended(this);
        await Promise.resolve();
    }
}
