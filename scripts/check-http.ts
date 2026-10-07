import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { Authenticator } from '../src/mcp/auth.js';
import { EventsService } from '../src/events/service.js';
import { SubscriptionStore } from '../src/events/store.js';
import { HttpServer } from '../src/mcp/http.js';
import { fakeConfig, fixture, ids } from './fixtures.js';
import { operations } from '../src/discord/catalog.js';
import { serverInstructions } from '../src/mcp/tools.js';

async function denialChecks(url: string, token: string): Promise<void> {
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status, 401);
    assert.equal(
        (
            await fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, Origin: 'https://unapproved.example' },
                body: '{}',
            })
        ).status,
        403,
    );
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
    const oversized = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: ' '.repeat(512_001),
    });
    assert.equal(oversized.status, 413);
    const malformed = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: { code: number } }).error.code, -32700);
}

export async function checkHttp(directory: string): Promise<void> {
    assert.match(serverInstructions, /Everything you send goes through discord_send/);
    assert.match(serverInstructions, /Answer every request from Discord in its own conversation with eventId/);
    assert.match(serverInstructions, /keep the follow-up there unless the requester asks to move it/);
    assert.match(serverInstructions, /Before using any tool, acknowledge in one short line/);
    assert.match(serverInstructions, /through completion or a clear blocker/);
    const f = fixture(`${directory}/http.json`);
    const config = fakeConfig();
    f.policy.config.scopes.push('messages.read');
    f.policy.config.mcpEvents.enabled = true;
    const service = new EventsService(
        new SubscriptionStore(`${directory}/http-subscriptions.json`),
        f.policy,
        new Authenticator(config).ownerAllowed,
        (_url, body) =>
            Promise.resolve({ status: 200, body: JSON.stringify({ challenge: (JSON.parse(body) as { challenge?: string }).challenge }) }),
    );
    const http = new HttpServer(config, f.bridge, () => ({ gateway: 'mock' }), service);
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    config.DISCORDINATOR_PORT = (http.server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${config.DISCORDINATOR_PORT}/mcp`;
    const client = new Client({ name: 'local-validation', version: '1.0.0' });
    const modern = new Client({ name: 'modern-validation', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
        await denialChecks(url, config.DISCORDINATOR_MCP_TOKEN!);
        await checkEventMethods(url, config.DISCORDINATOR_MCP_TOKEN!);
        const transport = new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: `Bearer ${config.DISCORDINATOR_MCP_TOKEN}` } },
        });
        await client.connect(transport);
        await checkToolDescriptors(client);
        await checkToolBoundaries(client, f);
        await checkModern(url, config.DISCORDINATOR_MCP_TOKEN!, modern);
    } finally {
        await modern.close();
        await client.close();
        await http.stop();
    }
}

export const toolCount = () => operations.length + 24;

async function checkToolDescriptors(client: Client): Promise<void> {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, toolCount());
    assert.ok(JSON.stringify(listed).length < 512_000, 'Tool discovery response stays within the response budget');
    assert.equal(new Set(listed.tools.map((entry) => entry.name)).size, listed.tools.length, 'Tool names are unique');
    for (const tool of listed.tools) checkDescriptor(tool);
    for (const name of ['media_search', 'media_history', 'media_attachment_read', 'media_upload_begin', 'discord_send', 'discord_prompt'])
        assert.ok(listed.tools.some((tool) => tool.name === name));
    const upload = listed.tools.find((tool) => tool.name === 'media_upload_begin');
    const fileName = (upload?.inputSchema.properties as Record<string, { pattern?: string }> | undefined)?.fileName;
    assert.equal(fileName?.pattern, undefined, 'Host discovery does not expose Unicode property escapes in file-name patterns');
    checkContextDescriptors(listed.tools);
}
function checkContextDescriptors(tools: Awaited<ReturnType<Client['listTools']>>['tools']): void {
    const shape = (name: string) => {
        const tool = tools.find((entry) => entry.name === name)!;
        return {
            description: tool.description,
            keys: Object.keys(tool.inputSchema.properties ?? {}).sort(),
            required: tool.inputSchema.required,
        };
    };
    const [recent, user, search] = ['context_recent', 'context_user', 'context_search'].map(shape);
    assert.deepEqual(recent!.keys, ['eventId', 'includeParent', 'limit']);
    assert.deepEqual(user!.keys, ['eventId', 'limit'], 'context_user has no ignored parameters');
    assert.deepEqual(search!.keys, ['eventId', 'includeParent', 'limit', 'query']);
    assert.ok(search!.required?.includes('query'), 'context_search requires its query');
    assert.equal(new Set([recent!.description, user!.description, search!.description]).size, 3, 'Each context tool is described');
    const send = tools.find((entry) => entry.name === 'discord_send')!;
    assert.match(JSON.stringify(send.inputSchema), /only the person who asked can be pinged/);
    assert.equal(tools.filter((entry) => /respond|proactive|_dm$|media_reply/.test(entry.name)).length, 0, 'One tool sends everything');
}
function checkDescriptor(tool: Awaited<ReturnType<Client['listTools']>>['tools'][number]): void {
    assert.ok(tool.title?.trim(), `${tool.name} has a human-readable title`);
    assert.ok(tool.description?.trim(), `${tool.name} has a description`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} has an object input schema`);
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} declares readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} declares destructiveHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name} declares openWorldHint`);
}

async function checkToolBoundaries(client: Client, f: ReturnType<typeof fixture>): Promise<void> {
    const blockedMedia = await client.callTool({
        name: 'media_search',
        arguments: { eventId: f.event.id, url: 'https://127.0.0.1/private' },
    });
    assert.equal(blockedMedia.isError, true);
    const blockedPrompt = await client.callTool({
        name: 'discord_prompt',
        arguments: {
            eventId: f.event.id,
            idempotencyKey: 'blocked-prompt',
            content: 'Choose',
            mode: 'buttons',
            options: [{ key: 'a', label: 'A' }],
            actorId: 'forged',
        },
    });
    assert.equal(blockedPrompt.isError, true);
    const polled = await client.callTool({ name: 'events_poll', arguments: { after: 0, waitMs: 0 } });
    assert.equal(polled.isError, undefined);
    const page = JSON.parse((polled.content as { text: string }[])[0]!.text) as { events: unknown[] };
    assert.equal(page.events.length, 1);
    const denied = await client.callTool({
        name: 'discord_send',
        arguments: { eventId: f.event.id, content: 'hello', idempotencyKey: 'http-response-key', actorId: 'spoof' },
    });
    assert.equal(denied.isError, true);
    assert.equal(f.api.calls.length, 0);
    const sent = await client.callTool({
        name: 'discord_send',
        arguments: { eventId: f.event.id, content: 'hello', idempotencyKey: 'http-response-key' },
    });
    assert.equal(sent.isError, undefined);
    assert.equal(f.api.calls.length, 1);
    f.policy.config.media.enabled = true;
    f.policy.config.scopes.push('media.write');
    const remotePath = await client.callTool({
        name: 'discord_send',
        arguments: { channelId: ids.channel, files: [{ path: '/tmp/shot.png' }], idempotencyKey: 'http-remote-path' },
    });
    assert.equal(remotePath.isError, true);
    assert.match(
        (remotePath.content as { text: string }[])[0]!.text,
        /can only be sent from this computer/,
        'Remote clients cannot read local files',
    );
    assert.equal(f.api.calls.length, 1);
}

async function checkModern(url: string, token: string, client: Client): Promise<void> {
    await client.connect(
        new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    assert.ok(client.getDiscoverResult()?.capabilities.tools);
    assert.equal((await client.listTools()).tools.length, toolCount());
}

interface EventResponse {
    result?: {
        resultType?: string;
        supportedVersions?: string[];
        capabilities?: { events?: unknown };
        events?: { name: string; description?: string }[];
        id?: string;
    };
    error?: { code: number };
}
async function eventCall(url: string, token: string, method: string, params = {}): Promise<EventResponse> {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': method,
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params: {
                ...params,
                _meta: {
                    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
                    [CLIENT_CAPABILITIES_META_KEY]: {},
                    [CLIENT_INFO_META_KEY]: { name: 'offline-events-check', version: '1.0.0' },
                },
            },
        }),
    });
    return response.json() as Promise<EventResponse>;
}
async function checkEventMethods(url: string, token: string): Promise<void> {
    await checkEventDiscovery(url, token);
    await checkEventSubscription(url, token);
}
async function checkEventDiscovery(url: string, token: string): Promise<void> {
    const discovery = await eventCall(url, token, 'server/discover');
    checkDiscoveryResponse(discovery);
    checkListedResponse(await eventCall(url, token, 'events/list'));
}
function checkDiscoveryResponse(discovery: EventResponse): void {
    assert.equal(discovery.result?.resultType, 'complete');
    assert.deepEqual(discovery.result?.supportedVersions, ['2026-07-28']);
    assert.ok(discovery.result?.capabilities?.events);
}
function checkListedResponse(listed: EventResponse): void {
    const event = listed.result?.events?.[0];
    assert.equal(event?.name, 'discord.message.created');
    const description = event?.description ?? '';
    assert.match(description, /Answer Discord-origin requests and ordinary follow-ups/);
    assert.match(description, /acknowledge promptly and keep the requester informed/);
}
async function checkEventSubscription(url: string, token: string): Promise<void> {
    const input = {
        name: 'discord.message.created',
        arguments: { delivery: 'addressed' },
        delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` },
        cursor: null,
    };
    const subscribed = await eventCall(url, token, 'events/subscribe', input);
    assert.ok(subscribed.result?.id);
    const stopped = await eventCall(url, token, 'events/unsubscribe', {
        name: input.name,
        arguments: input.arguments,
        delivery: { mode: input.delivery.mode, url: input.delivery.url },
    });
    assert.equal(stopped.error, undefined);
    assert.equal(stopped.result?.resultType, 'complete');
    const invalid = await eventCall(url, token, 'events/subscribe', { ...input, arguments: { delivery: 'everything' } });
    assert.ok(invalid.error, 'Unknown delivery modes are rejected');
}
