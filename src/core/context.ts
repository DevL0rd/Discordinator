import type { Policy } from './policy.js';
import type { EventQueue } from './queue.js';
import type { Origin } from './policy.js';

export interface ObservedMessage extends Origin {
  messageId: string;
  timestamp: string;
  text: string;
  contentAvailable: boolean;
  authorBot: boolean;
  parentId: string | null;
  replyToId: string | null;
}
export interface ContextRecord extends ObservedMessage {
  observedAt: string;
  truncated: boolean;
}

/** Read context is never an action origin. Only EventQueue can mint action IDs. */
export class ContextIndex {
  private items = new Map<string, { record: ContextRecord; expires: number }>();
  private evicted = 0;
  constructor(readonly policy: Policy, readonly queue: EventQueue, readonly now = Date.now) {}

  private prune(): void {
    for (const [id, item] of this.items) if (item.expires <= this.now()) this.items.delete(id);
  }

  ingest(input: ObservedMessage, addressed: boolean): void {
    const config = this.policy.config.context;
    if (!config.enabled || (!addressed && config.capture !== 'all')) return;
    if (input.authorBot && !config.includeBots) return;
    this.policy.assertObservation(input);
    this.prune();
    const record = { ...input, text: input.text.slice(0, config.contentLimit),
      truncated: input.text.length > config.contentLimit, observedAt: new Date(this.now()).toISOString() };
    this.items.set(input.messageId, { record, expires: this.now() + config.ttlMinutes * 60_000 });
    const channel = [...this.items.values()].filter(item => item.record.channelId === input.channelId);
    while (channel.length > config.perChannel) this.evict(channel.shift()!.record.messageId);
    while (this.items.size > config.maxMessages) this.evict(this.items.keys().next().value!);
  }

  private evict(id: string): void { this.items.delete(id); this.evicted++; }
  remove(id: string): void { this.items.delete(id); }

  update(id: string, text: string, available: boolean): void {
    this.prune();
    const item = this.items.get(id);
    if (!item) return;
    item.record.text = text.slice(0, this.policy.config.context.contentLimit);
    item.record.truncated = text.length > this.policy.config.context.contentLimit;
    item.record.contentAvailable = available;
  }

  query(eventId: string, mode: 'recent' | 'user' | 'search', limit: number, query = '', includeParent = false) {
    const origin = this.queue.context(eventId).event;
    this.policy.assertOrigin(origin);
    this.policy.assertScope('messages.read');
    if (!this.policy.config.context.enabled) throw new Error('Context capture is disabled');
    this.prune();
    const records = [...this.items.values()].map(item => item.record).filter(record => this.accessible(record, origin));
    const anchor = records.find(record => record.messageId === origin.messageId);
    const selected = records.filter(record => this.matches(record, origin, mode, query, includeParent ? anchor?.parentId : undefined));
    return { records: selected.reverse().slice(0, Math.min(50, limit)), retained: records.length,
      evicted: this.evicted, incomplete: true, search: 'case-insensitive literal substring; retained text only',
      retentionMinutes: this.policy.config.context.ttlMinutes, persistent: false };
  }

  private accessible(record: ContextRecord, origin: Origin): boolean {
    try {
      this.policy.assertObservation(record);
      // A DM query cannot disclose guilds or other DM conversations.
      if (!origin.guildId) return !record.guildId && record.actorId === origin.actorId;
      return record.guildId !== null;
    } catch { return false; }
  }

  private matches(record: ContextRecord, origin: Origin, mode: string, query: string, parent?: string | null): boolean {
    if (mode === 'user') return record.actorId === origin.actorId;
    const sameChannel = record.channelId === origin.channelId || (parent != null && record.channelId === parent);
    if (!sameChannel) return false;
    return mode !== 'search' || record.text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  }
}
