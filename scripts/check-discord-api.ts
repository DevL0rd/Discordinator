import assert from 'node:assert/strict';
import { RequestMethod } from 'discord.js';
import { policySchema } from '../src/core/config.js';
import { Policy } from '../src/core/policy.js';
import { UncertainOutcome } from '../src/core/errors.js';
import { DiscordApi, project } from '../src/discord/api.js';
import { ids } from './fixtures.js';

type Options = Record<string, unknown>;

function harness(policy: Policy) {
    const api = new DiscordApi('offline-validation-only', policy);
    const requests: Options[] = [];
    const replies: unknown[] = [];
    Object.defineProperty(api, 'rest', {
        value: {
            request: (options: Options) => {
                requests.push(options);
                const next = replies.shift();
                return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? { ok: true });
            },
        },
    });
    return { api, requests, replies };
}

const failure = (status?: number) => Object.assign(new Error('raw upstream detail'), status === undefined ? {} : { status });
const restrictive = () =>
    new Policy(
        policySchema.parse({
            allowedUserIds: [ids.user],
            servers: { mode: 'allowlist', allowed: [ids.guild] },
            channels: { mode: 'allowlist', allowed: [ids.channel] },
        }),
    );

async function checkRequests(): Promise<void> {
    const { api, requests } = harness(restrictive());
    const files = [{ data: Buffer.from('x'), name: 'a.txt', contentType: 'text/plain' }];
    await api.get('/a', new URLSearchParams({ limit: '1' }));
    await api.get('/b');
    await api.post('/c', { x: 1 });
    await api.postFiles('/d', { y: 2 }, files);
    await api.postFiles('/e', { y: 3 }, []);
    await api.patch('/f', { z: 1 }, 'tidy');
    await api.patch('/g', { z: 2 });
    await api.put('/h');
    await api.put('/i', { w: 1 }, 'why');
    await api.delete('/j', 'gone');
    await api.delete('/k');
    assert.deepEqual(requests, [
        { method: RequestMethod.Get, fullRoute: '/a', query: new URLSearchParams({ limit: '1' }) },
        { method: RequestMethod.Get, fullRoute: '/b' },
        { method: RequestMethod.Post, fullRoute: '/c', body: { x: 1 } },
        { method: RequestMethod.Post, fullRoute: '/d', body: { y: 2 }, files },
        { method: RequestMethod.Post, fullRoute: '/e', body: { y: 3 } },
        { method: RequestMethod.Patch, fullRoute: '/f', body: { z: 1 }, reason: 'tidy' },
        { method: RequestMethod.Patch, fullRoute: '/g', body: { z: 2 } },
        { method: RequestMethod.Put, fullRoute: '/h' },
        { method: RequestMethod.Put, fullRoute: '/i', body: { w: 1 }, reason: 'why' },
        { method: RequestMethod.Delete, fullRoute: '/j', reason: 'gone' },
        { method: RequestMethod.Delete, fullRoute: '/k' },
    ]);
}

async function checkFailures(): Promise<void> {
    const { api, requests, replies } = harness(restrictive());
    replies.push(failure(503), failure(), failure(404));
    await assert.rejects(
        api.get('/a'),
        (error: Error) => error instanceof UncertainOutcome && /\(503\); inspect outcome/.test(error.message),
    );
    await assert.rejects(api.get('/a'), (error: Error) => error instanceof UncertainOutcome && /network\/timeout/.test(error.message));
    await assert.rejects(api.get('/a'), (error: Error) => {
        assert.equal(error instanceof UncertainOutcome, false, 'a 4xx is a definite failure');
        assert.equal(error.message, 'Discord request failed (404)', 'upstream detail is not exposed');
        return true;
    });
    await api.get('/still-fine');
    replies.push(failure(401));
    await assert.rejects(api.get('/a'), /\(401\)/);
    const sent = requests.length;
    await assert.rejects(api.post('/b', {}), /authentication failed; restart/);
    assert.equal(requests.length, sent, 'after a 401 nothing more is sent');
}

async function checkLookups(): Promise<void> {
    const policy = restrictive();
    const { api, replies } = harness(policy);
    const thread = '888888888888888888';
    assert.equal(policy.channelAllowed(thread), false);
    replies.push({ id: thread, type: 11, parent_id: ids.channel, guild_id: ids.guild });
    assert.equal((await api.channel(thread)).id, thread);
    assert.equal(policy.channelAllowed(thread), true, 'a thread inherits its parent channel approval');
    replies.push({ id: ids.other, type: 0, parent_id: ids.channel, guild_id: ids.guild });
    await assert.rejects(api.channel(ids.other), /not approved/, 'a category parent does not approve a plain channel');
    replies.push({ id: ids.channel, type: 1 });
    await assert.rejects(api.channel(ids.channel), /requires a guild channel/);
    replies.push({ id: ids.channel, type: 0, guild_id: ids.other });
    await assert.rejects(api.channel(ids.channel), /Guild is not approved/);
    replies.push({ id: '999999999999999999', type: 12, guild_id: ids.guild });
    await assert.rejects(api.channel('999999999999999999'), /not approved/, 'a thread without a parent is checked by itself');
    api.botId = ids.bot;
    replies.push({ id: ids.message, author: { id: ids.bot } }, { id: ids.message, author: { id: ids.user } });
    assert.equal(((await api.message(ids.channel, ids.message)).author as { id: string }).id, ids.bot);
    assert.equal(((await api.message(ids.channel, ids.message)).author as { id: string }).id, ids.user);
    replies.push({ id: ids.message, author: { id: ids.denied } });
    await assert.rejects(api.message(ids.channel, ids.message), /not whitelisted/);
}

function checkProjection(): void {
    const projected = project({
        id: '1',
        token: 'secret',
        content: 'c'.repeat(5000),
        author: { id: '2', email: 'hidden' },
        count: 3,
        bot: false,
        topic: null,
        description: undefined,
        attachments: Array.from({ length: 150 }, (_, index) => ({ id: String(index) })),
    }) as Record<string, unknown>;
    assert.equal('token' in projected, false, 'unknown fields are dropped');
    assert.equal((projected.content as string).length, 4000);
    assert.deepEqual(projected.author, { id: '2' });
    assert.equal(projected.count, 3);
    assert.equal(projected.bot, false);
    assert.equal(projected.topic, null);
    assert.equal(projected.description, null);
    assert.equal((projected.attachments as unknown[]).length, 100);
    let deep: unknown = 'leaf';
    for (let index = 0; index < 8; index++) deep = { message: deep };
    assert.equal(JSON.stringify(project(deep)), '{"message":{"message":{"message":{"message":{"message":{"message":{"message":null}}}}}}}');
    assert.equal(project(undefined), null);
}

export async function checkDiscordApi(): Promise<void> {
    await checkRequests();
    await checkFailures();
    await checkLookups();
    checkProjection();
}
