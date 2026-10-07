import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { localCall } from '../src/mcp/local-client.js';
import { fixture, ids } from './fixtures.js';
import { key, localServer } from './check-channel.js';

async function legacyOwnerTools(client: Client, f: ReturnType<typeof fixture>): Promise<void> {
    assert.equal(client.getProtocolEra(), 'legacy');
    const sent = await client.callTool({
        name: 'discord_send',
        arguments: { channelId: ids.channel, content: 'Legacy owner update', idempotencyKey: 'legacy-owner-send' },
    });
    assert.equal(sent.isError, undefined, 'Owner-only tools work for authenticated legacy-protocol clients');
    assert.equal(f.api.calls.length, 1);
}

async function separateBudgets(url: string, base: string, client: Client): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt++) assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    const limited = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'Public request budget exhausted' });
    assert.ok((await client.listTools()).tools.length, 'Authenticated remote clients keep their own budget');
    assert.ok(
        ((await localCall({ base, key }, 'tools/list')).tools as unknown[]).length,
        'Local principals are not starved by public traffic',
    );
}

export async function checkHttpBudgets(directory: string): Promise<void> {
    const { f, config, http, base } = await localServer(`${directory}/http-budgets.json`);
    const client = new Client({ name: 'legacy-validation', version: '1.0.0' });
    try {
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${config.DISCORDINATOR_MCP_TOKEN}` } },
            }),
        );
        await legacyOwnerTools(client, f);
        await separateBudgets(`${base}/mcp`, base, client);
    } finally {
        await client.close();
        await http.stop();
    }
}
