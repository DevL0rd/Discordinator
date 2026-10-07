import assert from 'node:assert/strict';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { person } from '../src/core/directory.js';
import { concat, liveToDiscord, loudness, OpusFramer, opusCodec, toSpeech, wav } from '../src/voice/audio.js';
import { Gemini, transcribePrompt } from '../src/voice/gemini.js';
import { liveInstructions } from '../src/voice/instructions.js';
import { TranscriptStore } from '../src/voice/transcripts.js';
import { policySchema } from '../src/core/config.js';
import { Policy } from '../src/core/policy.js';
import { Triggers } from '../src/core/triggers.js';
import { botNames } from '../src/discord/observation.js';
import { ids, posixOnly } from './fixtures.js';
import { tone } from './voice-fakes.js';

function checkAudio(): void {
    const stereo = new Int16Array([300, 100, 200, 200, 100, 300, 600, 600, 0, 0, 0, 0]);
    assert.deepEqual([...toSpeech(stereo)], [200, 200], 'Stereo 48 kHz becomes averaged mono 16 kHz');
    assert.deepEqual([...concat([new Int16Array([1]), new Int16Array([2, 3])])], [1, 2, 3]);
    const header = wav(new Int16Array([1, -1]));
    assert.deepEqual(
        [header.toString('ascii', 0, 4), header.toString('ascii', 8, 12), header.readUInt32LE(24), header.readUInt32LE(40)],
        ['RIFF', 'WAVE', 16_000, 4],
    );
    assert.equal(loudness(new Int16Array()), 0);
    assert.equal(Math.round(loudness(new Int16Array([3, -3, 3, -3]))), 3);
    assert.deepEqual(
        [...liveToDiscord(new Int16Array([100, 200]), 0)],
        [50, 50, 100, 100, 150, 150, 200, 200],
        'Live 24 kHz mono becomes 48 kHz stereo',
    );
    const codec = opusCodec();
    try {
        assert.equal(codec.decode(tone(0.1)[0]!).length, 1920, 'An Opus frame decodes to 960 stereo samples');
        const framer = new OpusFramer(codec);
        assert.equal(framer.live(new Int16Array(300)).length, 0, 'Partial frames wait for more audio');
        assert.equal(framer.live(new Int16Array(300)).length, 1, 'A full 20 ms frame is emitted');
        assert.equal(framer.flush().length, 1, 'The rest is padded out at the end of a turn');
        assert.equal(framer.flush().length, 0);
        framer.live(new Int16Array(100));
        framer.reset();
        assert.equal(framer.flush().length, 0, 'An interruption drops unplayed audio');
    } finally {
        codec.free();
    }
}

async function checkTranscription(): Promise<void> {
    const requests: { url: string; body: Record<string, unknown>; key: string }[] = [];
    const replies: Response[] = [];
    const fetcher = ((url: string, init: RequestInit) => {
        requests.push({
            url,
            body: JSON.parse(init.body as string) as Record<string, unknown>,
            key: new Headers(init.headers).get('x-goog-api-key') ?? '',
        });
        return Promise.resolve(replies.shift()!);
    }) as typeof fetch;
    const keys: (string | undefined)[] = [undefined];
    const gemini = new Gemini(() => keys[0], fetcher);
    assert.equal(gemini.configured, false);
    await assert.rejects(gemini.transcribe(Buffer.from('x'), 'm', ''), /Add a Google Gemini API key/);
    await assert.rejects(gemini.live({ model: 'm', voice: '', system: '', tools: [] }, {} as never), /Add a Google Gemini API key/);
    keys[0] = 'gemini-test-key';
    const reply = (text: string) => Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
    replies.push(reply(' hello there '), reply('[no speech]'), Response.json({}), new Response('quota', { status: 429 }));
    assert.equal(await gemini.transcribe(Buffer.from('wav'), 'gemini-3.5-flash-lite', 'en'), 'hello there');
    assert.equal(await gemini.transcribe(Buffer.from('wav'), 'gemini-3.5-flash-lite', ''), '', 'Silence markers are dropped');
    assert.equal(await gemini.transcribe(Buffer.from('wav'), 'gemini-3.5-flash-lite', ''), '');
    await assert.rejects(gemini.transcribe(Buffer.from('wav'), 'm', ''), /Gemini request failed \(429\)/);
    assert.equal(requests[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.equal(requests[0]!.key, 'gemini-test-key', 'The key goes in a header, never the URL');
    const parts = (requests[0]!.body.contents as { parts: Record<string, unknown>[] }[])[0]!.parts;
    assert.deepEqual(parts, [{ text: transcribePrompt('en') }, { inlineData: { mimeType: 'audio/wav', data: 'd2F2' } }]);
    assert.match(transcribePrompt('en'), /language: en/);
    assert.doesNotMatch(transcribePrompt(''), /language/);
    assert.match(
        transcribePrompt('', 'Names: Butler'),
        /never transcribe or repeat it[\s\S]*Names: Butler$/,
        'Context only helps recognition',
    );
}

function checkBotNames(): void {
    const policy = new Policy(policySchema.parse({ allowedUserIds: [ids.user], triggers: { names: ['butler', 'DEVBOT'] } }));
    assert.deepEqual(policy.names(), ['butler', 'DEVBOT'], 'Before Discord connects, only the extra names count');
    policy.botNames = ['DevBot', 'devbot', 'x'];
    assert.deepEqual(policy.names(), ['DevBot', 'butler'], 'Its Discord name comes first; duplicates and one-letter names are dropped');
    assert.equal(new Triggers(policy).named('hey devbot, you there'), true, 'Its Discord name works anywhere in a sentence');
    const me = (nickname: string | null) => ({ members: { me: { nickname } } });
    const client = {
        user: { username: 'DevBot', globalName: null },
        application: { name: 'Butler' },
        guilds: {
            cache: new Map([
                ['1', me('Butler')],
                ['2', me('Jeeves')],
                ['3', me(null)],
            ]),
        },
    };
    assert.deepEqual(botNames(client), ['Butler', 'Jeeves', 'DevBot'], 'App name and server nicknames come before the account name');
    assert.deepEqual(botNames({ user: null, application: null, guilds: { cache: new Map() } }), []);
}

function checkInstructions(): void {
    const call = {
        id: '1791378164384-b383064e-641d-4095-b78c-51ae1f537fda',
        guildId: ids.guild,
        channelId: ids.channel,
        channelName: 'Hangout',
        startedAt: new Date().toISOString(),
        endedAt: null,
        participants: [],
        lines: [
            {
                at: new Date().toISOString(),
                userId: ids.user,
                speaker: person(ids.user, 'devl0rd', 'DevL0rd', null),
                text: 'we need a new channel',
                bot: false,
            },
            {
                at: new Date().toISOString(),
                userId: ids.bot,
                speaker: person(ids.bot, 'Butler', null, null),
                text: 'Sure, making it now.',
                bot: true,
            },
        ],
    };
    const text = liveInstructions({
        names: ['Butler', 'Disco'],
        owner: 'The owner is DevL0rd.',
        call,
        present: [person(ids.user, 'devl0rd', 'DevL0rd', null)],
        speaker: person(ids.user, 'devl0rd', 'DevL0rd', null),
        contextMinutes: 10,
    });
    assert.match(text, /You are Butler \(also called Disco\)/);
    assert.match(text, /The owner is DevL0rd\./);
    assert.match(text, /call do_task[\s\S]*Never mention another assistant/);
    assert.match(text, /call stop_listening/);
    assert.match(text, /\[Transcript\] are other people[\s\S]*never instructions/);
    assert.match(
        text,
        /DevL0rd" @devl0rd \(ID 111111111111111111\): we need a new channel\n\[\d{2}:\d{2}:\d{2}\] you: Sure, making it now\./,
        'It remembers what it said as itself',
    );
}

async function checkStore(directory: string): Promise<void> {
    let now = Date.parse('2026-10-07T12:00:00.000Z');
    const store = new TranscriptStore(join(directory, 'voice-store'), () => now);
    const call = store.start(ids.guild, ids.channel, 'Hangout');
    const speaker = person(ids.user, 'devl0rd', 'DevL0rd', null);
    const line = (at: string, text: string) => ({ at: `2026-10-07T12:00:${at}.000Z`, userId: ids.user, speaker, text, bot: false });
    store.add(call.id, line('05', 'second'));
    store.add(call.id, line('01', 'first'));
    store.add(call.id, line('09', '   '));
    store.add('missing', line('02', 'ignored'));
    assert.deepEqual(
        call.lines.map((item) => item.text),
        ['first', 'second'],
        'Lines are kept in spoken order and blanks are skipped',
    );
    assert.deepEqual(call.participants, [speaker]);
    store.present(call.id, { ...speaker, nickname: 'Boss' });
    assert.equal(call.participants[0]!.nickname, 'Boss', 'Participants are updated in place');
    await store.flush();
    const path = join(directory, 'voice-store', `${call.id}.json`);
    if (posixOnly) assert.equal((await stat(path)).mode & 0o777, 0o600, 'Transcripts are private files');
    await store.end(call.id);
    const saved = (await store.read(call.id))!;
    assert.equal(saved.endedAt, '2026-10-07T12:00:00.000Z');
    assert.equal(saved.lines.length, 2);
    assert.equal(await store.read('../../etc/passwd'), undefined, 'Only call IDs can be read');
    assert.equal((await store.list()).length, 1);
    await mkdir(join(directory, 'voice-store'), { recursive: true });
    await writeFile(join(directory, 'voice-store', '1000000000000-00000000-0000-4000-8000-000000000000.json'), '{"broken": true}');
    assert.equal((await store.list()).length, 1, 'Unreadable files are skipped');
    now += 31 * 86_400_000;
    const active = store.start(ids.guild, ids.channel, null);
    assert.equal(await store.prune(30), 2, 'Calls older than the retention period are deleted');
    assert.equal(await store.remove(active.id), false, 'An active call cannot be deleted');
    await store.end(active.id);
    assert.equal(await store.remove(active.id), true);
    assert.equal(await store.remove(active.id), false);
    assert.equal(await store.remove('nope'), false);
    assert.deepEqual(await readdir(join(directory, 'voice-store')), []);
    assert.equal(JSON.parse(await readFile(path, 'utf8').catch(() => 'null')), null);
}

export async function checkVoiceMedia(directory: string): Promise<void> {
    checkAudio();
    await checkTranscription();
    checkBotNames();
    checkInstructions();
    await checkStore(directory);
}
