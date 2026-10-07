import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Events, type Client } from 'discord.js';
import { person } from '../src/core/directory.js';
import { CommandService } from '../src/operator/commands.js';
import type { OperatorService } from '../src/operator/service.js';
import { pageItems } from '../src/operator/ui/pages/index.js';
import { viewOf } from '../src/operator/ui/state.js';
import { discordGuilds } from '../src/voice/guilds.js';
import type { VoiceService } from '../src/voice/service.js';
import { localServer } from './check-channel.js';
import { caller } from './check-mcp-tools.js';
import { gatewayHarness, until } from './discord-fakes.js';
import { ids } from './fixtures.js';
import { uiStore } from './ui-fixtures.js';
import { stranger, tone, voiceChannel, voiceHarness } from './voice-fakes.js';

type Summary = { callId: string; live: boolean; lines: number; participants: string[] };

async function checkPaging(call: ReturnType<typeof caller>): Promise<void> {
    const paged = (await call('voice_transcript', { guildId: ids.guild, start: 0, limit: 1 })).value<{
        transcript: unknown[];
        page: { start: number; returned: number; total: number; nextStart: number | null };
    }>();
    assert.deepEqual([paged.transcript.length, paged.page.returned, paged.page.nextStart], [1, 1, 1], 'Long calls are read in pages');
    const last = (await call('voice_transcript', { guildId: ids.guild, start: paged.page.total - 1, limit: 5 })).value<{
        page: { nextStart: number | null };
    }>();
    assert.equal(last.page.nextStart, null, 'The last page says there is nothing more');
}

async function checkTools(directory: string): Promise<void> {
    const server = await localServer(join(directory, 'voice-tools.json'));
    const h = voiceHarness(directory, 'voice-tools', server.f);
    const call = caller(server.base);
    try {
        h.bridge.people.learn(person(ids.user, 'devl0rd', 'DevL0rd', null), null);
        h.guilds.seats.set(ids.user, voiceChannel);
        const notVoice = await call('voice_join', { channelId: voiceChannel });
        assert.deepEqual([notVoice.failed, notVoice.text], [true, 'That is not a server voice or stage channel']);
        h.api.channel = (id: string) => Promise.resolve({ id, guild_id: ids.guild, type: 2 });
        const joined = (await call('voice_join', { channelId: voiceChannel })).value<Summary>();
        assert.equal(joined.live, true);
        h.providers.heard.push('first words');
        h.link().talk(ids.user, tone(1));
        await until(() => h.voice.session(ids.guild)!.call.lines.length === 1, 'speech is transcribed');
        const spoken = await call('voice_speak', { text: 'Your build is done.', userId: 'DevL0rd' });
        assert.equal(spoken.failed, false, spoken.text);
        assert.match(h.providers.session.texts[0]!.text, /Your build is done\./, 'voice_speak works by name, with no request to reply to');
        h.providers.session.reply('Your build is done.');
        await until(() => h.voice.session(ids.guild)!.call.lines.length === 2, 'the spoken line is transcribed');
        const transcript = (await call('voice_transcript', { guildId: ids.guild, minutes: 60 })).value<{
            transcript: { speaker: string; userId: string; text: string }[];
        }>();
        assert.deepEqual(
            { ...transcript.transcript[0] },
            { ...transcript.transcript[0], speaker: `"DevL0rd" @devl0rd (ID ${ids.user})`, userId: ids.user, text: 'first words' },
        );
        await checkPaging(call);
        const listed = (await call('voice_calls', {})).value<Summary[]>();
        assert.deepEqual([listed.length, listed[0]!.live], [1, true]);
        assert.equal((await call('voice_leave', {})).value<{ left: boolean }>().left, true);
        const finished = (await call('voice_transcript', { callId: joined.callId })).value<Summary>();
        assert.deepEqual([finished.live, finished.lines >= 2], [false, true], 'Finished calls stay readable');
        assert.equal(
            (await call('voice_transcript', { callId: '1000000000000-00000000-0000-4000-8000-000000000000' })).text,
            'Unknown call',
        );
        assert.equal((await call('voice_transcript_delete', { callId: joined.callId })).value<{ deleted: boolean }>().deleted, true);
        assert.match((await call('voice_speak', { text: 'hello' })).text, /not in a call/);
        h.bridge.voice = undefined;
        assert.equal((await call('voice_calls', {})).text, 'Voice is not available');
    } finally {
        await server.http.stop();
    }
}

async function checkCommands(directory: string): Promise<void> {
    const h = voiceHarness(directory, 'voice-commands');
    const commands = new CommandService({ bridge: h.bridge } as unknown as OperatorService);
    const origin = { guildId: ids.guild, channelId: ids.channel, actorId: ids.user };
    await assert.rejects(commands.run('join', {}, origin), /Join a voice channel in this server first/);
    h.guilds.seats.set(ids.user, voiceChannel);
    assert.equal((await commands.run('join', {}, origin)).title, 'Joined the call');
    assert.equal((await commands.run('leave', {}, origin)).title, 'Left the call');
    assert.equal((await commands.run('leave', {}, origin)).title, 'Not in a call');
    await assert.rejects(commands.run('join', {}, { ...origin, guildId: null }), /Join a voice channel/);
}

async function checkGatewayWiring(directory: string): Promise<void> {
    const seen: unknown[][] = [];
    let attached = 0;
    const voice = {
        attach: () => attached++,
        stateChanged: (...args: unknown[]) => {
            seen.push(args);
            return Promise.resolve();
        },
        ready: () => Promise.resolve(),
    } as unknown as VoiceService;
    const h = gatewayHarness(join(directory, 'voice-gateway.json'), { voice });
    assert.equal(attached, 1, 'The gateway hands its Discord client to voice');
    h.gateway.client.emit(
        Events.VoiceStateUpdate,
        { channelId: null } as never,
        { guild: { id: ids.guild }, id: ids.user, channelId: voiceChannel } as never,
    );
    await until(() => seen.length === 1, 'voice state changes reach the voice service');
    assert.deepEqual(seen[0], [ids.guild, ids.user, null, voiceChannel]);
}

function checkGuildAdapter(): void {
    const state = (id: string, channelId: string | null) => [id, { id, channelId }] as const;
    const user: { id: string; username: string; globalName: string | null; bot: boolean } = {
        id: ids.user,
        username: 'devl0rd',
        globalName: 'DevL0rd',
        bot: false,
    };
    const guild = {
        id: ids.guild,
        voiceStates: { cache: new Map([state(ids.user, voiceChannel), state(ids.bot, voiceChannel), state(stranger, null)]) },
        members: { cache: new Map([[ids.user, { user, nickname: 'Boss' }]]), me: { voice: { serverMute: true } } },
    };
    const client = {
        user: { id: ids.bot, username: 'Discordinator', globalName: null },
        guilds: { cache: new Map([[ids.guild, guild]]) },
        channels: { cache: new Map([[voiceChannel, { name: 'Hangout' }]]) },
        users: {
            cache: new Map([
                [ids.user, user],
                [stranger, { ...user, id: stranger, username: 'bot', globalName: null, bot: true }],
            ]),
        },
    } as unknown as Client;
    const guilds = discordGuilds(client);
    assert.deepEqual(guilds.occupants(ids.guild, voiceChannel), [ids.user], 'The bot itself is not an occupant');
    assert.equal(guilds.channelOf(ids.guild, ids.user), voiceChannel);
    assert.equal(guilds.channelOf(ids.other, ids.user), null);
    assert.deepEqual([guilds.channelName(voiceChannel), guilds.channelName(ids.other)], ['Hangout', null]);
    assert.deepEqual([guilds.isBot(stranger), guilds.isBot(ids.user), guilds.isBot(ids.other)], [true, false, false]);
    assert.deepEqual(guilds.person(ids.guild, ids.user), person(ids.user, 'devl0rd', 'DevL0rd', 'Boss'));
    assert.deepEqual(guilds.person(ids.guild, ids.other), person(ids.other));
    assert.equal(guilds.self().username, 'Discordinator');
    assert.deepEqual([guilds.serverMuted(ids.guild), guilds.serverMuted(ids.other)], [true, false], 'A server mute is noticed');
    assert.deepEqual(guilds.states(), [{ guildId: ids.guild, userId: ids.user, channelId: voiceChannel }]);
}

function checkVoicePage(): void {
    const base = uiStore().state;
    const render = (policy: Record<string, unknown>, environment: Record<string, unknown> = {}) => {
        const state = {
            ...base,
            drafts: {
                ...base.drafts,
                policy: { ...base.drafts.policy, ...policy },
                environment: { ...base.drafts.environment, ...environment },
            },
        };
        const view = viewOf(state);
        return pageItems('voice', view)
            .flatMap((item) => item.lines(300, false, view))
            .map((row) => row.spans.map((item) => item.text).join(''))
            .join('\n');
    };
    const off = render({});
    for (const label of [
        'Use voice calls',
        'Google Gemini API key',
        'Who is transcribed',
        'Keep transcripts (days)',
        'Live voice model',
        'Stop talking after (seconds)',
    ])
        assert.ok(off.includes(label), `The voice page shows ${label}`);
    assert.match(off, /Needs a Google Gemini key/, 'Voice is on by default and only waits for a key');
    assert.match(render({ voice: { enabled: false } }), /Voice\s+○ Off/);
    const keyed = { GEMINI_API_KEY: 'gemini-fixture' };
    assert.match(render({ voice: { enabled: true }, scopes: [] }, keyed), /Needs the voice.listen ability/);
    assert.match(render({ voice: { enabled: true }, scopes: ['voice.listen'] }, keyed), /Transcribing only/);
    assert.match(render({ voice: { enabled: true }, scopes: ['voice.listen', 'voice.speak'] }, keyed), /Ready/);
    assert.match(render({}, keyed), /Ready/, 'With a key, voice works out of the box');
}

export async function checkVoiceTools(directory: string): Promise<void> {
    await checkTools(directory);
    await checkCommands(directory);
    await checkGatewayWiring(directory);
    checkGuildAdapter();
    checkVoicePage();
}
