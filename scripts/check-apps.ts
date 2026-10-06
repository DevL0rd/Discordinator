import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appState, connectApp, disconnectApp, type CodexDeps } from '../src/operator/connections.js';
import { withoutServers } from '../src/operator/codex-config.js';
import { claudeConnectorLink, connectorStatus } from '../src/operator/web-connectors.js';
import { connectorState, parseMcpList } from '../src/operator/claude-connector.js';

const endpoint = { base: 'http://127.0.0.1:8788', key: 'k'.repeat(43) };

function servers(toml: string): { name: string; transport: { url: string } }[] {
    return [...toml.matchAll(/^\[mcp_servers\.([\w-]+)\]\nurl = "([^"]+)"/gm)].map((match) => ({
        name: match[1]!,
        transport: { url: match[2]! },
    }));
}

function fakeCodex(home: string): CodexDeps {
    return {
        home: () => Promise.resolve(home),
        endpoint: () => Promise.resolve(endpoint),
        runner: () => Promise.reject(new Error('unused')),
        codex: async (args) => (args[1] === 'list' ? JSON.stringify(servers(await readFile(join(home, 'config.toml'), 'utf8'))) : ''),
    };
}

const legacyConfig =
    'model = "x"\n\n[mcp_servers.other]\nurl = "https://other.example.com/mcp"\n\n[mcp_servers.dotbot]\nurl = "https://old.example.com/mcp"\n\n[mcp_servers.discordinator]\nurl = "https://bot.example.com/mcp"\n\n[mcp_servers.discordinator.env]\nX = "1"\n';

async function checkCodex(directory: string): Promise<void> {
    const home = join(directory, 'codex-home');
    const deps = fakeCodex(home);
    const previous = process.cwd();
    process.chdir(directory);
    try {
        await mkdir(home, { recursive: true });
        await writeFile(join(home, 'config.toml'), legacyConfig);
        assert.equal((await appState('codex', deps)).status, 'Needs reconnect');
        assert.match(await connectApp('codex', deps), /No sign-in needed/);
        const toml = await readFile(join(home, 'config.toml'), 'utf8');
        assert.equal((await appState('codex', deps)).connected, true, 'connected to the local endpoint');
        assert.match(toml, /\[mcp_servers\.other\]\nurl = "https:\/\/other\.example\.com\/mcp"/, 'unrelated servers are kept');
        assert.doesNotMatch(toml, /mcp_servers\.dotbot|discordinator\.env|bot\.example\.com/, 'stale and legacy entries are replaced');
        assert.match(toml, /http_headers = \{ Authorization = "Bearer k{43}" \}/);
        assert.match(await disconnectApp('codex', deps), /disconnected/);
        assert.equal((await appState('codex', deps)).status, 'Not connected');
        assert.match(await readFile(join(home, 'config.toml'), 'utf8'), /mcp_servers\.other/);
        const missing: CodexDeps = { ...deps, codex: () => Promise.reject(new Error('ENOENT')) };
        assert.equal((await appState('codex', missing)).cli, false);
        await assert.rejects(connectApp('codex', missing), /ENOENT/);
    } finally {
        process.chdir(previous);
    }
}

function checkTables(): void {
    const toml = '[a]\nx = 1\n[mcp_servers."discordinator"]\nurl = "u"\n[mcp_servers.discordinator.headers]\nA = "b"\n[b]\ny = 2';
    assert.equal(withoutServers(toml, ['discordinator']), '[a]\nx = 1\n[b]\ny = 2', 'quoted tables and sub-tables are removed');
}

export async function checkApps(): Promise<void> {
    const link = new URL(claudeConnectorLink('https://bot.example.com/mcp'));
    assert.equal(link.searchParams.get('connectorUrl'), 'https://bot.example.com/mcp');
    assert.equal(link.searchParams.get('modal'), 'add-custom-connector');
    assert.equal(connectorStatus(undefined, 'https://a.example/mcp').current, false);
    assert.equal(connectorStatus('https://a.example/mcp', 'https://a.example/mcp').current, true);
    assert.match(
        connectorStatus('https://a.example/mcp', 'https://b.example/mcp').text,
        /changed/,
        'a new public address flags web connectors',
    );
    const listed = parseMcpList(
        [
            'Checking MCP server health…',
            '',
            'claude.ai Discordinator: https://a.example/mcp - ✔ Connected',
            'claude.ai Docs: https://docs.example/mcp - ! Needs authentication',
            'discordinator: https://a.example/mcp (HTTP) - ✔ Connected',
        ].join('\n'),
    );
    assert.equal(listed.length, 3);
    assert.equal(connectorState(listed, 'https://a.example/mcp'), 'connected');
    assert.equal(connectorState(listed, 'https://b.example/mcp'), 'moved', 'an old connector address is reported');
    assert.equal(connectorState(listed.slice(1), 'https://a.example/mcp'), 'missing', 'a local entry is not the claude.ai connector');
    assert.equal(
        connectorState(parseMcpList('claude.ai Discordinator: https://a.example/mcp - ! Needs authentication'), 'https://a.example/mcp'),
        'needs-sign-in',
    );
    const directory = await mkdtemp(join(tmpdir(), 'discordinator-apps-'));
    try {
        checkTables();
        await checkCodex(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
