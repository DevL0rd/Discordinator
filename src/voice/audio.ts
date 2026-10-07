import { Opus } from './opus.js';

const discordRate = 48_000;
export const speechRate = 16_000;
const frameSamples = 960;

export interface OpusCodec {
    decode(packet: Buffer): Int16Array;
    encode(pcm: Int16Array): Buffer;
    free(): void;
}

export function opusCodec(): OpusCodec {
    let codec = new Opus(discordRate, 2);
    // A codec whose shared module aborted is replaced, so one bad moment cannot silence the call for good.
    const live = () => {
        if (codec.stale) codec = new Opus(discordRate, 2);
        return codec;
    };
    return {
        decode: (packet) => live().decode(packet),
        encode: (pcm) => live().encode(pcm, frameSamples),
        free: () => codec.free(),
    };
}

export function concat(chunks: Int16Array[]): Int16Array {
    const out = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** 48 kHz interleaved stereo to 16 kHz mono: average channels, then average each group of three samples. */
export function toSpeech(stereo: Int16Array): Int16Array {
    const frames = Math.floor(stereo.length / 2);
    const out = new Int16Array(Math.floor(frames / 3));
    for (let index = 0; index < out.length; index++) {
        let sum = 0;
        for (let step = 0; step < 3; step++) {
            const frame = (index * 3 + step) * 2;
            sum += stereo[frame]! + stereo[frame + 1]!;
        }
        out[index] = Math.round(sum / 6);
    }
    return out;
}

export function wav(pcm: Int16Array, rate = speechRate): Buffer {
    const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

export function loudness(pcm: Int16Array): number {
    if (!pcm.length) return 0;
    let sum = 0;
    for (const sample of pcm) sum += sample * sample;
    return Math.sqrt(sum / pcm.length);
}

/** Gemini Live's 24 kHz mono to Discord's 48 kHz interleaved stereo, by linear interpolation. */
export function liveToDiscord(pcm: Int16Array, previous = 0): Int16Array {
    const out = new Int16Array(pcm.length * 4);
    let last = previous;
    for (let index = 0; index < pcm.length; index++) {
        const sample = pcm[index]!;
        const middle = Math.round((last + sample) / 2);
        out.set([middle, middle, sample, sample], index * 4);
        last = sample;
    }
    return out;
}

/** Turns streamed 48 kHz stereo PCM into 20 ms Opus frames, carrying partial frames over. */
export class OpusFramer {
    private pending = new Int16Array(0);
    private last = 0;

    constructor(private readonly codec: OpusCodec) {}

    live(pcm: Int16Array): Buffer[] {
        const stereo = liveToDiscord(pcm, this.last);
        this.last = pcm.at(-1) ?? this.last;
        const joined = concat([this.pending, stereo]);
        const whole = joined.length - (joined.length % (frameSamples * 2));
        this.pending = joined.slice(whole);
        return whole ? opusFrames(joined.subarray(0, whole), this.codec) : [];
    }

    flush(): Buffer[] {
        const rest = this.pending;
        this.pending = new Int16Array(0);
        this.last = 0;
        return rest.length ? opusFrames(rest, this.codec) : [];
    }

    reset(): void {
        this.pending = new Int16Array(0);
        this.last = 0;
    }
}

export function opusFrames(pcm: Int16Array, codec: OpusCodec): Buffer[] {
    const step = frameSamples * 2;
    const frames: Buffer[] = [];
    for (let offset = 0; offset < pcm.length; offset += step) {
        const frame = new Int16Array(step);
        frame.set(pcm.subarray(offset, offset + step));
        frames.push(codec.encode(frame));
    }
    return frames;
}
