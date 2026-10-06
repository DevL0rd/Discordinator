import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Bridge } from '../core/bridge.js';
import type { BotEvent } from '../core/queue.js';
import {
    conversationExists,
    deliver,
    liveSession,
    openInDesktop,
    showInDesktop,
    transcriptPath,
    sessionsDir,
    type LiveSession,
} from './claude-sessions.js';
import { watchDirectory } from './file-watch.js';
import { claudeProgram } from './executables.js';
import { SessionActivity } from './session-activity.js';
import { ProcessingIndicator } from './processing-indicator.js';
import type { History } from './history.js';

const exec = promisify(execFile);
const stateFile = '.data/claude-session.json';
const stateSchema = z.object({ sessionId: z.uuid(), workspace: z.string(), seen: z.record(z.string(), z.string()).default({}) });
type SessionState = z.infer<typeof stateSchema>;

function liveMessage(event: BotEvent): string {
    const place = event.guildId ? `#${event.channelId}` : 'DM';
    const kind = event.kind === 'interaction' ? 'Discord answer' : 'Discord';
    return [
        `${kind} · ${place} · user ${event.actorId}`,
        event.text,
        `-> discord_respond with eventId "${event.id}"; post progress there if it takes a while.`,
    ].join('\n');
}

const nudge = 'Please handle the pending Discord message above.';
const greeting =
    'This is the Discordinator conversation. Discordinator will deliver Discord messages here for you to answer with the discord_respond tool. Reply with: Ready.';

async function savedState(workspace: string): Promise<SessionState | undefined> {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')));
    return parsed.success && parsed.data.workspace === workspace ? parsed.data : undefined;
}

async function saveState(state: SessionState): Promise<void> {
    await mkdir('.data', { recursive: true, mode: 0o700 });
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
}

export async function openConversation(workspace: string): Promise<string> {
    const sessionId = (await savedState(workspace))?.sessionId;
    if (!sessionId) throw new Error('The Discordinator conversation is created with the first Discord message.');
    await showInDesktop(sessionId);
    return 'Opened the Discordinator conversation in Claude Desktop.';
}

export class SessionRouter {
    live?: LiveSession;
    private unwatch?: () => void;
    private sessionId?: string;
    private seen: Record<string, string> = {};
    private delivered: string[] = [];
    private readonly picked = new Set<string>();
    private readonly activity: SessionActivity;
    private readonly typing: ProcessingIndicator;

    constructor(
        readonly bridge: Bridge,
        readonly workspace: string,
        readonly launch: { model?: string; effort?: string; activity?: boolean; history?: History } = {},
    ) {
        this.typing = new ProcessingIndicator((eventId) => this.bridge.typing(eventId));
        this.activity = new SessionActivity(
            (eventId, content, idempotencyKey) => this.bridge.respond({ eventId, content, idempotencyKey, status: true }),
            () => this.launch.activity === true,
            { pickedUp: (eventId) => this.picked.add(eventId), replied: (eventId) => this.settle(eventId) },
        );
    }

    async start(): Promise<void> {
        const saved = await savedState(this.workspace);
        this.sessionId = saved?.sessionId;
        this.seen = saved?.seen ?? {};
        this.unwatch = watchDirectory(sessionsDir(), () => void this.refresh(), 200);
        await this.refresh();
    }

    stop(): void {
        this.unwatch?.();
        this.activity.stop();
        this.typing.stop();
        this.picked.clear();
    }

    async reset(): Promise<void> {
        await rm(stateFile, { force: true });
        this.sessionId = undefined;
        this.seen = {};
        this.live = undefined;
        this.activity.stop();
        this.typing.stop();
        this.picked.clear();
    }

    get conversationId(): string | undefined {
        return this.sessionId;
    }

    status() {
        return {
            live: Boolean(this.live),
            busy: this.live?.status === 'busy',
            entrypoint: this.live?.entrypoint ?? null,
            sessionId: this.sessionId ?? null,
        };
    }

    async route(event: BotEvent): Promise<void> {
        if (this.delivered.includes(event.id)) return;
        this.typing.set(event.id, event.id, true);
        let live: LiveSession;
        try {
            const sessionId = await this.conversation();
            live = (await liveSession(sessionId)) ?? (await openInDesktop(sessionId));
            this.live = live;
            const transcript = await transcriptPath(sessionId);
            if (transcript) await this.activity.follow(transcript, event.id);
            await deliver(live, await this.withHistory(event, liveMessage(event)));
        } catch (error) {
            this.settle(event.id);
            throw error;
        }
        this.delivered = [...this.delivered, event.id].slice(-500);
        void this.confirm(live, event.id);
    }

    private async confirm(live: LiveSession, eventId: string): Promise<void> {
        if (await this.activity.pickedUp(eventId, 8000)) return;
        if ((await liveSession(live.sessionId))?.status !== 'idle') return;
        await deliver(live, nudge).catch(() => undefined);
    }

    private settle(eventId: string): void {
        this.picked.delete(eventId);
        this.typing.set(eventId, eventId, false);
    }

    private async conversation(): Promise<string> {
        if (this.sessionId && (await conversationExists(this.sessionId))) return this.sessionId;
        const sessionId = randomUUID();
        const options = [
            ...(this.launch.model ? ['--model', this.launch.model] : []),
            ...(this.launch.effort ? ['--effort', this.launch.effort] : []),
        ];
        const claude = await claudeProgram();
        await exec(claude.command, [...claude.args, '-p', '--session-id', sessionId, '--name', 'Discordinator', ...options, greeting], {
            cwd: this.workspace,
            timeout: 180_000,
        });
        if (!(await conversationExists(sessionId))) throw new Error('Claude Code did not create the Discordinator conversation');
        await saveState({ sessionId, workspace: this.workspace, seen: {} });
        this.sessionId = sessionId;
        this.seen = {};
        return sessionId;
    }

    private async withHistory(event: BotEvent, message: string): Promise<string> {
        if (!this.launch.history) return message;
        const { text, key, latest } = await this.launch.history(event, this.seen);
        if (latest) {
            this.seen[key] = latest;
            await saveState({ sessionId: this.sessionId!, workspace: this.workspace, seen: this.seen });
        }
        return `${text}${message}`;
    }

    private async refresh(): Promise<void> {
        const live = this.sessionId ? await liveSession(this.sessionId) : undefined;
        this.live = live;
        if (live && live.status !== 'idle') return;
        for (const eventId of [...this.picked]) this.settle(eventId);
    }
}
