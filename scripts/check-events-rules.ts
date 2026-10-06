import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ProtocolError } from '@modelcontextprotocol/server';
import { EventAccess } from '../src/events/access.js';
import { filtersSchema, interactionPayload, matches, payload, secretSchema } from '../src/events/schema.js';
import { Verifier } from '../src/events/security.js';
import type { CallbackSender } from '../src/events/https.js';
import { fixture, ids } from './fixtures.js';
import { observed } from './check-context.js';

const owner = { id: 'rules-owner' };
const filters = (value: Record<string, unknown>) => filtersSchema.parse(value);

function checkAccess(directory: string): void {
    const f = fixture(join(directory, 'events-rules.json'));
    f.policy.config.scopes.push('messages.read');
    f.policy.config.mcpEvents = { enabled: false, allowAllMessages: false };
    let now = 1000;
    const access = new EventAccess(
        f.policy,
        (id) => id === owner.id,
        () => now,
    );
    assert.throws(() => access.authorize(owner, filters({})), /Events disabled/);
    f.policy.config.mcpEvents.enabled = true;
    const users = f.policy.config.allowedUserIds;
    f.policy.config.allowedUserIds = [];
    assert.throws(() => access.authorize(owner, filters({})), /Events disabled/, 'Events need at least one approved person');
    f.policy.config.allowedUserIds = users;
    access.authorize(owner, filters({ guild_id: ids.guild, user_id: ids.user }));
    assert.throws(() => access.authorize(owner, filters({ user_id: ids.denied })), /whitelisted/);
    f.policy.config.mcpEvents.allowAllMessages = true;
    access.authorize(owner, filters({ delivery: 'all', user_id: ids.denied }));
    f.policy.config.mcpEvents.allowAllMessages = false;
    f.policy.config.servers = { mode: 'allowlist', allowed: [], blocked: [] };
    assert.throws(() => access.authorize(owner, filters({ guild_id: ids.guild })));
    f.policy.config.servers = { mode: 'blocklist', allowed: [], blocked: [] };
    assert.throws(() => access.authorize({ id: owner.id, expiresAt: 1000 }, filters({})), /credential expired/);
    now = 999;
    access.authorize({ id: owner.id, expiresAt: 1000 }, filters({}));
    assert.throws(() => access.authorize({ id: 'stranger' }, filters({})), ProtocolError);
}

function checkSchema(): void {
    assert.equal(secretSchema.safeParse(`whsec_${Buffer.alloc(16, 1).toString('base64')}`).success, false, 'Short secrets are refused');
    assert.equal(secretSchema.safeParse(`secret_${Buffer.alloc(32, 1).toString('base64')}`).success, false);
    const data = payload(observed(), null);
    assert.equal(matches(filters({ delivery: 'all', guild_id: ids.other }), data), false);
    assert.equal(matches(filters({ delivery: 'all', user_id: ids.denied }), data), false);
    assert.equal(matches(filters({ delivery: 'all', guild_id: ids.guild, channel_id: ids.channel, user_id: ids.user }), data), true);
    const event = {
        actorId: ids.user,
        channelId: ids.channel,
        guildId: ids.guild,
        kind: 'interaction' as const,
        name: 'discordinator.control',
        text: 'picked',
        id: crypto.randomUUID(),
        cursor: 1,
        receivedAt: new Date().toISOString(),
    };
    const source = crypto.randomUUID();
    assert.equal(interactionPayload({ ...event, sourceEventId: source }, ids.message).sourceEventId, source);
    assert.equal(interactionPayload(event, ids.message).sourceEventId, null);
}

async function checkVerifier(): Promise<void> {
    const url = (index: number) => `https://receiver.example/${index}`;
    const secret = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
    let calls = 0;
    const echo: CallbackSender = (_url, body) => {
        calls++;
        return Promise.resolve({ status: 200, body: JSON.stringify({ challenge: (JSON.parse(body) as { challenge: string }).challenge }) });
    };
    const verifier = new Verifier(echo);
    for (let index = 0; index <= 100; index++) await verifier.verify(owner.id, { id: `sub_${index}`, url: url(index), secret });
    await verifier.verify(owner.id, { id: 'sub_100', url: url(100), secret });
    assert.equal(calls, 101, 'Recent verifications are cached');
    await verifier.verify(owner.id, { id: 'sub_0', url: url(0), secret });
    assert.equal(calls, 102, 'The cache holds at most 100 endpoints');
    const reason = (sender: CallbackSender) =>
        new Verifier(sender).verify(owner.id, { id: 'sub_x', url: url(1), secret }).then(
            () => 'verified',
            (error: ProtocolError) => (error.data as { reason: string }).reason,
        );
    assert.equal(await reason(() => Promise.resolve({ status: 200, body: '{"challenge":5}' })), 'challenge_failed');
    assert.equal(await reason(() => Promise.reject(new Error('socket closed'))), 'challenge_failed');
}

export async function checkEventsRules(directory: string): Promise<void> {
    checkAccess(directory);
    checkSchema();
    await checkVerifier();
}
