import assert from 'node:assert/strict';
import { opusCodec } from '../src/voice/audio.js';
import { Opus } from '../src/voice/opus.js';

const frameSamples = 960;
const tone = (frame: number) => {
    const pcm = new Int16Array(frameSamples * 2);
    for (let index = 0; index < frameSamples; index++) {
        const value = Math.round(Math.sin(((frame * frameSamples + index) / 48_000) * 2 * Math.PI * 440) * 10_000);
        pcm[index * 2] = value;
        pcm[index * 2 + 1] = value;
    }
    return pcm;
};

function checkRoundTrip(): void {
    const encoder = new Opus(48_000, 2);
    const decoder = new Opus(48_000, 2);
    let out: Int16Array = new Int16Array(0);
    for (let frame = 0; frame < 30; frame++) out = decoder.decode(encoder.encode(tone(frame), frameSamples));
    const rms = Math.sqrt(out.reduce((sum, sample) => sum + sample * sample, 0) / out.length);
    assert.equal(out.length, frameSamples * 2, 'a 20 ms stereo frame decodes to 1920 samples');
    assert.ok(rms > 6000 && rms < 8000, `the tone survives a round trip (rms ${rms.toFixed(0)}, about 7071 expected)`);
    encoder.free();
    decoder.free();
}

/** opusscript 0.1.1 wrote decoded audio outside its buffers, so side-by-side codecs corrupted each other and libopus aborted. */
function checkIsolation(): void {
    const encoder = new Opus(48_000, 2);
    const packets = Array.from({ length: 20 }, (_, frame) => encoder.encode(tone(frame), frameSamples));
    const reference = new Opus(48_000, 2);
    const speakers = Array.from({ length: 8 }, () => new Opus(48_000, 2));
    for (let round = 0; round < 25; round++)
        for (const packet of packets) {
            const expected = Buffer.from(reference.decode(packet).buffer);
            for (const speaker of speakers)
                assert.deepEqual(Buffer.from(speaker.decode(packet).buffer), expected, 'codecs never disturb each other');
        }
    for (const codec of [encoder, reference, ...speakers]) codec.free();
}

function checkRecovery(): void {
    const packet = new Opus(48_000, 2).encode(tone(0), frameSamples);
    const survivor = opusCodec();
    const victim = new Opus(48_000, 2);
    (victim as unknown as { handler: { _decode: () => never } }).handler._decode = () => {
        throw new WebAssembly.RuntimeError('Aborted()');
    };
    assert.throws(() => victim.decode(packet), WebAssembly.RuntimeError);
    assert.ok(victim.stale, 'an abort marks the module dead');
    assert.equal(survivor.decode(packet).length, frameSamples * 2, 'an existing codec moves to a fresh module and keeps working');
    assert.throws(() => survivor.decode(Buffer.alloc(5000)), /Packet too large/, 'oversized packets are refused before reaching libopus');
    victim.free();
    survivor.free();
    assert.throws(() => victim.decode(packet), /used after free/);
}

export function checkVoiceOpus(): void {
    checkRoundTrip();
    checkIsolation();
    checkRecovery();
}
