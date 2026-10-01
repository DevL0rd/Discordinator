import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { snowflake } from '../core/config.js';
import type { MediaAccess } from './access.js';

export const attachmentSchema = z.object({ id: snowflake, filename: z.string().min(1).max(256),
  size: z.number().int().min(1), content_type: z.string().max(100).optional(), url: z.string().url(),
  width: z.number().nullable().optional(), height: z.number().nullable().optional() });
export const messageSchema = z.object({ id: snowflake, channel_id: snowflake, author: z.object({ id: snowflake }),
  timestamp: z.iso.datetime({ offset: true }), attachments: z.array(attachmentSchema).max(10) });
export type MediaMessage = z.infer<typeof messageSchema>;
export interface Entry { attachment: z.infer<typeof attachmentSchema>; messageId: string; channelId: string;
  guildId: string | null; userId: string; timestamp: string; expires: number }
export const searchSchema = z.object({ eventId: z.uuid(), channelId: snowflake.optional(), userId: snowflake.optional(),
  messageId: snowflake.optional(), attachmentIds: z.array(snowflake).min(1).max(10).optional(),
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  kind: z.enum(['all', 'image', 'file']).default('all'), limit: z.number().int().min(1).max(25).default(10),
  cursor: z.uuid().optional() }).strict();
export type Search = z.infer<typeof searchSchema>;
interface Page { eventId: string; fingerprint: string; entries: Entry[]; expires: number }
interface Source { eventId: string; entry: Entry; expires: number }

export function matches(entry: Entry, search: Search): boolean {
  const image = entry.attachment.content_type?.startsWith('image/') ?? /\.(png|jpe?g|gif|webp)$/i.test(entry.attachment.filename);
  if (search.kind === 'image' && !image || search.kind === 'file' && image) return false;
  return matchesIdentity(entry, search) && matchesTime(entry.timestamp, search);
}

function matchesIdentity(entry: Entry, search: Search): boolean {
  if (search.userId && search.userId !== entry.userId || search.messageId && search.messageId !== entry.messageId) return false;
  return !search.attachmentIds || search.attachmentIds.includes(entry.attachment.id);
}

function matchesTime(timestamp: string, search: Search): boolean {
  if (search.from && Date.parse(timestamp) < Date.parse(search.from)) return false;
  return !search.to || Date.parse(timestamp) <= Date.parse(search.to);
}

export class AttachmentIndex {
  private entries = new Map<string, Entry>();
  private sources = new Map<string, Source>();
  private pages = new Map<string, Page>();
  constructor(readonly access: MediaAccess, readonly now = Date.now) {}
  private prune(): void {
    for (const map of [this.entries, this.sources, this.pages]) {
      for (const [key, item] of map) if (item.expires <= this.now()) map.delete(key);
    }
  }
  remove(messageId: string): void {
    for (const [key, entry] of this.entries) if (entry.messageId === messageId) this.entries.delete(key);
    for (const [key, source] of this.sources) if (source.entry.messageId === messageId) this.sources.delete(key);
  }
  records(message: MediaMessage, guildId: string | null): Entry[] {
    return message.attachments.map(attachment => ({ attachment, guildId, messageId: message.id,
      channelId: message.channel_id, userId: message.author.id, timestamp: message.timestamp,
      expires: this.now() + this.access.policy.config.media.ttlMinutes * 60_000 }));
  }
  ingest(value: unknown, guildId: string | null, addressed: boolean): void {
    const config = this.access.policy.config.media;
    if (!config.enabled || config.capture === 'addressed' && !addressed) return;
    const message = messageSchema.parse(value);
    this.access.policy.assertScope('media.read');
    this.access.policy.assertObservation({ actorId: message.author.id, channelId: message.channel_id, guildId });
    this.prune(); this.remove(message.id);
    for (const entry of this.records(message, guildId)) this.entries.set(`${message.id}:${entry.attachment.id}`, entry);
    while (this.entries.size > config.maxAttachments) this.entries.delete(this.entries.keys().next().value!);
  }
  source(eventId: string, id: string): Entry {
    this.access.event(eventId); this.prune();
    const source = this.sources.get(id);
    if (!source || source.eventId !== eventId) throw new Error('Attachment handle expired or belongs to another event');
    return source.entry;
  }
  expose(eventId: string, entry: Entry) {
    this.prune();
    if (!this.allowed(eventId, entry)) throw new Error('Attachment source is outside current resource grants');
    if (this.sources.size >= 1000) throw new Error('Attachment handle limit reached');
    const sourceId = randomUUID();
    this.sources.set(sourceId, { eventId, entry, expires: Math.min(this.access.event(eventId).expiresAt, this.now() + 10 * 60_000) });
    const { url: _url, ...attachment } = entry.attachment;
    return { sourceId, ...attachment, messageId: entry.messageId, channelId: entry.channelId, guildId: entry.guildId,
      userId: entry.userId, timestamp: entry.timestamp, imageTypeVerified: false, jumpUrl: jumpUrl(entry) };
  }
  async search(value: Search) {
    const input = searchSchema.parse(value);
    this.access.event(input.eventId);
    if (input.channelId) await this.access.channel(input.eventId, input.channelId);
    this.prune();
    const { cursor: _cursor, ...filters } = input;
    const fingerprint = JSON.stringify(filters);
    const snapshot = input.cursor ? this.resume(input.cursor, input.eventId, fingerprint) : [...this.entries.values()];
    const entries = snapshot.filter(entry => this.allowed(input.eventId, entry) && (!input.channelId || entry.channelId === input.channelId) && matches(entry, input))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.attachment.id.localeCompare(a.attachment.id));
    const rows = entries.slice(0, input.limit).map(entry => this.expose(input.eventId, entry));
    const nextCursor = this.save(input.eventId, fingerprint, entries.slice(input.limit));
    return { attachments: rows, nextCursor, coverage: 'bounded-local-index', incomplete: true,
      retentionMinutes: this.access.policy.config.media.ttlMinutes, indexed: this.entries.size };
  }
  private allowed(eventId: string, entry: Entry): boolean {
    const origin = this.access.event(eventId).event;
    if (entry.expires <= this.now()) return false;
    if (entry.guildId !== origin.guildId || !origin.guildId && entry.channelId !== origin.channelId) return false;
    try {
      this.access.policy.assertObservation({ actorId: entry.userId, channelId: entry.channelId, guildId: entry.guildId });
      return true;
    } catch { return false; }
  }
  private resume(cursor: string, eventId: string, fingerprint: string): Entry[] {
    const page = this.pages.get(cursor);
    if (!page || page.eventId !== eventId || page.fingerprint !== fingerprint) throw new Error('Cursor expired or filters/event changed');
    return page.entries;
  }
  private save(eventId: string, fingerprint: string, entries: Entry[]): string | null {
    if (!entries.length) return null;
    if (this.pages.size >= 16) throw new Error('Media pagination limit reached');
    const id = randomUUID();
    this.pages.set(id, { eventId, fingerprint, entries, expires: this.now() + 60_000 });
    return id;
  }
}

export function jumpUrl(entry: Entry): string {
  return `https://discord.com/channels/${entry.guildId ?? '@me'}/${entry.channelId}/${entry.messageId}`;
}
