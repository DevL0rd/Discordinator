import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Guild } from 'discord.js';
import { ids } from './fixtures.js';
import { fakeMessage, gate, gatewayHarness, snowflakeId } from './discord-fakes.js';

const role = '900000000000000001';
const minutes = (count: number) => count * 60_000;

async function withClock<T>(offset: number, action: () => Promise<T>): Promise<T> {
    const real = Date.now;
    Date.now = () => real() + offset;
    try {
        return await action();
    } finally {
        Date.now = real;
    }
}

function directMessage(id: string, author: string) {
    return fakeMessage({ id, author: { id: author, bot: false }, guildId: null, content: 'hello there' });
}

function memberLookup(h: ReturnType<typeof gatewayHarness>) {
    const lookups: string[] = [];
    const members = new Map<string, unknown>();
    let pending: Promise<void> = Promise.resolve();
    const guild = {
        id: ids.guild,
        members: {
            fetch: async (userId: string) => {
                lookups.push(userId);
                await pending;
                if (!members.has(userId)) throw new Error('Unknown Member');
                return members.get(userId);
            },
        },
    };
    h.gateway.client.guilds.cache.set(ids.guild, guild as unknown as Guild);
    return {
        lookups,
        members,
        hold: (next: Promise<void>) => {
            pending = next;
        },
    };
}

async function checkRoleLookups(file: string): Promise<void> {
    const h = gatewayHarness(file);
    const lookup = memberLookup(h);
    const [member, stranger] = ['121212121212121212', '131313131313131313'];
    await h.gateway.message(directMessage(snowflakeId(1), member));
    assert.deepEqual(lookup.lookups, [], 'no lookups happen while no roles are approved');
    h.policy.config.allowedRoleIds.push(role);
    lookup.members.set(member, { roles: { cache: new Map([[role, {}]]) } });
    await h.gateway.message(directMessage(snowflakeId(2), member));
    assert.equal(h.queued().at(-1)!.actorId, member, 'a direct message from a member with an approved role is accepted');
    await h.gateway.message(directMessage(snowflakeId(3), member));
    assert.deepEqual(lookup.lookups, [member], 'known members are not looked up again');
    await h.gateway.message(directMessage(snowflakeId(4), stranger));
    await h.gateway.message(directMessage(snowflakeId(5), stranger));
    assert.deepEqual(lookup.lookups, [member, stranger], 'an unknown person is not looked up again for a while');
    assert.notEqual(h.queued().at(-1)!.actorId, stranger);
    await withClock(minutes(11), () => h.gateway.message(directMessage(snowflakeId(6), stranger)));
    assert.deepEqual(lookup.lookups, [member, stranger, stranger], 'the negative cache expires after ten minutes');
    await withClock(minutes(11), () => h.gateway.message(directMessage(snowflakeId(1), member)));
    assert.equal(h.queued().at(-1)!.messageId, snowflakeId(1), 'seen message ids expire too');
    h.gateway.stop();
}

async function checkBackpressure(file: string): Promise<void> {
    const h = gatewayHarness(file);
    h.policy.config.allowedRoleIds.push(role);
    const lookup = memberLookup(h);
    const held = gate();
    lookup.hold(held.promise);
    const inFlight = Array.from({ length: 32 }, (_, index) =>
        h.gateway.message(directMessage(snowflakeId(100 + index), '141414141414141414')),
    );
    await h.gateway.message(directMessage(snowflakeId(200), '141414141414141414'));
    assert.equal(h.gateway.status().droppedMessages, 1, 'a 33rd concurrent message is dropped');
    held.open();
    await Promise.all(inFlight);
    await h.gateway.message(directMessage(snowflakeId(200), '141414141414141414'));
    assert.equal(h.gateway.status().droppedMessages, 1, 'a dropped message can be delivered again once there is room');
    assert.equal(h.media.ingested.length, 33);
    h.gateway.stop();
}

async function checkSeenLimit(file: string): Promise<void> {
    const h = gatewayHarness(file);
    h.policy.config.context.enabled = false;
    h.policy.config.mcpEvents.enabled = false;
    const message = (index: number) => fakeMessage({ id: snowflakeId(index), author: { id: ids.denied, bot: false }, content: 'chat' });
    for (let index = 0; index <= 2000; index++) await h.gateway.message(message(index));
    assert.equal(h.media.ingested.length, 2001);
    await h.gateway.message(message(2000));
    assert.equal(h.media.ingested.length, 2001, 'recent ids are remembered');
    await h.gateway.message(message(0));
    assert.equal(h.media.ingested.length, 2002, 'the oldest id is forgotten once 2000 are remembered');
    h.gateway.stop();
}

export async function checkGatewayLoad(directory: string): Promise<void> {
    await checkRoleLookups(join(directory, 'gateway-roles.json'));
    await checkBackpressure(join(directory, 'gateway-backpressure.json'));
    await checkSeenLimit(join(directory, 'gateway-seen.json'));
}
