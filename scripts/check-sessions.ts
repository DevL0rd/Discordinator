import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { conversationExists, deliver, liveSession } from '../src/operator/claude-sessions.js';
import { SessionRouter } from '../src/operator/session-router.js';
import { SessionActivity, transcriptSteps } from '../src/operator/session-activity.js';
import { fixture, socketPath } from './fixtures.js';

function inbox(socket: string, onMessage: () => void = () => undefined): Promise<{ received: Promise<string>; close(): Promise<void> }> {
    let resolveText: (value: string) => void;
    const received = new Promise<string>((resolve) => (resolveText = resolve));
    const server = createServer((connection) => {
        let text = '';
        connection.on('data', (chunk: Buffer) => (text += chunk.toString()));
        connection.on('end', () => {
            onMessage();
            resolveText(text);
        });
    });
    return new Promise((resolve) =>
        server.listen(socket, () => resolve({ received, close: () => new Promise<void>((done) => server.close(() => done())) })),
    );
}

async function registry(config: string, sessionId: string, socket: string, workspace: string): Promise<void> {
    await mkdir(join(config, 'sessions'), { recursive: true });
    const entry = {
        pid: process.pid,
        sessionId,
        cwd: workspace,
        messagingSocketPath: socket,
        entrypoint: 'claude-desktop',
        status: 'idle',
    };
    await writeFile(join(config, 'sessions', `${process.pid}.json`), JSON.stringify(entry));
    await writeFile(join(config, 'sessions', '999999.json'), JSON.stringify({ ...entry, pid: 999999, sessionId: 'dead' }));
    await mkdir(join(config, 'projects', 'shortened-name-abc123'), { recursive: true });
    await writeFile(join(config, 'projects', 'shortened-name-abc123', `${sessionId}.jsonl`), '{}\n');
}

export async function checkSessions(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'discordinator-sessions-'));
    const previous = { cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR };
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const socket = socketPath(directory, 'inbox');
    const workspace = join(directory, 'work');
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude');
    process.chdir(directory);
    try {
        await registry(process.env.CLAUDE_CONFIG_DIR, sessionId, socket, workspace);
        assert.equal((await liveSession(sessionId))?.entrypoint, 'claude-desktop');
        assert.equal(await liveSession('dead'), undefined, 'sessions whose process is gone are ignored');
        assert.equal(await conversationExists(sessionId), true, 'transcripts are found even in shortened folder names');
        const first = await inbox(socket);
        const keyName = `${process.pid}.${createHash('sha256').update(socket).digest('hex')}.key`;
        await writeFile(join(process.env.CLAUDE_CONFIG_DIR, 'sessions', keyName), JSON.stringify({ peerToken: 'a'.repeat(32) }));
        await deliver({ pid: process.pid, socket }, 'hello');
        assert.deepEqual(
            (await first.received)
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as unknown),
            [
                { type: 'auth', token: 'a'.repeat(32) },
                { type: 'user', message: { role: 'user', content: 'hello' } },
            ],
            'the published peer key authenticates the delivery first',
        );
        await first.close();
        await mkdir('.data', { recursive: true });
        await writeFile('.data/claude-session.json', JSON.stringify({ sessionId, workspace }));
        await checkRouter(directory, sessionId, socket, workspace);
    } finally {
        process.chdir(previous.cwd);
        if (previous.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous.config;
        await rm(directory, { recursive: true, force: true });
    }
}

async function checkRouter(directory: string, sessionId: string, socket: string, workspace: string): Promise<void> {
    {
        const f = fixture(join(directory, 'router.json'));
        const router = new SessionRouter(f.bridge, workspace);
        await router.start();
        assert.equal(router.status().live, true, 'the saved conversation is found live');
        const busy = () =>
            void writeFile(
                join(process.env.CLAUDE_CONFIG_DIR!, 'sessions', `${process.pid}.json`),
                JSON.stringify({
                    pid: process.pid,
                    sessionId,
                    cwd: workspace,
                    messagingSocketPath: socket,
                    entrypoint: 'claude-desktop',
                    status: 'busy',
                }),
            );
        const second = await inbox(socket, busy);
        await router.route(f.event);
        const text = (JSON.parse((await second.received).trim().split('\n').at(-1)!) as { message: { content: string } }).message.content;
        assert.match(text, new RegExp(`eventId "${f.event.id}"`), 'Discord context reaches the session');
        assert.match(text, /discord_respond/);
        await second.close();
        let repeated = false;
        const third = await inbox(socket, () => (repeated = true));
        await router.route(f.event);
        await until(() => router.status().busy);
        assert.equal(repeated, false, 'a retried event is never delivered twice');
        await third.close();
        router.stop();
    }
}

const tool = (name: string, input: Record<string, unknown>) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const delivered = (eventId: string) =>
    JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `Discord · DM\nhi\n-> discord_respond with eventId "${eventId}"; post progress` },
    });
const usage = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 100_000 }, content: [] } });

async function until(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 100 && !predicate(); index++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(predicate(), 'session activity did not settle');
}

export async function checkSessionActivity(directory: string): Promise<void> {
    assert.deepEqual(transcriptSteps(tool('Bash', { command: 'npm test' })), ['-# Running\n```sh\nnpm test\n```']);
    assert.deepEqual(transcriptSteps(tool('mcp__discordinator__discord_respond', {})), [], 'Discord replies are not echoed as activity');
    assert.deepEqual(transcriptSteps('not json'), []);
    const path = join(directory, 'activity.jsonl');
    await writeFile(path, `${tool('Bash', { command: 'old' })}\n`);
    const trace = { posted: [] as string[], picked: [] as string[], replied: [] as string[], enabled: true };
    const { posted, picked, replied } = trace;
    const activity = new SessionActivity(
        (eventId, text) => {
            posted.push(`${eventId}:${text}`);
            return Promise.resolve();
        },
        () => trace.enabled,
        { pickedUp: (eventId) => picked.push(eventId), replied: (eventId) => replied.push(eventId) },
    );
    await activity.follow(path, 'event-1');
    assert.equal(await activity.pickedUp('unknown', 10), false);
    const pickup = activity.pickedUp('event-1', 2000);
    await appendFile(path, `${delivered('event-1')}\n${tool('Edit', { file_path: '/repo/src/app.ts' })}\n`);
    assert.equal(await pickup, true, 'the delivered entry is confirmed from the transcript');
    await until(() => posted.length === 1);
    assert.deepEqual(posted, ['event-1:-# Editing app.ts'], 'only steps after delivery are posted');
    await activity.follow(path, 'event-2');
    await appendFile(path, `${tool('Read', { file_path: '/repo/a.ts' })}\n`);
    await until(() => posted.length === 2);
    assert.equal(posted[1], 'event-1:-# Reading a.ts', 'steps before the next message is picked up stay with the earlier message');
    await appendFile(path, `${delivered('event-2')}\n${tool('Read', { file_path: '/repo/b.ts' })}\n`);
    await until(() => posted.length === 3);
    assert.equal(posted[2], 'event-2:-# Reading b.ts', 'steps follow the message Claude is working on');
    await appendFile(path, `${tool('mcp__discordinator__discord_respond', { eventId: 'event-1' })}\n${usage}\n`);
    await until(() => replied.length === 1);
    assert.deepEqual(picked, ['event-1', 'event-2']);
    assert.deepEqual(replied, ['event-1']);
    assert.equal(posted.length, 3, 'a 100k-token session on an unknown context window posts no percentage warning');
    await checkTranscriptSwitch(activity, directory, path, trace);
}

async function checkTranscriptSwitch(
    activity: SessionActivity,
    directory: string,
    path: string,
    trace: { posted: string[]; enabled: boolean },
) {
    const { posted } = trace;
    const fresh = join(directory, 'activity-new.jsonl');
    await writeFile(fresh, '');
    await activity.follow(fresh, 'event-3');
    await appendFile(path, `${tool('Bash', { command: 'stale' })}\n`);
    await appendFile(fresh, `${delivered('event-3')}\n${tool('Bash', { command: 'fresh' })}\n`);
    await until(() => posted.length === 4);
    assert.match(posted[3]!, /^event-3:[\s\S]*fresh/, 'a new conversation transcript replaces the old one');
    trace.enabled = false;
    await appendFile(fresh, `${tool('Bash', { command: 'quiet' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(posted.length, 4, 'activity respects the visibility setting');
    activity.stop();
}
