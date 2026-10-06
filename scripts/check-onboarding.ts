import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
    needsOnboarding,
    needsPassword,
    onboardingPhase,
    saveAi,
    saveDiscord,
    savePassword,
    validateAi,
    writePhase,
} from '../src/operator/onboarding-store.js';
import { advance, resumed } from '../src/operator/onboarding.js';
import { buttonsFor, type State } from '../src/operator/onboarding-copy.js';
import { readOperatorConfig } from '../src/operator/config.js';
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
        assert.match(
            await validateAi('manual-mcp', '', { environment }),
            /http:\/\/127\.0\.0\.1:\d+\/mcp/,
            'Another MCP app gets its address',
        );
        await assert.rejects(validateAi('chatgpt-events', 'https://bot.example.com'), /just the domain/);
        await checkPassword(environment);
        await checkWizard(directory, { environment, policy, marker });
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

async function checkPassword(environment: string): Promise<void> {
    const oauth = `.data/onboarding-check-${process.pid}`;
    await writeFile(environment, `DISCORDINATOR_OAUTH_DATA_DIR=${oauth}\n`);
    try {
        assert.equal(await needsPassword('claude-session', { environment }), false, 'local responders skip the password');
        assert.equal(await needsPassword('chatgpt-events', { environment }), true, 'ChatGPT - Dot asks for it');
        await writeFile(environment, `DISCORDINATOR_OAUTH_DATA_DIR=${oauth}\nDISCORDINATOR_RESOURCE_URL=https://bot.example.com/mcp\n`);
        assert.equal(await needsPassword('codex-local', { environment }), true, 'a public domain needs it too');
        await savePassword('fixture-password-long', { environment });
        assert.equal(await needsPassword('chatgpt-events', { environment }), false, 'it is asked only once');
    } finally {
        await rm(oauth, { recursive: true, force: true });
    }
}

const step = (patch: Partial<State>): State => ({
    step: 'ai',
    input: '',
    selected: 0,
    draft: { token: '', ownerId: '', channelId: '' },
    ...patch,
});

async function checkWizard(directory: string, files: { environment: string; policy: string; marker: string }): Promise<void> {
    const retried = await advance(step({ step: 'connect', error: 'Install failed.' }), () => undefined);
    assert.equal(retried.step, 'connect', 'Retry stays on the connect step');
    assert.equal(retried.error, undefined, 'Retry clears the error so connecting runs again');
    assert.deepEqual(resumed('verify', 'chatgpt-poll'), { step: 'verify', choice: 'chatgpt-events' }, 'resume restores the choice');
    assert.deepEqual(resumed('ai', 'codex-local'), { step: 'ai' });
    const pending = { label: 'x', ok: false, hint: '' };
    assert.deepEqual(
        buttonsFor(step({ step: 'verify', checks: [{ ...pending, start: true }] })),
        ['Finish'],
        'Finish starts the responder',
    );
    assert.deepEqual(buttonsFor(step({ step: 'verify', checks: [pending, { ...pending, start: true }] })), ['Check again']);
    const previous = process.cwd();
    process.chdir(directory);
    try {
        await writeFile('.env', '');
        const domain = await advance(step({ selected: 2 }), () => undefined);
        assert.equal(domain.step, 'domain', 'ChatGPT - Dot asks for a public domain');
        await assert.rejects(
            advance({ ...domain, input: 'https://bot.example.com' }, () => undefined),
            /just the domain/,
        );
        const password = await advance({ ...domain, input: 'bot.example.com' }, () => undefined);
        assert.equal(password.step, 'password', 'then for the sign-in password');
        await saveAi('chatgpt-events', 'bot.example.com', files);
        const saved = JSON.parse(await readFile(files.policy, 'utf8')) as { mcpEvents: { enabled: boolean } };
        assert.equal(saved.mcpEvents.enabled, true, 'ChatGPT - Dot allows wake-up events');
        assert.match(await readFile(files.environment, 'utf8'), /DISCORDINATOR_RESOURCE_URL="https:\/\/bot\.example\.com\/mcp"/);
        assert.equal((await readOperatorConfig()).enabled, false, 'it starts at the end of setup');
    } finally {
        process.chdir(previous);
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
