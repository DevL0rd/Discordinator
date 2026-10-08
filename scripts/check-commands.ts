import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextWarning, ThresholdMeter, usageWarning } from '../src/operator/context-meter.js';
import { UsageAnnouncer } from '../src/operator/usage-announcer.js';
import { codexUsage, contextPercent } from '../src/operator/codex-activity.js';
import { notification } from '../src/operator/codex-state.js';
import { builtInCommands, commandDefinitions, replyEmbed } from '../src/discord/commands.js';
import { CommandService } from '../src/operator/commands.js';
import type { OperatorService } from '../src/operator/service.js';
import { verifyLines } from '../src/operator/onboarding-verify.js';
import { serverState, withServerAllowed, withServerChannels } from '../src/operator/servers.js';
import { splitMessage } from '../src/operator/message-split.js';
import { inviteCopy, inviteLink, inviteReady, ownerFrom, ownerMatches } from '../src/operator/onboarding-invite.js';

function checkMeter(): void {
    const posted: string[] = [];
    const meter = new ThresholdMeter((_eventId: string, text: string) => {
        posted.push(text);
        return Promise.resolve();
    });
    meter.record('s', 30, 'e', contextWarning(30));
    meter.record('s', 40, undefined, contextWarning(40));
    meter.record('s', 55, 'e', contextWarning(55));
    meter.record('s', 60, 'e', contextWarning(60));
    meter.record('s', 76, 'e', contextWarning(76));
    meter.record('s', 91, 'e', contextWarning(91));
    meter.record('s', 95, 'e', contextWarning(95));
    assert.deepEqual(
        posted.map((text) => /(\d+)% full/.exec(text)?.[1]),
        ['30', '55', '76', '91'],
        'one warning each at 25%, 50%, 75% and 90%',
    );
    assert.match(posted[3]!, /91% full[\s\S]*\/compact/);
    meter.record('s', 60, 'e', contextWarning(60));
    meter.record('s', 80, 'e', contextWarning(80));
    assert.equal(posted.length, 5, 'warnings re-arm after the context shrinks');
    meter.record('s', 85, undefined, contextWarning(85));
    meter.record('s', 92, undefined, contextWarning(92));
    assert.equal(posted.length, 5, 'nothing is posted without a Discord request');
    assert.equal(meter.percent('s'), 92);
    meter.record('usage:Weekly limit', 52, 'e', usageWarning('Weekly limit', 52, '2030-01-01T00:00:00Z'));
    assert.match(posted.at(-1)!, /Weekly limit 52% used\.\*\* Resets <t:1893456000:R>/, 'plan usage warns with its reset time');
}

async function checkUsageAnnouncer(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'usage-'));
    const made: UsageAnnouncer[] = [];
    const settle = () => Promise.all(made.map((item) => item.flush()));
    try {
        const file = join(directory, 'usage.json');
        const posted: string[] = [];
        const announcer = () => {
            const created = new UsageAnnouncer((_eventId, text) => {
                posted.push(text);
                return Promise.resolve();
            }, file);
            made.push(created);
            return created;
        };
        const week = '2030-01-08T00:00:00Z';
        const first = announcer();
        const record = (target: UsageAnnouncer, percent: number, resetsAt = week) =>
            target.record('Weekly limit', percent, resetsAt, 'e', `${percent}%`);
        record(first, 10);
        record(first, 26);
        record(first, 30);
        record(first, 49);
        record(first, 51);
        record(first, 49);
        record(first, 52);
        record(first, 76);
        record(first, 96);
        record(first, 97);
        assert.deepEqual(posted, ['26%', '51%', '76%', '96%'], 'one announcement each at 25%, 50%, 75% and near empty');
        await settle();
        record(announcer(), 98);
        record(announcer(), 40, '2030-01-08T00:00:01Z');
        assert.equal(posted.length, 4, 'a restart or a jittering reset time does not repeat them');
        await settle();
        const next = announcer();
        record(next, 30, '2030-01-15T00:00:00Z');
        assert.deepEqual(posted.slice(4), ['30%'], 'announcements start again after the weekly reset');
        next.record('Weekly limit', 80, '2030-01-15T00:00:00Z', undefined, 'quiet');
        assert.equal(posted.length, 5, 'nothing is posted without a Discord request');
    } finally {
        await settle();
        await rm(directory, { recursive: true, force: true });
    }
}

function checkCodexUsageEvent(): void {
    const events: unknown[] = [];
    notification(
        { sessions: new Map() } as unknown as Parameters<typeof notification>[0],
        'account/rateLimits/updated',
        { rateLimits: { secondary: { usedPercent: 76.2, windowDurationMins: 10_080 } } },
        { emit: (event: unknown) => events.push(event) } as unknown as Parameters<typeof notification>[3],
    );
    assert.deepEqual(
        events,
        [{ type: 'usage', windows: [{ label: 'Weekly limit', usedPercent: 76 }] }],
        'Codex limit updates become usage events',
    );
}

function checkCodexParsing(): void {
    assert.equal(contextPercent({ modelContextWindow: 200_000, last: { totalTokens: 50_000 } }), 20, 'matches the Codex baseline');
    assert.equal(contextPercent({ modelContextWindow: 200_000, last: { totalTokens: 5_000 } }), 0, 'usage under the baseline is empty');
    assert.equal(contextPercent({ modelContextWindow: 272_000, last: { totalTokens: 200_000 } }), 72);
    assert.equal(contextPercent({ modelContextWindow: 200_000, last: { totalTokens: 400_000 } }), 100);
    assert.equal(
        contextPercent({ modelContextWindow: 12_000, last: { totalTokens: 1_000 } }),
        undefined,
        'windows within the baseline are unknown',
    );
    assert.equal(contextPercent({}), undefined);
    const windows = codexUsage({
        rateLimits: {
            primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 2_000_000_000 },
            secondary: { usedPercent: 70, windowDurationMins: 10_080 },
        },
    });
    assert.deepEqual(
        windows.map((window) => [window.label, window.usedPercent]),
        [
            ['5-hour limit', 12],
            ['Weekly limit', 70],
        ],
    );
}

async function checkCommands(): Promise<void> {
    assert.equal(builtInCommands.size, commandDefinitions.length, 'command names are unique');
    for (const definition of commandDefinitions) assert.ok(/^[a-z]{1,32}$/.test(definition.name) && definition.description.length <= 100);
    assert.equal(replyEmbed({ title: 'T', lines: ['a', 'b'], tone: 'warn' }).description, 'a\nb');
    const desktop = {
        responder: () => ({ mode: 'claude-session', router: {}, controller: undefined, sessionId: 'x' }),
    } as unknown as OperatorService;
    const service = new CommandService(desktop);
    await assert.rejects(service.run('compact', {}), /Claude Desktop/, 'Desktop conversations explain where to compact');
    await assert.rejects(service.run('stop', {}), /Claude Desktop/);
    await assert.rejects(service.run('nope', {}), /Unknown command/);
    const working = new CommandService({
        responder: () => ({ mode: 'claude-session', router: { status: () => ({ busy: true }), live: {} }, sessionId: 'x' }),
    } as unknown as OperatorService);
    const status = await working.run('status', {});
    assert.match(status.lines[0]!, /working · live/, 'router status follows the live session');
    assert.match(status.lines.at(-1)!, /Claude Desktop/);
    const background = new CommandService({
        responder: () => ({ mode: 'claude-session', controller: { adapter: {}, stopAll: () => Promise.resolve(0) }, sessionId: 's' }),
    } as unknown as OperatorService);
    await assert.rejects(background.run('compact', {}), /not supported/, 'background Claude explains compaction is unsupported');
    assert.equal((await background.run('stop', {})).title, 'Nothing to stop');
}

function checkSplit(): void {
    assert.deepEqual(splitMessage(''), []);
    assert.deepEqual(splitMessage('short'), ['short']);
    const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index} ${'lorem '.repeat(20)}`.trim()).join('\n\n');
    const chunks = splitMessage(paragraphs, 500);
    assert.ok(chunks.length > 1 && chunks.every((chunk) => chunk.length <= 500 && chunk.startsWith('Paragraph')));
    assert.equal(chunks.join('\n\n'), paragraphs, 'paragraph splits drop only the separator');
    const words = 'alpha beta gamma delta '.repeat(40).trim();
    const wordChunks = splitMessage(words, 100);
    assert.ok(
        wordChunks.every((chunk) => chunk.length <= 100 && /^(alpha|beta|gamma|delta)\b[\s\S]*\b(alpha|beta|gamma|delta)$/.test(chunk)),
        'never splits mid-word when a space is available',
    );
    assert.equal(wordChunks.join(' '), words);
    const code = ['Intro', '```ts', ...Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`), '```', 'Outro'].join(
        '\n',
    );
    const fenced = splitMessage(code, 300);
    for (const chunk of fenced) {
        assert.ok(chunk.length <= 300);
        assert.equal((chunk.match(/```/g) ?? []).length % 2, 0, 'every chunk closes the code fences it opens');
    }
    assert.ok(fenced.length > 2 && fenced.slice(1).every((chunk) => chunk.startsWith('```ts\n')), 'code reopens with its language tag');
    assert.match(fenced.at(-1)!, /```\nOutro$/);
    assert.deepEqual(
        splitMessage('x'.repeat(250), 100).map((chunk) => chunk.length),
        [100, 100, 50],
    );
    assert.ok(
        splitMessage('😀'.repeat(60), 51).every((chunk) => !/^[\udc00-\udfff]/.test(chunk)),
        'surrogate pairs stay whole',
    );
}

function checkInvite(): void {
    const link = new URL(inviteLink('123456789012345678'));
    assert.equal(link.searchParams.get('permissions'), '8', 'the invite asks for Administrator');
    assert.equal(link.searchParams.get('scope'), 'bot applications.commands', 'the invite includes slash commands');
    const members = [
        { id: '300000000000000001', name: 'Dev (@devl0rd)' },
        { id: '300000000000000002', name: '@sam' },
    ];
    const base = { bot: 'b', botId: '1', channels: [], members, servers: ['Home'], intents: { messageContent: true, members: true } };
    assert.deepEqual(
        ownerMatches(base, 'dev').map((member) => member.id),
        ['300000000000000001'],
        'typing searches member names',
    );
    assert.equal(ownerFrom(base, 'sam', 0), '300000000000000002');
    assert.equal(ownerFrom(base, '123456789012345678', 0), '123456789012345678', 'a pasted ID is used as is');
    assert.throws(() => ownerFrom(base, 'nobody', 0), /Pick yourself/);
    assert.equal(inviteReady(base), true);
    assert.equal(inviteReady({ ...base, servers: [] }), false, 'the bot must be in a server');
    assert.equal(inviteReady({ ...base, intents: { messageContent: true, members: false } }), false, 'both intents are required');
    assert.ok(inviteCopy({ ...base, servers: [] }).body.some((line) => line.startsWith('○ The bot is in a server')));
}

function checkServers(): void {
    const server = {
        id: '100000000000000001',
        name: 'Home',
        members: [],
        roles: [],
        channels: [
            { id: '200000000000000001', name: 'general' },
            { id: '200000000000000002', name: 'random' },
        ],
    };
    const allowlist = {
        servers: { mode: 'allowlist', allowed: [], blocked: [] },
        channels: { mode: 'allowlist', allowed: [], blocked: [] },
    };
    assert.deepEqual(serverState(allowlist, server), { allowed: false, channels: [] });
    const on = withServerChannels(withServerAllowed(allowlist, server.id, true), server, ['200000000000000001']);
    assert.deepEqual(
        serverState(on, server),
        { allowed: true, channels: ['200000000000000001'] },
        'allowlists gain the chosen server and channels',
    );
    const open = { servers: { mode: 'blocklist', allowed: [], blocked: [] }, channels: { mode: 'blocklist', allowed: [], blocked: [] } };
    const trimmed = withServerChannels(open, server, ['200000000000000002']);
    assert.deepEqual(serverState(trimmed, server).channels, ['200000000000000002'], 'blocklists block the channels left unchosen');
    assert.equal(serverState(withServerAllowed(open, server.id, false), server).allowed, false, 'turning a server off blocks it');
}

function checkVerifyLines(): void {
    const lines = verifyLines([
        { label: 'Discordinator is running', ok: true, hint: 'start it' },
        { label: 'Automatic wake-ups are on', ok: false, hint: 'ask ChatGPT' },
    ]);
    assert.deepEqual(
        lines,
        ['✓ Discordinator is running', '○ Automatic wake-ups are on', 'Next: ask ChatGPT'],
        'the wizard names the first unmet step',
    );
    assert.match(verifyLines([{ label: 'x', ok: true, hint: '' }]).at(-1)!, /working/);
}

export async function checkSlashCommands(): Promise<void> {
    checkVerifyLines();
    checkInvite();
    checkServers();
    checkMeter();
    await checkUsageAnnouncer();
    checkCodexParsing();
    checkCodexUsageEvent();
    checkSplit();
    await checkCommands();
}
