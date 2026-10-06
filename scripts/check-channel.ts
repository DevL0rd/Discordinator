import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HttpServer } from '../src/mcp/http.js';
import { localCall } from '../src/mcp/local-client.js';
import { fakeConfig, fixture } from './fixtures.js';

export const key = 'k'.repeat(43);

function statusFor(base: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
        const outgoing = request(`${base}/mcp`, { method: 'POST', headers }, (response) => {
            resolve(response.statusCode ?? 0);
            response.resume();
        });
        outgoing.on('error', reject);
        outgoing.end('{}');
    });
}

export async function localServer(file: string) {
    const f = fixture(file);
    const config = fakeConfig();
    const http = new HttpServer(config, f.bridge, () => ({ gateway: 'mock' }));
    http.attachLocal(key);
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    config.DISCORDINATOR_PORT = (http.server.address() as AddressInfo).port;
    return { f, config, http, base: `http://127.0.0.1:${config.DISCORDINATOR_PORT}` };
}

export async function checkChannel(directory: string): Promise<void> {
    const { http, base } = await localServer(`${directory}/local.json`);
    try {
        const tools = (await localCall({ base, key }, 'tools/list')).tools as { name: string }[];
        assert.ok(
            tools.some((tool) => tool.name === 'discord_respond'),
            'the local key grants the owner tool surface',
        );
        await assert.rejects(localCall({ base, key: 'x'.repeat(43) }, 'tools/list'), /401/, 'a wrong key is refused');
        const tunnel = await statusFor(base, {
            Host: 'dotbot.example',
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
        });
        assert.ok([401, 403].includes(tunnel), 'the local key never works through a public host name');
    } finally {
        await http.stop();
    }
}

async function bridgeLines(child: ChildProcessWithoutNullStreams, count: number): Promise<Record<string, unknown>[]> {
    const lines: Record<string, unknown>[] = [];
    let buffer = '';
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bridge did not answer')), 15_000);
        child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const parts = buffer.split('\n');
            buffer = parts.pop()!;
            for (const part of parts) if (part.trim()) lines.push(JSON.parse(part) as Record<string, unknown>);
            if (lines.length >= count) {
                clearTimeout(timer);
                resolve(lines);
            }
        });
    });
}

export async function checkBridgeProcess(directory: string): Promise<void> {
    const { config, http } = await localServer(`${directory}/bridge.json`);
    const home = join(directory, 'bridge-home');
    await mkdir(join(home, '.data'), { recursive: true });
    await writeFile(join(home, '.env'), `DISCORDINATOR_PORT=${config.DISCORDINATOR_PORT}\n`);
    await writeFile(join(home, '.data/local.key'), `${key}\n`);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/channel/bridge.ts'], {
        env: { ...process.env, DISCORDINATOR_HOME: home, DISCORDINATOR_PORT: String(config.DISCORDINATOR_PORT) },
    });
    try {
        const replies = bridgeLines(child, 2);
        child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
        );
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        const [init, list] = (await replies).sort((a, b) => Number(a.id) - Number(b.id));
        assert.equal((init!.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
        assert.ok(((list!.result as { tools: { name: string }[] }).tools ?? []).some((tool) => tool.name === 'discord_respond'));
    } finally {
        child.kill();
        await http.stop();
    }
}
