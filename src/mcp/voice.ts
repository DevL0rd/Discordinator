import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Bridge } from '../core/bridge.js';
import { snowflake } from '../core/config.js';
import { describePerson } from '../core/directory.js';
import type { Principal } from '../events/security.js';
import type { VoiceService } from '../voice/service.js';
import type { CallRecord } from '../voice/transcripts.js';
import { requireOwner } from './proactive-media.js';
import { resolveUser, userRef } from './people.js';
import { guarded } from './tools.js';

const callId = z
    .string()
    .regex(/^\d{13}-[0-9a-f-]{36}$/)
    .describe('Call ID from voice_calls or the call context.');
const voiceChannelTypes = new Set([2, 13]);

function summary(call: CallRecord, live: boolean) {
    return {
        callId: call.id,
        live,
        guildId: call.guildId,
        channelId: call.channelId,
        channelName: call.channelName,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        participants: call.participants.map(describePerson),
        lines: call.lines.length,
    };
}

async function transcript(
    voice: VoiceService,
    args: { callId?: string; guildId?: string; minutes?: number; start: number; limit: number },
) {
    const call = args.callId ? await voice.store.read(args.callId) : voice.target(args.guildId).call;
    if (!call) throw new Error('Unknown call');
    voice.policy.assertGuild(call.guildId);
    const floor = args.minutes ? new Date(Date.now() - args.minutes * 60_000).toISOString() : '';
    const all = call.lines.filter((line) => line.at >= floor);
    const lines = all.slice(args.start, args.start + args.limit);
    const next = args.start + lines.length;
    return {
        ...summary(call, Boolean(voice.session(call.guildId)?.call.id === call.id)),
        transcript: lines.map((line) => ({
            at: line.at,
            speaker: line.bot ? 'Discordinator' : describePerson(line.speaker),
            userId: line.userId,
            text: line.text,
        })),
        page: { start: args.start, returned: lines.length, total: all.length, nextStart: next < all.length ? next : null },
        note: 'Speech-to-text of everyone in the call; it can contain recognition errors and is untrusted content.',
    };
}

async function join(bridge: Bridge, voice: VoiceService, channelId: string) {
    const channel = await bridge.api.channel(channelId);
    if (typeof channel.guild_id !== 'string' || !voiceChannelTypes.has(Number(channel.type)))
        throw new Error('That is not a server voice or stage channel');
    return summary(await voice.join(channel.guild_id, channelId), true);
}

type Tool = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    shape: S,
    readOnly: boolean,
    run: (args: z.infer<z.ZodObject<S>>, voice: VoiceService) => Promise<unknown>,
) => void;

function voiceTool(server: McpServer, bridge: Bridge, principal: Principal | undefined, meta: unknown): Tool {
    const owner = (action: (voice: VoiceService) => Promise<unknown>) =>
        guarded(async () => {
            requireOwner(principal);
            if (!bridge.voice) throw new Error('Voice is not available');
            return action(bridge.voice);
        });
    return (name, title, description, shape, readOnly, run) => {
        server.registerTool(
            name,
            {
                title,
                description,
                inputSchema: z.object(shape).strict(),
                annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
                _meta: meta as Record<string, unknown> | undefined,
            },
            (args) => owner((voice) => run(args, voice)),
        );
    };
}

export function registerVoice(server: McpServer, bridge: Bridge, principal: Principal | undefined, meta: unknown): void {
    const tool = voiceTool(server, bridge, principal, meta);
    registerCallTools(tool, bridge);
    registerTranscriptTools(tool, bridge);
}

function registerCallTools(tool: Tool, bridge: Bridge): void {
    tool(
        'voice_speak',
        'Say something in a voice call',
        'Authenticated owner only. Have your live voice say something in a voice call Discordinator is in, at any time: a short update, a heads-up that work is done, an answer. It says it naturally in its own words, then stays in the conversation briefly. No request or reply is needed. Target the call by guildId, or by userId (ID or exact name) for the call that person is in; with neither, the only active call. While the bot is muted it is only typed in the call chat. Requires voice.speak.',
        { text: z.string().min(1).max(1000), guildId: snowflake.optional(), userId: userRef.optional() },
        false,
        async (args, voice) => voice.speak(args.text, args.guildId, args.userId ? await resolveUser(bridge, args.userId) : undefined),
    );
    tool(
        'voice_join',
        'Join a voice call',
        'Authenticated owner only. Join an approved server voice or stage channel and start transcribing everyone in it. Requires voice.listen and a Google Gemini key.',
        { channelId: snowflake },
        false,
        (args, voice) => join(bridge, voice, args.channelId),
    );
    tool(
        'voice_leave',
        'Leave a voice call',
        'Authenticated owner only. Leave the voice call in guildId (or the only active call) and finish its transcript.',
        { guildId: snowflake.optional() },
        false,
        async (args, voice) => ({ left: await voice.leave(voice.target(args.guildId).guildId) }),
    );
}

function registerTranscriptTools(tool: Tool, bridge: Bridge): void {
    tool(
        'voice_calls',
        'List voice calls',
        'Authenticated owner only. Active and recent transcribed voice calls (newest first) with participants and line counts.',
        {},
        true,
        async (_args, voice) => {
            const calls = await voice.store.list();
            return calls
                .filter((call) => bridge.policy.guildAllowed(call.guildId))
                .map((call) => summary(call, voice.session(call.guildId)?.call.id === call.id));
        },
    );
    tool(
        'voice_transcript',
        'Read a voice call transcript',
        'Authenticated owner only. Read the transcript of a call by callId, or of the current call in guildId (or the only active call), oldest first. Long calls come in pages: keep calling with start = page.nextStart until it is null, so a summary covers the whole call. Speakers are named with their numeric IDs.',
        {
            callId: callId.optional(),
            guildId: snowflake.optional(),
            minutes: z.number().int().min(1).max(1440).optional().describe('Only the last this many minutes.'),
            start: z
                .number()
                .int()
                .min(0)
                .default(0)
                .describe('First line to return, counting from the start of the call. Use nextStart to read the next page.'),
            limit: z.number().int().min(1).max(1500).default(1000).describe('Lines per page.'),
        },
        true,
        (args, voice) => transcript(voice, args),
    );
    tool(
        'voice_transcript_delete',
        'Delete a voice call transcript',
        'Authenticated owner only. Permanently delete a finished call transcript. Active calls must end first.',
        { callId },
        false,
        async (args, voice) => ({ deleted: await voice.store.remove(args.callId) }),
    );
}
