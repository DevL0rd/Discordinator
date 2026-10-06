import { open, stat } from 'node:fs/promises';
import { promptTokens, toolActivity } from './claude-stream.js';
import { watchFile } from './file-watch.js';

type Post = (eventId: string, text: string, key: string) => Promise<unknown>;
const quiet = /discord|ToolSearch|TodoWrite/i;

export function transcriptSteps(line: string): string[] {
    let entry: { type?: string; message?: { content?: unknown } };
    try {
        entry = JSON.parse(line) as typeof entry;
    } catch {
        return [];
    }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return [];
    return entry.message.content.flatMap((block: unknown) => {
        const item = block && typeof block === 'object' ? (block as Record<string, unknown>) : {};
        if (item.type !== 'tool_use' || typeof item.name !== 'string' || quiet.test(item.name)) return [];
        return [toolActivity(item.name, item.input)];
    });
}

function transcriptTokens(line: string): number | undefined {
    try {
        return promptTokens(JSON.parse(line) as { type?: string; message?: unknown });
    } catch {
        return undefined;
    }
}

export class SessionActivity {
    private offset = 0;
    private partial = '';
    private eventId?: string;
    private reading: Promise<void> = Promise.resolve();
    private unwatch?: () => void;

    constructor(
        readonly post: Post,
        readonly enabled: () => boolean,
        readonly context: (percent: number, eventId?: string) => void = () => undefined,
    ) {}

    async follow(path: string, eventId: string): Promise<void> {
        this.eventId = eventId;
        if (this.unwatch) return;
        this.offset = (await stat(path)).size;
        this.unwatch = watchFile(path, () => {
            this.reading = this.reading.then(() => this.read(path)).catch(() => undefined);
        });
    }

    stop(): void {
        this.unwatch?.();
        this.unwatch = undefined;
    }

    private async read(path: string): Promise<void> {
        const size = (await stat(path)).size;
        if (size <= this.offset) return;
        const handle = await open(path, 'r');
        try {
            const buffer = Buffer.alloc(size - this.offset);
            await handle.read(buffer, 0, buffer.length, this.offset);
            this.offset = size;
            const lines = (this.partial + buffer.toString('utf8')).split('\n');
            this.partial = lines.pop() ?? '';
            for (const [index, step] of lines.flatMap(transcriptSteps).entries()) await this.publish(step, index);
            const tokens = lines
                .map(transcriptTokens)
                .filter((value) => value !== undefined)
                .at(-1);
            if (tokens) this.context(Math.round((tokens / (tokens > 200_000 ? 1_000_000 : 200_000)) * 100), this.eventId);
        } finally {
            await handle.close();
        }
    }

    private async publish(step: string, index: number): Promise<void> {
        if (!this.eventId || !this.enabled()) return;
        await this.post(this.eventId, step, `session-activity-${this.eventId}-${this.offset}-${index}`).catch(() => undefined);
    }
}
