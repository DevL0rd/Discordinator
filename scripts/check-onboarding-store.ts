import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverDiscord, onboardingPhase, saveAi, validateAi, verifyDiscord } from '../src/operator/onboarding-store.js';
import { probeConnection } from '../src/operator/onboarding-connection.js';
import { verifyChecks } from '../src/operator/onboarding-verify.js';
import { discordRoutes, fake, inScratch, withDiscord, type DiscordRoutes } from './onboarding-fakes.js';

type Output = { stdout: string; stderr: string };
type Call = { command: string; args: string[]; timeout: number };

async function withPath<T>(directory: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.PATH;
    process.env.PATH = resolve(directory);
    try {
        return await run();
    } finally {
        process.env.PATH = previous;
    }
}

async function fakePrograms(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    for (const name of ['codex', 'claude'])
        for (const extension of ['', '.exe']) await writeFile(join(directory, `${name}${extension}`), '', { mode: 0o755 });
}

function runner(calls: Call[], output: Output) {
    return (command: string, args: string[], options: { timeout: number }) => {
        calls.push({ command, args, timeout: options.timeout });
        return Promise.resolve(output);
    };
}

async function checkCliSignIn(): Promise<void> {
    await fakePrograms('bin');
    const calls: Call[] = [];
    const validate = (choice: 'codex-local' | 'claude-session', stdout: string, stderr = '') =>
        withPath('bin', () => validateAi(choice, '', {}, runner(calls, { stdout, stderr })));
    assert.equal(await validate('codex-local', 'Logged in using ChatGPT'), 'Codex CLI reported authenticated.');
    assert.equal(await validate('codex-local', '', 'Logged in using an API key'), 'Codex CLI reported authenticated.', 'stderr counts too');
    await assert.rejects(validate('codex-local', 'Not logged in'), /codex is unavailable or not authenticated/);
    assert.equal(await validate('claude-session', '{"loggedIn":true}'), 'Claude Code is installed and signed in.');
    assert.equal(await validate('claude-session', '{"authenticated":true}'), 'Claude Code is installed and signed in.');
    await assert.rejects(validate('claude-session', '{"loggedIn":false}'), /claude is unavailable or not authenticated/);
    await assert.rejects(validate('claude-session', 'not json'), /claude is unavailable/, 'unreadable output is not a sign-in');
    assert.deepEqual(
        calls.map((call) => [call.command.replace(/\.exe$/, ''), call.args, call.timeout]),
        [
            ...Array.from({ length: 3 }, () => [resolve('bin', 'codex'), ['login', 'status'], 8000]),
            ...Array.from({ length: 4 }, () => [resolve('bin', 'claude'), ['auth', 'status', '--json'], 8000]),
        ],
        'each provider CLI is asked for its own sign-in status',
    );
    await mkdir('empty', { recursive: true });
    const before = calls.length;
    await assert.rejects(
        withPath('empty', () => validateAi('codex-local', '', {}, runner(calls, { stdout: '', stderr: '' }))),
        /codex is unavailable/,
    );
    assert.equal(calls.length, before, 'a missing CLI is reported without running anything');
}

async function checkPhases(): Promise<void> {
    const token = { DISCORD_BOT_TOKEN: 'fixture-token' };
    assert.equal(await onboardingPhase({ DISCORD_BOT_TOKEN: '  ' }), 'discord', 'a blank token starts over');
    await writeFile('marker.json', 'not json');
    assert.equal(await onboardingPhase(token, 'marker.json'), 'discord', 'a damaged marker starts over');
    await writeFile('marker.json', '{"phase":"elsewhere"}');
    assert.equal(await onboardingPhase(token, 'marker.json'), 'discord');
    for (const phase of ['ai', 'service', 'verify', 'complete']) {
        await writeFile('marker.json', JSON.stringify({ phase }));
        assert.equal(await onboardingPhase(token, 'marker.json'), phase);
    }
    await mkdir('folder-marker', { recursive: true });
    await assert.rejects(onboardingPhase(token, 'folder-marker'), 'an unreadable marker is an error, not a fresh start');
}

const routes = (patch: DiscordRoutes): DiscordRoutes => ({ ...discordRoutes(), ...patch });
const draft = { token: 'fixture-token', ownerId: fake.owner, channelId: fake.channel };

async function checkDiscord(): Promise<void> {
    const plain = routes({});
    delete plain['/applications/@me'];
    const discovered = await withDiscord(plain, () => discoverDiscord('fixture-token'));
    assert.deepEqual(discovered.intents, { messageContent: false, members: false }, 'unknown app flags mean no privileged intents');
    const failures: [DiscordRoutes, RegExp][] = [
        [{ '/users/@me': { id: fake.bot, username: 'Human' } }, /did not resolve to a Discord bot/],
        [{ '/users/@me': { username: 'Nobody', bot: true } }, /did not resolve to a Discord bot/],
        [{ [`/users/${fake.owner}`]: { id: fake.owner, username: 'helper', bot: true } }, /selected human Discord user/],
        [{ [`/users/${fake.owner}`]: { id: '1', username: 'other' } }, /selected human Discord user/],
        [{ [`/channels/${fake.channel}`]: { id: fake.channel, name: 'dm' } }, /Discord server channel/],
        [{ [`/channels/${fake.channel}`]: { id: '2', guild_id: fake.guild } }, /Discord server channel/],
    ];
    for (const [patch, error] of failures)
        await assert.rejects(
            withDiscord(routes(patch), () => verifyDiscord(draft)),
            error,
        );
    const nameless = routes({
        '/users/@me': { id: fake.bot, bot: true },
        [`/users/${fake.owner}`]: { id: fake.owner },
        [`/channels/${fake.channel}`]: { id: fake.channel, guild_id: fake.guild },
    });
    assert.deepEqual(await withDiscord(nameless, () => verifyDiscord(draft)), {
        bot: `bot (${fake.bot})`,
        owner: `owner (${fake.owner})`,
        channel: `channel (${fake.channel})`,
        guildId: fake.guild,
    });
}

async function checkSaveChatgpt(): Promise<void> {
    await writeFile('.env', 'DISCORD_BOT_TOKEN="fixture-token"\n');
    const previous = process.env.DISCORDINATOR_POLICY_FILE;
    delete process.env.DISCORDINATOR_POLICY_FILE;
    try {
        await saveAi('chatgpt-events', 'bot.example.com', { marker: 'saved-marker.json' });
    } finally {
        if (previous !== undefined) process.env.DISCORDINATOR_POLICY_FILE = previous;
    }
    const policy = JSON.parse(await readFile('policy.json', 'utf8')) as { mcpEvents: { enabled: boolean } };
    assert.equal(policy.mcpEvents.enabled, true, 'a new policy file allows wake-up events');
    assert.match(await readFile('.env', 'utf8'), /DISCORDINATOR_RESOURCE_URL="https:\/\/bot\.example\.com\/mcp"/);
    assert.equal(await onboardingPhase({ DISCORD_BOT_TOKEN: 'x' }, 'saved-marker.json'), 'service');
}

async function checkProbe(): Promise<void> {
    const probe = (respond: () => Promise<Response>) => probeConnection('https://fixture.example/mcp', respond);
    const reached = { result: { serverInfo: { name: 'Discordinator' } } };
    assert.match(await probe(() => Promise.resolve(new Response('', { status: 502 }))), /HTTP 502/);
    assert.match(
        await probe(() => Promise.resolve(Response.json({ result: { serverInfo: { name: 'Other' } } }))),
        /did not identify itself/,
    );
    assert.match(await probe(() => Promise.reject(new Error('offline'))), /Connection not ready yet/);
    assert.match(await probe(() => Promise.resolve(new Response('not json'))), /Connection not ready yet/, 'garbage is not trusted');
    const stream = `event: message\ndata: ${JSON.stringify(reached)}\n\n`;
    assert.match(await probe(() => Promise.resolve(new Response(stream))), /server reached/, 'streamed replies are read');
    assert.match(await probe(() => Promise.resolve(new Response(`data: ${JSON.stringify(reached)}\n`))), /server reached/);
    assert.match(await probe(() => Promise.resolve(new Response('event: ping\n\n'))), /did not identify itself/, 'a stream without data');
}

async function checkLocalApps(): Promise<void> {
    await mkdir('empty', { recursive: true });
    const checks = await withPath('empty', async () => [await verifyChecks('claude-session'), await verifyChecks('codex-local')]);
    for (const [index, name] of ['Claude Code', 'Codex'].entries()) {
        const app = checks[index]![1]!;
        assert.equal(app.label, `${name} is connected`, `${name} must be connected`);
        assert.deepEqual([app.ok, app.hint], [false, `${name}: Not installed. Go back and connect it.`]);
    }
    const chatgpt = await verifyChecks('chatgpt-events');
    assert.equal(chatgpt.find((check) => check.label === 'Automatic wake-ups are on')?.ok, false, 'offline means no wake-ups');
}

export async function checkOnboardingStore(directory: string): Promise<void> {
    await inScratch(directory, async () => {
        await checkCliSignIn();
        await checkPhases();
        await checkDiscord();
        await checkSaveChatgpt();
        await checkProbe();
        await checkLocalApps();
    });
}
