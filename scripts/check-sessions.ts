import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { conversationExists, deliver, liveSession } from '../src/operator/claude-sessions.js';
import { SessionRouter } from '../src/operator/session-router.js';
import { SessionActivity, transcriptSteps } from '../src/operator/session-activity.js';
import { fixture } from './fixtures.js';

function inbox(socket: string, onMessage: () => void = () => undefined): Promise<{ received: Promise<string>; close(): void }> {
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
    return new Promise((resolve) => server.listen(socket, () => resolve({ received, close: () => server.close() })));
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
    const socket = join(directory, 'inbox.sock');
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
        first.close();
        await mkdir('.data', { recursive: true });
        await writeFile('.data/claude-session.json', JSON.stringify({ sessionId, workspace }));
        const f = fixture(join(directory, 'router.json'));
        const router = new SessionRouter(f.bridge, workspace, () => undefined);
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
        second.close();
        router.stop();
    } finally {
        process.chdir(previous.cwd);
        if (previous.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous.config;
        await rm(directory, { recursive: true, force: true });
    }
}

export async function checkSessionActivity(directory: string): Promise<void> {
    const tool = (name: string, input: Record<string, unknown>) =>
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
    assert.deepEqual(transcriptSteps(tool('Bash', { command: 'npm test' })), ['-# Running\n```sh\nnpm test\n```']);
    assert.deepEqual(transcriptSteps(tool('mcp__discordinator__discord_respond', {})), [], 'Discord replies are not echoed as activity');
    assert.deepEqual(transcriptSteps('not json'), []);
    const path = join(directory, 'activity.jsonl');
    await writeFile(path, `${tool('Bash', { command: 'old' })}\n`);
    const posted: string[] = [];
    let enabled = true;
    const activity = new SessionActivity(
        (_eventId, text) => {
            posted.push(text);
            return Promise.resolve();
        },
        () => enabled,
    );
    await activity.follow(path, 'event-1');
    await appendFile(path, `${tool('Edit', { file_path: '/repo/src/app.ts' })}\n`);
    for (let index = 0; index < 100 && !posted.length; index++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(posted, ['-# Editing app.ts'], 'only steps after delivery are posted');
    enabled = false;
    await appendFile(path, `${tool('Bash', { command: 'quiet' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(posted.length, 1, 'activity respects the visibility setting');
    activity.stop();
}
