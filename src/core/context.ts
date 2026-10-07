import type { Policy } from './policy.js';
import type { EventQueue } from './queue.js';
import type { Origin } from './policy.js';
import { displayName, readableText, type Directory, type Person } from './directory.js';

export interface ObservedMessage extends Origin {
    messageId: string;
    author: Person;
    mentions: Person[];
    timestamp: string;
    text: string;
    contentAvailable: boolean;
    authorBot: boolean;
    parentId: string | null;
    replyToId: string | null;
}
export interface ContextRecord extends ObservedMessage {
    observedAt: string;
}

/** Read context is never an action origin. Only EventQueue can mint action IDs. */
export class ContextIndex {
    private items = new Map<string, { record: ContextRecord }>();
    private evicted = 0;
    directory?: Directory;
    constructor(
        readonly policy: Policy,
        readonly queue: EventQueue,
        readonly now = Date.now,
    ) {}

    ingest(input: ObservedMessage, addressed: boolean): void {
        const config = this.policy.config.context;
        if (!config.enabled || (!addressed && config.capture !== 'all')) return;
        if (input.authorBot && !config.includeBots) return;
        this.policy.assertObservation(input);
        for (const who of [input.author, ...input.mentions]) this.directory?.learn(who, input.guildId);
        const record = { ...input, observedAt: new Date(this.now()).toISOString() };
        this.items.delete(input.messageId);
        this.items.set(input.messageId, { record });
        const channel = [...this.items.values()].filter((item) => item.record.channelId === input.channelId);
        while (channel.length > config.perChannel) this.evict(channel.shift()!.record.messageId);
    }

    private evict(id: string): void {
        this.items.delete(id);
        this.evicted++;
    }
    remove(id: string): void {
        this.items.delete(id);
    }

    update(id: string, text: string, available: boolean): void {
        const item = this.items.get(id);
        if (!item) return;
        item.record.text = text;
        item.record.contentAvailable = available;
    }

    private origin(eventId: string): Origin {
        const origin = this.queue.authorize(eventId).event;
        this.policy.assertOrigin(origin);
        this.policy.assertScope('messages.read');
        if (!this.policy.config.context.enabled) throw new Error('Context capture is disabled');
        return origin;
    }

    history(eventId: string, wholeServer: boolean): ContextRecord[] {
        const origin = this.origin(eventId);
        return [...this.items.values()]
            .map((item) => item.record)
            .filter((record) => this.accessible(record, origin))
            .filter((record) => (wholeServer && origin.guildId ? record.guildId === origin.guildId : record.channelId === origin.channelId))
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    query(eventId: string, mode: 'recent' | 'user' | 'search', limit: number, query = '', includeParent = false) {
        const origin = this.origin(eventId);
        const records = [...this.items.values()].map((item) => item.record).filter((record) => this.accessible(record, origin));
        const anchor = records.find((record) => record.messageId === origin.messageId);
        const selected = records.filter((record) =>
            this.matches(record, origin, mode, query, includeParent ? anchor?.parentId : undefined),
        );
        return {
            records: selected
                .reverse()
                .slice(0, Math.min(50, limit))
                .map((record) => this.present(record)),
            retained: records.length,
            evicted: this.evicted,
            incomplete: true,
            search: 'case-insensitive literal substring; retained text only',
            persistent: false,
        };
    }

    private present(record: ContextRecord) {
        return {
            ...record,
            text: readableText(record.text, record.mentions),
            authorName: displayName(record.author),
            fromOwner: this.policy.isOwner(record.actorId),
        };
    }

    private accessible(record: ContextRecord, origin: Origin): boolean {
        try {
            this.policy.assertObservation(record);
            // A DM query cannot disclose guilds or other DM conversations.
            if (!origin.guildId) return !record.guildId && record.actorId === origin.actorId;
            return record.guildId !== null;
        } catch {
            return false;
        }
    }

    private matches(record: ContextRecord, origin: Origin, mode: string, query: string, parent?: string | null): boolean {
        if (mode === 'user') return record.actorId === origin.actorId;
        const sameChannel = record.channelId === origin.channelId || (parent != null && record.channelId === parent);
        if (!sameChannel) return false;
        return mode !== 'search' || record.text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
    }
}
