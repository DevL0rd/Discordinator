import { createRequire } from 'node:module';

// opusscript's native side passes PCM as one byte per 16-bit slot. Its JavaScript wrapper (0.1.1) mallocs N
// bytes for those slots but views them as HEAPU16.subarray(pointer, pointer + N): that starts at byte
// 2 × pointer, outside the allocation, and spans 2N bytes. With several codecs alive at once (one per
// speaker plus the live voice) libopus then overwrites another codec's state until it hits an assertion and
// aborts, which kills the shared WebAssembly module and every call with it. This drives the same compiled
// libopus with slots that sit inside their own allocation, reads heap views fresh on each call (the heap can
// grow), and loads a fresh module once the current one has aborted.

interface Handler {
    _encode(input: number, bytes: number, output: number, frameSize: number): number;
    _decode(input: number, bytes: number, output: number): number;
}
interface NativeOpus {
    OpusScriptHandler: { new (rate: number, channels: number, application: number): Handler; destroy_handler(handler: Handler): void };
    HEAPU8: Uint8Array;
    HEAPU16: Uint16Array;
    _malloc(bytes: number): number;
    _free(pointer: number): void;
}

const require = createRequire(import.meta.url);
const application = 2049; // OPUS_APPLICATION_AUDIO
const maxFrameSamples = 2880; // 60 ms at 48 kHz, the most libopus is asked to decode at once
const maxPacketBytes = 1276 * 3;

let native: NativeOpus | undefined;
const dead = new WeakSet<NativeOpus>();
const load = (): NativeOpus => (native ??= (require('opusscript/build/opusscript_native_wasm.js') as () => NativeOpus)());

const aborted = (error: unknown) => error instanceof WebAssembly.RuntimeError;

export class Opus {
    private readonly module = load();
    private readonly handler: Handler;
    private readonly pcmBytes: number;
    private readonly pcm: number;
    private readonly packet: number;
    private freed = false;

    constructor(
        readonly rate: number,
        readonly channels: number,
    ) {
        this.handler = new this.module.OpusScriptHandler(rate, channels, application);
        this.pcmBytes = maxFrameSamples * channels * 2;
        this.pcm = this.module._malloc(this.pcmBytes * 2); // one 16-bit slot per PCM byte
        this.packet = this.module._malloc(maxPacketBytes);
    }

    /** True once this codec's module has aborted; make a new codec to keep going. */
    get stale(): boolean {
        return dead.has(this.module);
    }

    decode(packet: Uint8Array): Int16Array {
        if (packet.length > maxPacketBytes) throw new Error('Decode error: Packet too large');
        return this.guard(() => {
            this.module.HEAPU8.set(packet, this.packet);
            const samples = this.handler._decode(this.packet, packet.length, this.pcm);
            if (samples < 0) throw new Error(`Decode error: ${samples}`);
            const slots = this.slots(samples * this.channels * 2);
            return new Int16Array(Uint8Array.from(slots).buffer);
        });
    }

    encode(pcm: Int16Array, frameSize: number): Buffer {
        if (pcm.byteLength > this.pcmBytes || frameSize * this.channels > pcm.length) throw new Error('Encode error: Bad frame');
        return this.guard(() => {
            this.slots(pcm.byteLength).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
            const bytes = this.handler._encode(this.pcm, pcm.byteLength, this.packet, frameSize);
            if (bytes < 0) throw new Error(`Encode error: ${bytes}`);
            return Buffer.from(this.module.HEAPU8.slice(this.packet, this.packet + bytes));
        });
    }

    free(): void {
        if (this.freed) return;
        this.freed = true;
        if (this.stale) return; // An aborted module is dropped whole.
        this.module.OpusScriptHandler.destroy_handler(this.handler);
        this.module._free(this.pcm);
        this.module._free(this.packet);
    }

    private slots(bytes: number): Uint16Array {
        const start = this.pcm / 2; // malloc aligns to 8 bytes, so this is a whole slot index
        return this.module.HEAPU16.subarray(start, start + bytes);
    }

    private guard<T>(work: () => T): T {
        if (this.freed) throw new Error('Opus codec used after free');
        try {
            return work();
        } catch (error) {
            // An abort leaves the module unusable; codecs made from now on get a fresh one.
            if (aborted(error)) {
                dead.add(this.module);
                if (native === this.module) native = undefined;
            }
            throw error;
        }
    }
}
