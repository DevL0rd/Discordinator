import { activityLine } from './activity-format.js';
import type { ClaudeMessage, ClaudeUserMessage } from './claude-protocol.js';

export class MessageQueue implements AsyncIterable<ClaudeUserMessage> {
    private readonly values: ClaudeUserMessage[] = [];
    private readonly waiters: Array<(value: IteratorResult<ClaudeUserMessage>) => void> = [];
    private ended = false;

    push(value: ClaudeUserMessage): void {
        if (this.ended) throw new Error('Claude session is closed');
        const waiter = this.waiters.shift();
        if (waiter) waiter({ value, done: false });
        else this.values.push(value);
    }

    close(): void {
        this.ended = true;
        for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    }

    [Symbol.asyncIterator](): AsyncIterator<ClaudeUserMessage> {
        return {
            next: async () => {
                const value = this.values.shift();
                if (value) return { value, done: false };
                if (this.ended) return { value: undefined, done: true };
                return new Promise((resolve) => this.waiters.push(resolve));
            },
        };
    }
}

export function toolActivity(name: string, input: unknown): string {
    const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const value = (key: string) => (typeof fields[key] === 'string' ? fields[key] : '');
    if (name === 'Bash') return activityLine('Running', value('command'));
    if (['Edit', 'Write', 'NotebookEdit'].includes(name))
        return activityLine(`Editing ${(value('file_path') || value('notebook_path')).split('/').pop() ?? ''}`);
    if (name === 'Read') return activityLine(`Reading ${value('file_path').split('/').pop() ?? ''}`);
    if (name === 'WebSearch') return activityLine(`Searching the web for “${value('query')}”`);
    return activityLine(`Using ${name.replace(/^mcp__[^_]+__/, '')}`);
}

export function progressText(message: ClaudeMessage): Array<{ text: string; activity: boolean }> {
    if (message.type !== 'assistant') return [];
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    return content.flatMap((block): Array<{ text: string; activity: boolean }> => {
        const item = block && typeof block === 'object' ? (block as Record<string, unknown>) : {};
        if (item.type === 'text' && typeof item.text === 'string') return [{ text: item.text, activity: false }];
        if (item.type === 'tool_use' && typeof item.name === 'string')
            return [{ text: toolActivity(item.name, item.input), activity: true }];
        return [];
    });
}

type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };

export function promptTokens(entry: { type?: string; message?: unknown }): number | undefined {
    if (entry.type !== 'assistant') return undefined;
    const usage = (entry.message as { usage?: Usage } | undefined)?.usage;
    if (!usage) return undefined;
    return (
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0)
    );
}

export function contextWindow(result: Record<string, unknown>): number | undefined {
    const models = Object.values((result.modelUsage ?? {}) as Record<string, { contextWindow?: number }>);
    const windows = models.map((model) => model.contextWindow ?? 0).filter((value) => value > 0);
    return windows.length ? Math.max(...windows) : undefined;
}
