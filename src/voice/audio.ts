import { createRequire } from 'node:module';

const discordRate = 48_000;
export const speechRate = 16_000;
const frameSamples = 960;
const channels = 2;
const audioApplication = 2049;
const maxPacketBytes = 1276 * 3;
const maxPcmBytes = 2880 * channels * 2;

export interface OpusCodec {
    decode(packet: Buffer): Int16Array;
    encode(pcm: Int16Array): Buffer;
    free(): void;
}

interface OpusHandler {
    _encode(input: number, bytes: number, output: number, frameSize: number): number;
    _decode(input: number, bytes: number, output: number): number;
}

interface OpusNative {
    HEAPU8: Uint8Array;
    HEAPU16: Uint16Array;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
    OpusScriptHandler: {
        new (rate: number, channels: number, application: number): OpusHandler;
        destroy_handler(handler: OpusHandler): void;
    };
}

let native: OpusNative | undefined;

function opusNative(): OpusNative {
    native ??= (createRequire(import.meta.url)('opusscript/build/opusscript_native_wasm.js') as () => OpusNative)();
    return native;
}

function opusResult(result: number, action: string): number {
    if (result < 0) throw new Error(`Opus ${action} failed (${result})`);
    return result;
}

export function opusCodec(): OpusCodec {
    const opus = opusNative();
    const handler = new opus.OpusScriptHandler(discordRate, channels, audioApplication);
    const pointers = [opus._malloc(maxPcmBytes * 2), opus._malloc(maxPacketBytes)];
    const [pcmPointer, packetPointer] = pointers as [number, number];
    const pcmSlot = pcmPointer / 2;
    let freed = false;
    const live = (): void => {
        if (freed) throw new Error('Opus codec was already freed');
    };
    return {
        decode: (packet) => {
            live();
            if (packet.length > maxPacketBytes) throw new Error('Opus packet is too large');
            opus.HEAPU8.set(packet, packetPointer);
            const bytes = opusResult(handler._decode(packetPointer, packet.length, pcmPointer), 'decode') * channels * 2;
            return new Int16Array(Uint8Array.from(opus.HEAPU16.subarray(pcmSlot, pcmSlot + bytes)).buffer);
        },
        encode: (pcm) => {
            live();
            if (pcm.byteLength > maxPcmBytes) throw new Error('Opus frame is too large');
            opus.HEAPU16.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), pcmSlot);
            const length = opusResult(handler._encode(pcmPointer, pcm.byteLength, packetPointer, frameSamples), 'encode');
            return Buffer.from(opus.HEAPU8.slice(packetPointer, packetPointer + length));
        },
        free: () => {
            if (freed) return;
            freed = true;
            opus.OpusScriptHandler.destroy_handler(handler);
            for (const pointer of pointers) opus._free(pointer);
        },
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
