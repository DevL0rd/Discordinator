import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/core/config.js';
import { Authenticator } from '../src/mcp/auth.js';
import { HttpServer } from '../src/mcp/http.js';
import { fakeConfig, fixture, ids } from './fixtures.js';

async function checkDefaults(directory: string): Promise<void> {
    const previous = process.cwd();
    await writeFile(`${directory}/policy.json`, '{}');
    process.chdir(directory);
    try {
        const env = { DISCORD_BOT_TOKEN: 'synthetic-discord-fixture' };
        const { config, policy } = await loadConfig(env);
        assert.equal(config.DOTBOT_AUTH_MODE, 'tunnel');
        assert.equal(config.DOTBOT_BIND_HOST, '127.0.0.1');
        assert.equal(config.DOTBOT_PORT, 8787);
        assert.equal(config.DOTBOT_POLICY_FILE, 'policy.json');
        assert.equal(config.DOTBOT_MESSAGE_CONTENT, 'true');
        assert.equal(config.DOTBOT_RESOURCE_URL, 'http://127.0.0.1:8787/mcp');
        assert.deepEqual(policy.allowedUserIds, []);
        const custom = await loadConfig({ ...env, DOTBOT_PORT: '9876' });
        assert.equal(custom.config.DOTBOT_RESOURCE_URL, 'http://127.0.0.1:9876/mcp');
        for (const unsafe of [
            { DOTBOT_BIND_HOST: '0.0.0.0' },
            { DOTBOT_BIND_HOST: '::' },
            { DOTBOT_BIND_HOST: '192.168.1.2' },
            { DOTBOT_ALLOWED_HOSTS: 'dotbot.example' },
            { DOTBOT_ALLOWED_ORIGINS: 'https://dotbot.example' },
            { DOTBOT_RESOURCE_URL: 'https://dotbot.example/mcp' },
            { DOTBOT_MCP_TOKEN: 'synthetic-token-that-must-not-be-silently-ignored' },
            { DOTBOT_OAUTH_SUBJECTS: 'owner' },
            { DOTBOT_OAUTH_ISSUER: 'https://issuer.example' },
            { DOTBOT_OAUTH_JWKS_URL: 'https://issuer.example/keys' },
            { DOTBOT_AUTH_MODE: 'bearer' },
            { DOTBOT_AUTH_MODE: 'oauth' },
            { DOTBOT_RESOURCE_URL: 'ftp://dotbot.example/mcp' },
        ])
            await assert.rejects(() => loadConfig({ ...env, ...unsafe }));
        const bearer = await loadConfig({
            ...env,
            DOTBOT_AUTH_MODE: 'bearer',
            DOTBOT_MCP_TOKEN: 'local-validation-fixture-bearer-credential',
        });
        assert.equal(bearer.config.DOTBOT_AUTH_MODE, 'bearer');
        const oauth = {
            ...env,
            DOTBOT_AUTH_MODE: 'oauth',
            DOTBOT_OAUTH_ISSUER: 'https://issuer.example',
            DOTBOT_OAUTH_JWKS_URL: 'https://issuer.example/keys',
            DOTBOT_OAUTH_SUBJECTS: 'owner',
        };
        await assert.rejects(() => loadConfig({ ...oauth, DOTBOT_RESOURCE_URL: 'http://127.0.0.1:8787/mcp' }));
        assert.equal((await loadConfig({ ...oauth, DOTBOT_RESOURCE_URL: 'https://dotbot.example/mcp' })).config.DOTBOT_AUTH_MODE, 'oauth');
    } finally {
        process.chdir(previous);
    }
}

async function checkPeers(): Promise<void> {
    const config = { ...fakeConfig(), DOTBOT_AUTH_MODE: 'tunnel' as const, DOTBOT_MCP_TOKEN: undefined };
    const auth = new Authenticator(config);
    const request = (remoteAddress?: string, localAddress = '127.0.0.1') =>
        ({ socket: { remoteAddress, localAddress }, headers: { host: '127.0.0.1:8787' } }) as IncomingMessage;
    const principal = await auth.authenticate(request('127.0.0.1'));
    assert.ok(principal && auth.ownerAllowed(principal.id));
    assert.equal(auth.ownerAllowed('oauth:owner'), false);
    assert.equal(auth.ownerAllowed('bearer:owner'), false);
    for (const address of [undefined, '192.168.1.2', '203.0.113.4', '::1', '::ffff:127.0.0.1']) {
        assert.equal(await auth.authenticate(request(address)), null);
    }
    assert.equal(await auth.authenticate(request('127.0.0.1', '192.168.1.2')), null);
    assert.throws(() => new Authenticator({ ...config, DOTBOT_ALLOWED_HOSTS: 'public.example' }));
}

async function checkTunnelHttp(directory: string): Promise<void> {
    const f = fixture(`${directory}/tunnel-journal.json`);
    const config = { ...fakeConfig(), DOTBOT_AUTH_MODE: 'tunnel' as const, DOTBOT_MCP_TOKEN: undefined };
    const http = new HttpServer(config, f.bridge, () => ({ gateway: 'mock' }));
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    config.DOTBOT_PORT = (http.server.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${config.DOTBOT_PORT}/mcp`);
    const client = new Client({ name: 'tunnel-validation', version: '1.0.0' });
    try {
        await checkProxyDenials(http, url);
        await client.connect(new StreamableHTTPClientTransport(url));
        assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'dotbot_status'));
        const send = (eventId: string, idempotencyKey: string) =>
            client.callTool({ name: 'discord_respond', arguments: { eventId, idempotencyKey, content: 'offline tunnel response' } });
        const denied = f.queue.add('tunnel-denied', { ...f.event, actorId: ids.denied })!;
        assert.equal((await send(denied.id, 'denied-tunnel-response')).isError, true);
        assert.equal(f.api.calls.length, 0);
        assert.equal((await send(f.event.id, 'allowed-tunnel-response')).isError, undefined);
        assert.equal(f.api.calls.length, 1);
        const preview = await client.callTool({
            name: 'discord_message_delete',
            arguments: { eventId: f.event.id, channelId: ids.channel, messageId: ids.message, idempotencyKey: 'tunnel-delete' },
        });
        const result = JSON.parse((preview.content as { text: string }[])[0]!.text);
        assert.ok(result.approvalId);
        assert.equal(f.api.calls.length, 1);
    } finally {
        await client.close();
        await http.stop();
    }
}

async function checkProxyDenials(http: HttpServer, url: URL): Promise<void> {
    const deniedHeaders: Record<string, string>[] = [
        { Host: 'public.example' },
        { Host: `127.0.0.1:${url.port}.evil.example` },
        { Origin: `http://127.0.0.1:${url.port}` },
        { Origin: '' },
        { Forwarded: 'for=203.0.113.4;host=public.example' },
        { 'X-Forwarded-For': '127.0.0.1' },
        { 'X-Forwarded-Host': 'localhost' },
        { 'X-Forwarded-Proto': 'https' },
        { 'X-Real-IP': '127.0.0.1' },
        { Via: '1.1 proxy' },
        { 'CF-Connecting-IP': '203.0.113.4' },
    ];
    for (const headers of deniedHeaders) assert.equal(await httpStatus(url, headers), 403, JSON.stringify(headers));
    assert.equal(await httpStatus(url, { Host: `localhost:${url.port}` }, 'GET'), 405);
    const address = http.server.address;
    http.server.address = () => ({ address: '0.0.0.0', family: 'IPv4', port: Number(url.port) });
    try {
        assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
    } finally {
        http.server.address = address;
    }
}

function httpStatus(url: URL, headers: Record<string, string>, method = 'POST'): Promise<number> {
    return new Promise((resolve, reject) => {
        const outgoing = request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (incoming) => {
            incoming.resume();
            incoming.on('end', () => resolve(incoming.statusCode!));
        });
        outgoing.on('error', reject);
        outgoing.end(method === 'GET' ? undefined : '{}');
    });
}

export async function checkTunnel(directory: string): Promise<void> {
    await checkDefaults(directory);
    await checkPeers();
    await checkTunnelHttp(directory);
}
