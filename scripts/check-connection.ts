import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/core/config.js';
import { HttpServer } from '../src/mcp/http.js';
import { fakeConfig, fixture } from './fixtures.js';

async function localFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const incoming = new Request(input, init);
    assert.equal(new URL(incoming.url).hostname, '127.0.0.1');
    const body = Buffer.from(await incoming.arrayBuffer());
    return new Promise((resolve, reject) => {
        const outgoing = request(
            incoming.url,
            { method: incoming.method, headers: Object.fromEntries(incoming.headers), signal: incoming.signal },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('error', reject);
                response.on('end', () => {
                    const headers = new Headers();
                    for (let i = 0; i < response.rawHeaders.length; i += 2)
                        headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
                    resolve(
                        new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode, headers }),
                    );
                });
            },
        );
        outgoing.on('error', reject);
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Offline HTTP request timed out')));
        outgoing.end(body);
    });
}

async function checkDefaults(directory: string): Promise<void> {
    const file = `${directory}/connection-policy.json`;
    await writeFile(file, '{}');
    const env = { DISCORD_BOT_TOKEN: 'synthetic-discord-fixture', DISCORDINATOR_POLICY_FILE: file };
    await assert.rejects(() => loadConfig(env));
    const bearer = { ...env, DISCORDINATOR_MCP_TOKEN: fakeConfig().DISCORDINATOR_MCP_TOKEN };
    const { config, policy } = await loadConfig(bearer);
    assert.equal(config.DISCORDINATOR_AUTH_MODE, 'bearer');
    assert.equal(config.DISCORDINATOR_BIND_HOST, '127.0.0.1');
    assert.equal(config.DISCORDINATOR_PORT, 8787);
    assert.equal(config.DISCORDINATOR_MESSAGE_CONTENT, 'true');
    assert.equal(config.DISCORDINATOR_RESOURCE_URL, 'http://127.0.0.1:8787/mcp');
    assert.deepEqual(policy.allowedUserIds, []);
    assert.equal(
        (await loadConfig({ ...bearer, DISCORDINATOR_PORT: '8788' })).config.DISCORDINATOR_RESOURCE_URL,
        'http://127.0.0.1:8788/mcp',
    );
    for (const invalid of [
        { DISCORDINATOR_BIND_HOST: '0.0.0.0' },
        { DISCORDINATOR_BIND_HOST: '::' },
        { DISCORDINATOR_BIND_HOST: '192.168.1.2' },
        { DISCORDINATOR_AUTH_MODE: 'tunnel' },
        { DISCORDINATOR_AUTH_MODE: 'unsupported-provider-mode' },
        { DISCORDINATOR_PORT: '1023' },
        { DISCORDINATOR_PORT: '65536' },
        { DISCORDINATOR_MCP_TOKEN: 'replace-with-independent-random-secret-locally' },
        { DISCORDINATOR_AUTH_MODE: 'oauth' },
        { DISCORDINATOR_RESOURCE_URL: 'ftp://discordinator.example/mcp' },
    ])
        await assert.rejects(() => loadConfig({ ...bearer, ...invalid }));
    const oauth = {
        ...env,
        DISCORDINATOR_AUTH_MODE: 'oauth',
        DISCORDINATOR_OAUTH_SERVER: 'external',
        DISCORDINATOR_RESOURCE_URL: 'https://discordinator.example/mcp',
        DISCORDINATOR_ALLOWED_HOSTS: 'discordinator.example',
        DISCORDINATOR_OAUTH_ISSUER: 'https://issuer.example',
        DISCORDINATOR_OAUTH_JWKS_URL: 'https://issuer.example/keys',
        DISCORDINATOR_OAUTH_SUBJECTS: 'owner',
    };
    assert.equal((await loadConfig(oauth)).config.DISCORDINATOR_AUTH_MODE, 'oauth');
    for (const invalid of [
        { DISCORDINATOR_RESOURCE_URL: 'http://127.0.0.1:8787/mcp' },
        { DISCORDINATOR_RESOURCE_URL: '' },
        { DISCORDINATOR_OAUTH_ISSUER: 'http://issuer.example' },
        { DISCORDINATOR_OAUTH_JWKS_URL: '' },
        { DISCORDINATOR_OAUTH_SUBJECTS: ' , ' },
    ])
        await assert.rejects(() => loadConfig({ ...oauth, ...invalid }));
}

async function checkDiscovery(url: URL, headers: Record<string, string>): Promise<void> {
    const denied = await localFetch(url, { method: 'POST', headers, body: '{}' });
    assert.equal(denied.status, 401);
    assert.equal(
        denied.headers.get('www-authenticate'),
        'Bearer resource_metadata="https://discordinator.example/.well-known/oauth-protected-resource", scope="discordinator:control"',
    );
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const metadata = await localFetch(new URL(path, url), { headers });
        assert.equal(metadata.status, 200);
        assert.equal(metadata.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await metadata.json(), {
            resource: 'https://discordinator.example/mcp',
            authorization_servers: ['https://issuer.example'],
            scopes_supported: ['discordinator:control'],
            bearer_methods_supported: ['header'],
        });
    }
}

async function checkDenials(url: URL, token: string): Promise<void> {
    const credentials: Record<string, string>[] = [
        { Host: 'discordinator.example', Authorization: 'Bearer invalid.signature.value' },
        { Host: 'discordinator.example', 'X-Forwarded-For': '127.0.0.1', 'X-User-Id': 'owner' },
    ];
    for (const headers of credentials) assert.equal((await localFetch(url, { method: 'POST', headers, body: '{}' })).status, 401);
    const boundaries: Record<string, string>[] = [
        { Host: 'unlisted.example' },
        { Host: 'discordinator.example.evil.example' },
        { Host: 'discordinator.example', Origin: 'https://unlisted.example' },
    ];
    for (const headers of boundaries)
        assert.equal(
            (await localFetch(url, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: '{}' })).status,
            403,
        );
}

async function checkOAuthHttp(directory: string): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'connection', alg: 'RS256' }] });
    const config = {
        ...fakeConfig(),
        DISCORDINATOR_AUTH_MODE: 'oauth' as const,
        DISCORDINATOR_RESOURCE_URL: 'https://discordinator.example/mcp',
        DISCORDINATOR_ALLOWED_HOSTS: 'discordinator.example',
        DISCORDINATOR_ALLOWED_ORIGINS: 'https://client.example',
        DISCORDINATOR_OAUTH_ISSUER: 'https://issuer.example',
        DISCORDINATOR_OAUTH_JWKS_URL: 'https://issuer.example/keys',
        DISCORDINATOR_OAUTH_SUBJECTS: 'owner',
    };
    const f = fixture(`${directory}/oauth-http.json`);
    const http = new HttpServer(config, f.bridge, () => ({ gateway: 'mock' }), undefined, keys);
    const client = new Client({ name: 'oauth-connection-validation', version: '1.0.0' });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    config.DISCORDINATOR_PORT = (http.server.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${config.DISCORDINATOR_PORT}/mcp`);
    try {
        const token = await new SignJWT({ scope: 'discordinator:control' })
            .setProtectedHeader({ alg: 'RS256', kid: 'connection' })
            .setSubject('owner')
            .setIssuer(config.DISCORDINATOR_OAUTH_ISSUER)
            .setAudience(config.DISCORDINATOR_RESOURCE_URL)
            .setIssuedAt()
            .setExpirationTime('1m')
            .sign(privateKey);
        await checkDiscovery(url, { Host: 'discordinator.example' });
        await checkDenials(url, token);
        await client.connect(
            new StreamableHTTPClientTransport(url, {
                fetch: localFetch,
                requestInit: {
                    headers: { Host: 'discordinator.example', Origin: 'https://client.example', Authorization: `Bearer ${token}` },
                },
            }),
        );
        assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'discordinator_status'));
        const status = await client.callTool({ name: 'discordinator_status', arguments: {} });
        assert.equal(status.isError, undefined);
        assert.equal(f.api.calls.length, 0);
    } finally {
        await client.close();
        await http.stop();
    }
}

export async function checkConnection(directory: string): Promise<void> {
    await checkDefaults(directory);
    await checkOAuthHttp(directory);
}
