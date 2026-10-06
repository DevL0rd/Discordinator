import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { needsOnboarding, onboardingPhase, saveDiscord, validateAi, writePhase } from '../src/operator/onboarding-store.js';
import { probeConnection } from '../src/operator/onboarding-connection.js';
import { migrateEnvironment } from '../src/core/env-migration.js';

export async function checkOnboarding(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'discordinator-onboarding-'));
    const environment = join(directory, '.env');
    const policy = join(directory, 'policy.json');
    const marker = join(directory, 'onboarding.json');
    try {
        assert.equal(await needsOnboarding({}, marker), true);
        assert.equal(await needsOnboarding({ DISCORD_BOT_TOKEN: '' }, marker), true);
        assert.equal(await needsOnboarding({ DISCORD_BOT_TOKEN: 'legacy-configured' }, marker), false);
        await writePhase('ai', marker);
        assert.equal(await onboardingPhase({ DISCORD_BOT_TOKEN: 'configured' }, marker), 'ai');
        assert.equal(await needsOnboarding({ DISCORD_BOT_TOKEN: 'configured' }, marker), true);
        await writePhase('service', marker);
        assert.equal(await onboardingPhase({ DISCORD_BOT_TOKEN: 'configured' }, marker), 'service');
        await writePhase('complete', marker);
        assert.equal(await needsOnboarding({ DISCORD_BOT_TOKEN: 'configured' }, marker), false);
        await writeFile(environment, 'EXISTING_SETTING="preserved"\n');
        await writeFile(policy, JSON.stringify({ context: { enabled: true }, scopes: ['reactions.write'] }));
        await saveDiscord(
            { token: 'fixture-token', ownerId: '1022779807186042890', channelId: '1303345542121656363' },
            { bot: 'Fixture Bot', owner: 'Fixture Owner', channel: 'Fixture Channel', guildId: '947272797628014673' },
            { environment, policy, marker },
        );
        const savedEnvironment = await readFile(environment, 'utf8');
        assert.match(savedEnvironment, /EXISTING_SETTING="preserved"/);
        assert.match(savedEnvironment, /DISCORD_BOT_TOKEN="fixture-token"/);
        assert.match(savedEnvironment, /DISCORDINATOR_MCP_TOKEN=/);
        const savedPolicy = JSON.parse(await readFile(policy, 'utf8')) as {
            context: { enabled: boolean };
            scopes: string[];
            allowedUserIds: string[];
        };
        assert.equal(savedPolicy.context.enabled, true);
        assert.ok(savedPolicy.scopes.includes('reactions.write'));
        assert.ok(savedPolicy.scopes.includes('messages.read'));
        assert.deepEqual(savedPolicy.allowedUserIds, ['1022779807186042890']);
        assert.equal(await onboardingPhase({ DISCORD_BOT_TOKEN: 'fixture-token' }, marker), 'ai');
        assert.match(await validateAi('manual-mcp', 'http://127.0.0.1:8787/mcp'), /Format valid/);
        await assert.rejects(validateAi('manual-mcp', 'http://example.com/mcp'), /public HTTPS or loopback/);
        await assert.rejects(validateAi('manual-mcp', 'bot.example.com/mcp'), /full endpoint URL/);
        await assert.rejects(validateAi('chatgpt-events', 'https://bot.example.com'), /just the domain/);
        assert.match(
            await probeConnection('https://fixture.example/mcp', () => Promise.resolve(new Response('', { status: 401 }))),
            /sign-in is still required/,
        );
        assert.match(
            await probeConnection('https://fixture.example/mcp', () =>
                Promise.resolve(Response.json({ result: { serverInfo: { name: 'Discordinator' } } })),
            ),
            /server reached/,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function checkEnvironmentRename(directory: string): Promise<void> {
    const path = resolve(directory, 'rename.env');
    const previous = process.cwd();
    await writeFile(path, 'DISCORD_BOT_TOKEN="x"\nDOTBOT_PORT="8788"\nDOTBOT_MCP_TOKEN="a"\nDISCORDINATOR_MCP_TOKEN="b"\n');
    process.chdir(resolve(directory));
    try {
        const target: NodeJS.ProcessEnv = {};
        assert.equal(await migrateEnvironment(path, target), 1);
        const text = await readFile(path, 'utf8');
        assert.match(text, /^DISCORDINATOR_PORT="8788"$/m, 'legacy key renamed in place');
        assert.match(text, /^DISCORDINATOR_MCP_TOKEN="b"$/m, 'an existing new key wins');
        assert.equal(target.DISCORDINATOR_PORT, '8788');
        assert.equal(await migrateEnvironment(path, target), 0, 'migration runs once');
    } finally {
        process.chdir(previous);
    }
}
