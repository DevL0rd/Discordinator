import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultOperatorConfig, operatorSchema } from '../src/operator/config.js';
import { validateEffort, type ProviderModels } from '../src/operator/providers.js';
import { readPanel, applyDraft, persistentWorkBlock } from '../src/operator/panel-store.js';
import { editSetting, settings } from '../src/operator/settings-registry.js';
import { settingsList, settingsUpdate } from '../src/mcp/settings.js';
import { disconnectAffected } from '../src/operator/reconnect.js';
import { csv, envSchema, validateAuth } from '../src/core/config.js';
import { domainError, editPublicDomain, publicDomain, publicDomainBlock } from '../src/operator/connection-domain.js';

const noReconnect = () => Promise.resolve('');

function checkDomain(): void {
    const external = {
        DISCORDINATOR_RESOURCE_URL: 'https://old.example/mcp',
        DISCORDINATOR_AUTH_MODE: 'oauth',
        DISCORDINATOR_OAUTH_SERVER: 'external',
        DISCORDINATOR_OAUTH_ISSUER: 'https://identity.example',
        DISCORDINATOR_ALLOWED_HOSTS: 'old.example,extra.example',
    };
    const changed = editPublicDomain(external, 'new.example');
    assert.equal(changed.DISCORDINATOR_RESOURCE_URL, 'https://new.example/mcp');
    assert.equal(changed.DISCORDINATOR_OAUTH_ISSUER, external.DISCORDINATOR_OAUTH_ISSUER, 'an external provider is left alone');
    const derived = envSchema.parse({
        DISCORD_BOT_TOKEN: 'x',
        DISCORDINATOR_RESOURCE_URL: 'https://new.example/mcp',
        DISCORDINATOR_AUTH_MODE: 'oauth',
        DISCORDINATOR_TRUSTED_PROXIES: '127.0.0.1',
    });
    validateAuth(derived);
    assert.equal(derived.DISCORDINATOR_OAUTH_ISSUER, 'https://new.example', 'the issuer is the public domain');
    assert.equal(derived.DISCORDINATOR_OAUTH_JWKS_URL, 'https://new.example/oauth/jwks');
    assert.ok(csv(derived.DISCORDINATOR_ALLOWED_HOSTS).includes('new.example'), 'the public host is allowed automatically');
    assert.ok(csv(derived.DISCORDINATOR_ALLOWED_ORIGINS).includes('https://new.example'));
    const fresh = editPublicDomain({ DISCORDINATOR_AUTH_MODE: 'bearer' }, 'new.example');
    assert.equal(fresh.DISCORDINATOR_AUTH_MODE, 'oauth', 'a public domain turns on the built-in sign-in');
    assert.equal(fresh.DISCORDINATOR_OAUTH_SERVER, 'bundled');
    assert.equal(fresh.DISCORDINATOR_TRUSTED_PROXIES, '127.0.0.1,::1');
    assert.throws(() => editPublicDomain(external, 'http://localhost'));
    assert.equal(publicDomain('https://new.example/mcp'), 'new.example', 'domain is displayed without protocol');
    assert.match(publicDomainBlock('chatgpt-events', {})!, /public domain/, 'ChatGPT explains why it needs a public domain');
    assert.equal(publicDomainBlock('chatgpt-events', { DISCORDINATOR_RESOURCE_URL: 'https://new.example/mcp' }), undefined);
    for (const local of ['claude-session', 'codex-local', 'manual-mcp'])
        assert.equal(publicDomainBlock(local, {}), undefined, `${local} works locally`);
    assert.equal(domainError('bot.example.com'), undefined);
    for (const bad of ['https://bot.example.com', 'bot.example.com/mcp', 'localhost', '10.0.0.1', 'not a domain', ''])
        assert.ok(domainError(bad), bad);
}

const modelData: ProviderModels = {
    source: 'fixture',
    observedAt: new Date().toISOString(),
    note: '',
    defaultModel: { id: '', name: 'Default', efforts: ['medium'] },
    models: [{ id: 'fixture-model', name: 'Fixture', efforts: ['high'] }],
};
function checkConfiguration() {
    const config = { ...defaultOperatorConfig(), mode: 'codex-local' as const, codexModel: 'fixture-model', codexEffort: 'high' };
    validateEffort('Codex', config.codexEffort, config.codexModel, modelData);
    assert.throws(() => validateEffort('Codex', 'low', config.codexModel, modelData), /not offered/);
    validateEffort('Claude', 'medium', undefined, modelData);
    assert.throws(() => validateEffort('Claude', 'high', undefined, modelData), /not offered/, 'default model efforts are checked');
    assert.equal(operatorSchema.parse(config).timeoutSeconds, 0);
    for (const mode of ['chatgpt-events', 'chatgpt-poll', 'codex-local', 'claude-session', 'manual-mcp'])
        assert.equal(operatorSchema.parse({ ...config, mode }).mode, mode);
    for (const timeoutSeconds of [1, 29, -1, 1801]) assert.equal(operatorSchema.safeParse({ ...config, timeoutSeconds }).success, false);
    const live = {
        gateway: 'ready',
        events: { subscriptions: 0 },
        operator: {
            mode: 'codex-local',
            appliedConfigAt: config.updatedAt,
            activeEventId: null,
            controller: { busy: 0, approvals: 0, tasks: [{ state: 'recovering' }] },
        },
    };
    assert.match(persistentWorkBlock(live, config.updatedAt) ?? '', /controller work or recovery/);
    live.operator.controller.tasks = [];
    assert.equal(persistentWorkBlock(live, config.updatedAt), undefined);
}
async function checkDraft(): Promise<void> {
    await writeFile('policy.json', '{}');
    await writeFile(
        '.env',
        'DISCORD_BOT_TOKEN=fixture\nDISCORDINATOR_MCP_TOKEN=fixture-credential-at-least-32-characters\nDISCORDINATOR_AUTH_MODE=bearer\nDISCORDINATOR_POLICY_FILE=policy.json\n',
    );
    const snapshot = await readPanel();
    const draft = structuredClone(snapshot.documents);
    draft.operator.mode = 'manual-mcp';
    draft.operator.enabled = false;
    const applied = await applyDraft(snapshot, draft, noReconnect);
    assert.equal(applied.snapshot.documents.operator.mode, 'manual-mcp');
    const combined = structuredClone(applied.snapshot.documents);
    combined.operator.mode = 'chatgpt-events';
    combined.operator.enabled = true;
    combined.environment.DISCORDINATOR_RESOURCE_URL = 'https://fixture.example/mcp';
    const multi = await applyDraft(applied.snapshot, combined, noReconnect);
    assert.equal(multi.snapshot.documents.operator.mode, 'chatgpt-events');
    assert.equal(multi.snapshot.documents.environment.DISCORDINATOR_RESOURCE_URL, 'https://fixture.example/mcp');
    const policyField = settings.find((field) => field.id === 'policy.context.perChannel')!;
    const policyDraft = structuredClone(applied.snapshot.documents);
    policyDraft.policy = editSetting(policyDraft.policy, policyField, 77);
    await writeFile('policy.json', '{"context":{"perChannel":88}}');
    await assert.rejects(applyDraft(applied.snapshot, policyDraft, noReconnect), /changed elsewhere/);
    assert.equal((JSON.parse(await readFile('policy.json', 'utf8')) as { context: { perChannel: number } }).context.perChannel, 88);
}
async function checkReconnect(): Promise<void> {
    const unrelated = [{ id: 'policy.context.reach', label: 'History', before: 'channel', after: 'server', apply: 'live' as const }];
    assert.equal(await disconnectAffected(unrelated), '', 'settings that do not affect connections never touch apps');
}
async function checkSettingsTools(): Promise<void> {
    await checkReconnect();
    await writeFile('policy.json', '{}');
    const listed = await settingsList();
    assert.equal(listed.find((item) => item.id === 'environment.DISCORD_BOT_TOKEN')?.value, 'set', 'secrets are never revealed');
    assert.equal(listed.find((item) => item.id === 'environment.DISCORD_BOT_TOKEN')?.editable, false);
    await assert.rejects(settingsUpdate([{ id: 'environment.DISCORD_BOT_TOKEN', value: 'x' }]), /setup app/);
    await assert.rejects(settingsUpdate([{ id: 'policy.nope', value: 1 }]), /Unknown setting/);
    assert.match(await settingsUpdate([{ id: 'policy.context.reach', value: 'server' }]), /saved/i);
    assert.equal((JSON.parse(await readFile('policy.json', 'utf8')) as { context: { reach: string } }).context.reach, 'server');
}
export async function checkPanel(): Promise<void> {
    checkDomain();
    checkConfiguration();
    const directory = await mkdtemp(join(tmpdir(), 'discordinator-panel-check-'));
    const originalDirectory = process.cwd();
    try {
        process.chdir(directory);
        await checkDraft();
        await checkSettingsTools();
    } finally {
        process.chdir(originalDirectory);
        await rm(directory, { recursive: true, force: true });
    }
}
