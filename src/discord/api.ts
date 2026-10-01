import { REST, RequestMethod } from 'discord.js';
import type { Policy } from '../core/policy.js';
import { sanitizedError } from '../core/errors.js';

export type Json = Record<string, unknown>;
const methods = {
    GET: RequestMethod.Get,
    POST: RequestMethod.Post,
    PATCH: RequestMethod.Patch,
    PUT: RequestMethod.Put,
    DELETE: RequestMethod.Delete,
};
export interface Api {
    botId: string;
    get(route: string, query?: URLSearchParams): Promise<unknown>;
    post(route: string, body: unknown): Promise<unknown>;
    postFiles(route: string, body: unknown, files: import('../core/queue.js').Delivery['files']): Promise<unknown>;
    patch(route: string, body: unknown, reason?: string): Promise<unknown>;
    put(route: string, body?: unknown, reason?: string): Promise<unknown>;
    delete(route: string, reason?: string): Promise<unknown>;
    channel(id: string): Promise<Json>;
    message(channelId: string, messageId: string): Promise<Json>;
}

export class DiscordApi implements Api {
    botId = '';
    private readonly rest: REST;
    private invalid = false;

    constructor(
        token: string,
        readonly policy: Policy,
    ) {
        this.rest = new REST({ version: '10', retries: 0, timeout: 15_000 }).setToken(token);
    }

    private async request(
        method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        route: string,
        body?: unknown,
        query?: URLSearchParams,
        reason?: string,
        files?: import('../core/queue.js').Delivery['files'],
    ) {
        if (this.invalid) throw new Error('Discord authentication failed; restart after correcting credentials');
        try {
            return await this.rest.request({
                method: methods[method],
                fullRoute: route as `/${string}`,
                ...(body === undefined ? {} : { body }),
                ...(query ? { query } : {}),
                ...(reason ? { reason } : {}),
                ...(files?.length ? { files } : {}),
            });
        } catch (error) {
            const status = (error as { status?: number }).status;
            if (status === 401) this.invalid = true;
            throw sanitizedError(`Discord request failed (${status ?? 'network/timeout'}); inspect outcome before retrying mutations`);
        }
    }

    get(route: string, query?: URLSearchParams) {
        return this.request('GET', route, undefined, query);
    }
    post(route: string, body: unknown) {
        return this.request('POST', route, body);
    }
    postFiles(route: string, body: unknown, files: import('../core/queue.js').Delivery['files']) {
        return this.request('POST', route, body, undefined, undefined, files);
    }
    patch(route: string, body: unknown, reason?: string) {
        return this.request('PATCH', route, body, undefined, reason);
    }
    put(route: string, body?: unknown, reason?: string) {
        return this.request('PUT', route, body, undefined, reason);
    }
    delete(route: string, reason?: string) {
        return this.request('DELETE', route, undefined, undefined, reason);
    }

    async channel(id: string): Promise<Json> {
        this.policy.assertChannel(id);
        const channel = (await this.get(`/channels/${id}`)) as Json;
        if (typeof channel.guild_id !== 'string') throw new Error('This operation requires a guild channel');
        this.policy.assertGuild(channel.guild_id);
        return channel;
    }

    async message(channelId: string, messageId: string): Promise<Json> {
        const message = (await this.get(`/channels/${channelId}/messages/${messageId}`)) as Json;
        const author = message.author as Json;
        if (author.id !== this.botId) this.policy.assertUser(String(author.id));
        return message;
    }
}

const safeFields = new Set([
    'id',
    'name',
    'type',
    'guild_id',
    'channel_id',
    'parent_id',
    'topic',
    'position',
    'content',
    'timestamp',
    'edited_timestamp',
    'author',
    'username',
    'global_name',
    'bot',
    'roles',
    'nick',
    'joined_at',
    'premium_since',
    'communication_disabled_until',
    'permissions',
    'permission_overwrites',
    'allow',
    'deny',
    'managed',
    'hoist',
    'mentionable',
    'color',
    'colors',
    'primary_color',
    'secondary_color',
    'tertiary_color',
    'member_count',
    'owner_id',
    'description',
    'nsfw',
    'rate_limit_per_user',
    'bitrate',
    'user_limit',
    'archived',
    'locked',
    'thread_metadata',
    'archive_timestamp',
    'auto_archive_duration',
    'emoji',
    'emojis',
    'count',
    'me',
    'reactions',
    'scheduled_start_time',
    'scheduled_end_time',
    'entity_type',
    'entity_metadata',
    'location',
    'privacy_level',
    'status',
    'user_count',
    'code',
    'uses',
    'max_uses',
    'max_age',
    'temporary',
    'created_at',
    'user',
    'reason',
    'action_type',
    'target_id',
    'changes',
    'key',
    'old_value',
    'new_value',
    'audit_log_entries',
    'users',
    'rules',
    'enabled',
    'event_type',
    'trigger_type',
    'trigger_metadata',
    'actions',
    'metadata',
    'keyword_filter',
    'regex_patterns',
    'presets',
    'allow_list',
    'exempt_roles',
    'exempt_channels',
    'duration_seconds',
    'custom_message',
    'attachment',
    'attachments',
    'filename',
    'size',
    'url',
    'poll',
    'question',
    'text',
    'answers',
    'answer_id',
    'results',
    'answer_counts',
    'is_finalized',
    'duration',
    'allow_multiselect',
    'layout_type',
    'items',
    'message',
    'pinned_at',
    'has_more',
    'available_tags',
    'applied_tags',
    'moderated',
    'emoji_id',
    'emoji_name',
    'default_reaction_emoji',
    'tags',
    'available',
    'format_type',
    'approximate_member_count',
    'approximate_presence_count',
]);

export function project(value: unknown, depth = 0): unknown {
    if (depth > 6) return null;
    if (typeof value === 'string') return value.slice(0, 4000);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => project(item, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => safeFields.has(key))
                .map(([key, item]) => [key, project(item, depth + 1)]),
        );
    }
    return value ?? null;
}
