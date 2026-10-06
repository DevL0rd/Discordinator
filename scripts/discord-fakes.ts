import assert from 'node:assert/strict';
import type { Api, Json } from '../src/discord/api.js';
import type { AccessContext, Delivery } from '../src/core/queue.js';
import { operations } from '../src/discord/catalog.js';
import type { Policy } from '../src/core/policy.js';
import type { Message } from 'discord.js';
import type { ObservedMessage, ContextIndex } from '../src/core/context.js';
import type { MediaService } from '../src/media/service.js';
import type { EventsService } from '../src/events/service.js';
import { Gateway } from '../src/discord/gateway.js';
import { fakeConfig, fixture, ids } from './fixtures.js';

export interface ApiCall {
    method: string;
    route: string;
    body?: unknown;
    query?: string;
    reason?: string;
}

export class RecordingApi implements Api {
    botId = ids.bot;
    applicationId = ids.bot;
    calls: ApiCall[] = [];
    responses = new Map<string, unknown>();
    channelGuild: unknown = ids.guild;
    messageAuthor = ids.bot;
    constructor(readonly policy: Policy) {}
    private record(call: ApiCall): Promise<unknown> {
        this.calls.push(call);
        return Promise.resolve(this.responses.get(call.route) ?? { id: ids.message, route: call.route });
    }
    get(route: string, query?: URLSearchParams) {
        return this.record({ method: 'GET', route, query: query?.toString() });
    }
    post(route: string, body: unknown) {
        return this.record({ method: 'POST', route, body });
    }
    postFiles(route: string, body: unknown, files: Delivery['files']) {
        return this.record({ method: 'FILES', route, body: { body, files } });
    }
    patch(route: string, body: unknown, reason?: string) {
        return this.record({ method: 'PATCH', route, body, reason });
    }
    put(route: string, body?: unknown, reason?: string) {
        return this.record({ method: 'PUT', route, body, reason });
    }
    delete(route: string, reason?: string) {
        return this.record({ method: 'DELETE', route, reason });
    }
    channel(id: string): Promise<Json> {
        this.calls.push({ method: 'CHANNEL', route: id });
        this.policy.assertChannel(id);
        return Promise.resolve({ id, guild_id: this.channelGuild });
    }
    message(channelId: string, messageId: string): Promise<Json> {
        this.calls.push({ method: 'MESSAGE', route: `${channelId}/${messageId}` });
        return Promise.resolve({ id: messageId, author: { id: this.messageAuthor } });
    }
    last(): ApiCall | undefined {
        return this.calls.at(-1);
    }
}

export const until = async (predicate: () => boolean, what: string, deadlineMs = 15_000): Promise<void> => {
    const deadline = Date.now() + deadlineMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setImmediate(resolve));
    }
};

export function gate() {
    let open = () => undefined as void;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { promise, open };
}

export function operationRunner(api: RecordingApi, policy: Policy, origin?: AccessContext) {
    return async (name: string, input: Record<string, unknown>): Promise<unknown> => {
        const operation = operations.find((item) => item.name === name);
        if (!operation) throw new Error(`Unknown operation ${name}`);
        return await operation.run(input, { api, policy, origin });
    };
}

export async function expectCalls(
    run: (name: string, input: Record<string, unknown>) => Promise<unknown>,
    api: RecordingApi,
    cases: [string, Record<string, unknown>, Partial<ApiCall>][],
): Promise<void> {
    for (const [name, input, expected] of cases) {
        await run(name, input);
        const call = api.last()!;
        const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, call[key as keyof ApiCall]]));
        assert.deepEqual(actual, expected, `${name} sends the expected request`);
    }
}

export const snowflakeId = (n: number): string => `70000000000000${String(n).padStart(4, '0')}`;

export function namedIds(): (name: string) => string {
    const names = new Map<string, string>();
    return (name) => {
        if (!names.has(name)) names.set(name, snowflakeId(names.size + 1));
        return names.get(name)!;
    };
}

export const createdAt = Date.parse('2026-10-07T12:00:00.000Z');

export function fakeMessage(overrides: Record<string, unknown> = {}): Message {
    return {
        id: ids.message,
        author: { id: ids.user, bot: false },
        content: 'Discordinator hello',
        channelId: ids.channel,
        guildId: ids.guild,
        webhookId: null,
        createdTimestamp: createdAt,
        attachments: new Map(),
        partial: false,
        ...overrides,
    } as unknown as Message;
}

export function gatewayHarness(file: string, services: ConstructorParameters<typeof Gateway>[5] = {}, config = fakeConfig()) {
    const f = fixture(file);
    f.policy.config.scopes.push('messages.read');
    f.policy.config.context.enabled = true;
    f.policy.config.mcpEvents.enabled = true;
    const context = { ingested: [] as [ObservedMessage, boolean][], removed: [] as string[], updated: [] as unknown[][] };
    const media = { ingested: [] as unknown[][], removed: [] as string[], fail: false };
    const emitted: [Record<string, unknown>, string | undefined][] = [];
    const fakes = {
        context: {
            ingest: (observed: ObservedMessage, addressed: boolean) => context.ingested.push([observed, addressed]),
            remove: (id: string) => context.removed.push(id),
            update: (...args: unknown[]) => context.updated.push(args),
        } as unknown as ContextIndex,
        media: {
            index: {
                ingest: (...args: unknown[]) => {
                    if (media.fail) throw new Error('media index unavailable');
                    media.ingested.push(args);
                },
                remove: (id: string) => media.removed.push(id),
            },
        } as unknown as MediaService,
        events: {
            emit: (data: Record<string, unknown>, name?: string) => {
                emitted.push([data, name]);
                return Promise.resolve();
            },
        } as unknown as EventsService,
    };
    const gateway = new Gateway(config, f.policy, f.queue, f.approvals, f.api, { ...fakes, ...services });
    const queued = () => f.queue.snapshot(0, 1000).events;
    return { ...f, gateway, context, media, emitted, queued };
}
