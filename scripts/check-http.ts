import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { Authenticator } from '../src/mcp/auth.js';
import { EventsService } from '../src/events/service.js';
import { SubscriptionStore } from '../src/events/store.js';
import { HttpServer } from '../src/mcp/http.js';
import { fakeConfig, fixture } from './fixtures.js';
import { operations } from '../src/discord/catalog.js';

async function denialChecks(url: string, token: string): Promise<void> {
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://unapproved.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
  const oversized = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: ' '.repeat(512_001) });
  assert.equal(oversized.status, 400);
}

export async function checkHttp(directory: string): Promise<void> {
  const f = fixture(`${directory}/http.json`);
  const config = fakeConfig();
  f.policy.config.scopes.push('messages.read');
  f.policy.config.mcpEvents.enabled = true;
  const service = new EventsService(new SubscriptionStore(`${directory}/http-subscriptions.json`), f.policy,
    new Authenticator(config).ownerAllowed, async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
  const http = new HttpServer(config, f.bridge, () => ({ gateway: 'mock' }), service);
  await new Promise<void>(resolve => http.server.listen(0, '127.0.0.1', resolve));
  config.DOTBOT_PORT = (http.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${config.DOTBOT_PORT}/mcp`;
  const client = new Client({ name: 'local-validation', version: '1.0.0' });
  try {
    await denialChecks(url, config.DOTBOT_MCP_TOKEN!);
    await checkEventMethods(url, config.DOTBOT_MCP_TOKEN!);
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${config.DOTBOT_MCP_TOKEN}` } } });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, operations.length + 17);
    for (const name of ['media_search', 'media_history', 'media_attachment_read', 'media_upload_begin', 'discord_media_reply', 'discord_prompt']) {
      assert.ok(listed.tools.some(tool => tool.name === name));
    }
    const blockedMedia = await client.callTool({ name: 'media_search', arguments: { eventId: f.event.id, url: 'https://127.0.0.1/private' } });
    assert.equal(blockedMedia.isError, true);
    const blockedPrompt = await client.callTool({ name: 'discord_prompt', arguments: { eventId: f.event.id, idempotencyKey: 'blocked-prompt',
      content: 'Choose', mode: 'buttons', options: [{ key: 'a', label: 'A' }], actorId: 'forged' } });
    assert.equal(blockedPrompt.isError, true);
    const polled = await client.callTool({ name: 'events_poll', arguments: { after: 0, waitMs: 0 } });
    assert.equal(polled.isError, undefined);
    const page = JSON.parse((polled.content as { text: string }[])[0]!.text);
    assert.equal(page.events.length, 1);
    const denied = await client.callTool({ name: 'discord_respond', arguments: { eventId: f.event.id, content: 'hello', idempotencyKey: 'http-response-key', actorId: 'spoof' } });
    assert.equal(denied.isError, true);
    assert.equal(f.api.calls.length, 0);
    const sent = await client.callTool({ name: 'discord_respond', arguments: { eventId: f.event.id, content: 'hello', idempotencyKey: 'http-response-key' } });
    assert.equal(sent.isError, undefined);
    assert.equal(f.api.calls.length, 1);
  } finally {
    await client.close(); await http.stop();
  }
}

async function checkEventMethods(url: string, token: string): Promise<void> {
  const call = async (method: string, params = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
        [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {},
        [CLIENT_INFO_META_KEY]: { name: 'offline-events-check', version: '1.0.0' } } } }) });
    return response.json() as Promise<{ result?: Record<string, any>; error?: { code: number } }>;
  };
  const discovery = await call('server/discover');
  assert.equal(discovery.result?.resultType, 'complete');
  assert.deepEqual(discovery.result?.supportedVersions, ['2026-07-28']);
  assert.ok(discovery.result?.capabilities.events);
  const listed = await call('events/list');
  assert.equal(listed.result?.events[0].name, 'discord.message.created');
  const input = { name: 'discord.message.created', arguments: { delivery: 'addressed' },
    delivery: { mode: 'webhook', url: 'https://receiver.example/callback',
      secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` }, cursor: null };
  const subscribed = await call('events/subscribe', input);
  assert.ok(subscribed.result?.id);
  const stopped = await call('events/unsubscribe', { name: input.name, arguments: input.arguments,
    delivery: { mode: input.delivery.mode, url: input.delivery.url } });
  assert.equal(stopped.error, undefined);
  assert.equal(stopped.result?.resultType, 'complete');
  const invalid = await call('events/subscribe', { ...input, arguments: { delivery: 'all' } });
  assert.ok(invalid.error);
}
