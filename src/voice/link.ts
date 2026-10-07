import { PassThrough, Readable } from 'node:stream';
import {
    AudioPlayerStatus,
    createAudioPlayer,
    createAudioResource,
    EndBehaviorType,
    entersState,
    joinVoiceChannel,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    type AudioPlayer,
    type VoiceConnection,
} from '@discordjs/voice';
import type { Client } from 'discord.js';

export interface VoiceLink {
    readonly channelId: string;
    onSpeaking(listener: (userId: string) => void): void;
    talking(): string[];
    readonly muted: boolean;
    setMuted(muted: boolean): void;
    listen(userId: string, silenceMs: number): AsyncIterable<Buffer>;
    /** Starts streamed playback of Opus frames, replacing anything playing. */
    stream(): AudioOut;
    stop(): void;
    readonly playing: boolean;
    onClosed(listener: (reason: 'closed' | 'decrypt') => void): void;
    destroy(): void;
}

export interface AudioOut {
    push(frames: Buffer[]): void;
    end(): void;
}

export type Connect = (guildId: string, channelId: string, muted?: boolean) => Promise<VoiceLink>;

const decryptBurst = { count: 200, windowMs: 60_000 };

class DiscordLink implements VoiceLink {
    private closedListeners: ((reason: 'closed' | 'decrypt') => void)[] = [];
    private failures: number[] = [];
    private closed = false;

    constructor(
        private readonly connection: VoiceConnection,
        private readonly player: AudioPlayer,
        readonly channelId: string,
        public muted: boolean,
    ) {
        connection.on('stateChange', (_old, state) => {
            if (state.status === VoiceConnectionStatus.Destroyed) this.close('closed');
            if (state.status === VoiceConnectionStatus.Disconnected) void this.recover();
        });
        connection.on('debug', (message: string) => {
            if (!message.startsWith('Failed to decrypt')) return;
            const now = Date.now();
            this.failures = [...this.failures.filter((at) => at > now - decryptBurst.windowMs), now];
            if (this.failures.length > decryptBurst.count) this.close('decrypt');
        });
        connection.on('error', () => undefined);
        player.on('error', () => undefined);
    }

    private async recover(): Promise<void> {
        try {
            await Promise.race([
                entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch {
            this.close('closed');
        }
    }

    private close(reason: 'closed' | 'decrypt'): void {
        if (this.closed) return;
        this.closed = true;
        this.destroy();
        for (const listener of this.closedListeners) listener(reason);
    }

    onSpeaking(listener: (userId: string) => void): void {
        this.connection.receiver.speaking.on('start', listener);
    }

    talking(): string[] {
        return [...this.connection.receiver.speaking.users.keys()];
    }

    setMuted(muted: boolean): void {
        if (this.connection.rejoin({ ...this.connection.joinConfig, selfMute: muted })) this.muted = muted;
    }

    listen(userId: string, silenceMs: number): AsyncIterable<Buffer> {
        const existing = this.connection.receiver.subscriptions.get(userId);
        if (existing) return Readable.from([]);
        return this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: silenceMs } });
    }

    get playing(): boolean {
        return this.player.state.status !== AudioPlayerStatus.Idle;
    }

    stream(): AudioOut {
        const frames = new PassThrough({ objectMode: true });
        this.player.play(createAudioResource(frames, { inputType: StreamType.Opus }));
        return {
            push: (packets) => {
                for (const packet of packets) frames.write(packet);
            },
            end: () => frames.end(),
        };
    }

    stop(): void {
        this.player.stop(true);
    }

    onClosed(listener: (reason: 'closed' | 'decrypt') => void): void {
        this.closedListeners.push(listener);
    }

    destroy(): void {
        this.player.stop(true);
        if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    }
}

export function discordConnect(client: Client): Connect {
    return async (guildId, channelId, muted = false) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) throw new Error('The bot is not in that server');
        const connection = joinVoiceChannel({
            guildId,
            channelId,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: muted,
            daveEncryption: true,
            decryptionFailureTolerance: 24,
            debug: true,
        });
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        } catch {
            connection.destroy();
            throw new Error('Could not connect to the voice channel');
        }
        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        connection.subscribe(player);
        return new DiscordLink(connection, player, channelId, muted);
    };
}
