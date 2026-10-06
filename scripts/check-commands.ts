import assert from 'node:assert/strict';
import { ContextMeter } from '../src/operator/context-meter.js';
import { codexUsage, contextPercent } from '../src/operator/codex-activity.js';
import { builtInCommands, commandDefinitions, replyEmbed } from '../src/discord/commands.js';
import { CommandService } from '../src/operator/commands.js';
import type { OperatorService } from '../src/operator/service.js';
import { verifyLines } from '../src/operator/onboarding-verify.js';
import { serverState, withServerAllowed, withServerChannels } from '../src/operator/servers.js';
import { splitMessage } from '../src/operator/message-split.js';
import { inviteCopy, inviteLink, inviteReady, ownerFrom, ownerMatches } from '../src/operator/onboarding-invite.js';

function checkMeter(): void {
    const posted: string[] = [];
    const meter = new ContextMeter((_eventId, text) => {
        posted.push(text);
        return Promise.resolve();
    });
    meter.record('s', 30, 'e');
    meter.record('s', 55, 'e');
    meter.record('s', 60, 'e');
    meter.record('s', 91, 'e');
    meter.record('s', 95, 'e');
    assert.equal(posted.length, 2, 'one warning at 50% and one at 90%');
    assert.match(posted[0]!, /55% full/);
    assert.match(posted[1]!, /91% full[\s\S]*\/compact/);
    meter.record('s', 10, 'e');
    meter.record('s', 52, 'e');
    assert.equal(posted.length, 3, 'warnings re-arm after the context shrinks');
    assert.equal(meter.percent('s'), 52);
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
    checkCodexParsing();
    checkSplit();
    await checkCommands();
}
