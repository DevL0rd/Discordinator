import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ReplyOrigins } from '../src/core/reply-origins.js';
import { EventQueue } from '../src/core/queue.js';
import { Gateway } from '../src/discord/gateway.js';
import { fakeConfig, ids } from './fixtures.js';
import { createdAt, fakeMessage, gatewayHarness, namedIds } from './discord-fakes.js';

const id = namedIds();
const role = '900000000000000001';
const botRole = '900000000000000002';
const thread = '888888888888888888';

async function checkAddressedThread(file: string): Promise<void> {
    const h = gatewayHarness(file);
    h.policy.config.allowedRoleIds.push(role);
    h.policy.config.channels = { mode: 'allowlist', allowed: [ids.channel], blocked: [] };
    const attachment = { id: 'a1', name: 'cat.png', size: 10, contentType: null, url: 'https://cdn.example/cat.png', width: 4, height: 3 };
    await h.gateway.message(
        fakeMessage({
            id: id('thread-message'),
            author: { id: ids.denied, bot: false },
            content: 'Discordinator look',
            channelId: thread,
            channel: { isThread: () => true, parentId: ids.channel },
            member: { roles: { cache: new Map([[role, {}]]) } },
            attachments: new Map([['a1', attachment]]),
            reference: { messageId: ids.other },
        }),
    );
    assert.equal(h.policy.channelAllowed(thread), true, 'the thread parent is learned from the message');
    assert.equal(h.policy.userAllowed(ids.denied), true, 'member roles are learned from the message');
    const event = h.queued().at(-1)!;
    assert.deepEqual([event.actorId, event.channelId, event.text], [ids.denied, thread, 'Discordinator look']);
    assert.deepEqual(h.media.ingested, [
        [
            {
                id: id('thread-message'),
                channel_id: thread,
                author: { id: ids.denied },
                timestamp: new Date(createdAt).toISOString(),
                attachments: [
                    { id: 'a1', filename: 'cat.png', size: 10, content_type: undefined, url: attachment.url, width: 4, height: 3 },
                ],
            },
            ids.guild,
            true,
        ],
    ]);
    const [observed, addressed] = h.context.ingested[0]!;
    assert.equal(addressed, true);
    assert.deepEqual([observed.parentId, observed.replyToId, observed.contentAvailable], [ids.channel, ids.other, true]);
    assert.equal(h.emitted.length, 1);
    assert.equal(h.emitted[0]![0].trigger_event_id, event.id);
    assert.equal(h.emitted[0]![0].addressed, true);
    h.gateway.stop();
}

async function checkUndelivered(file: string): Promise<void> {
    const h = gatewayHarness(file);
    await h.gateway.message(fakeMessage({ id: id('from-bot'), author: { id: ids.user, bot: true } }));
    await h.gateway.message(fakeMessage({ id: id('from-webhook'), webhookId: ids.other }));
    assert.deepEqual(
        h.context.ingested.map(([observed, addressed]) => [observed.messageId, observed.authorBot, addressed]),
        [
            [id('from-bot'), true, true],
            [id('from-webhook'), false, false],
        ],
        'an approved bot triggers like an approved person; webhooks are observed but never trigger',
    );
    assert.equal(h.emitted.length, 1, 'other bots are delivered as MCP events; webhooks are not');
    h.policy.config.channels.blocked.push(ids.other);
    await h.gateway.message(fakeMessage({ id: id('blocked'), author: { id: ids.denied, bot: false }, channelId: ids.other }));
    assert.equal(h.context.ingested.length, 2, 'messages in blocked channels are not observed');
    assert.equal(h.media.ingested.at(-1)![2], false, 'unaddressed attachments are still offered to the media index');
    h.policy.config.context.enabled = false;
    h.policy.config.mcpEvents.enabled = false;
    await h.gateway.message(fakeMessage({ id: id('quiet'), content: 'ordinary chat' }));
    assert.equal(h.context.ingested.length, 2, 'nothing is observed while context and MCP events are off');
    h.policy.config.context.enabled = true;
    h.media.fail = true;
    await h.gateway.message(fakeMessage({ id: id('media-fails'), content: 'still chat' }));
    assert.equal(h.context.ingested.at(-1)![0].messageId, id('media-fails'), 'a media index failure does not stop observation');
    const before = h.context.ingested.length;
    await h.gateway.message(fakeMessage({ id: id('media-fails'), content: 'still chat' }));
    assert.equal(h.context.ingested.length, before, 'a repeated message id is ignored');
    h.gateway.stop();
}

async function checkRoleMention(file: string): Promise<void> {
    const h = gatewayHarness(file);
    const me = { roles: { botRole: { id: botRole } } };
    await h.gateway.message(
        fakeMessage({
            id: id('role-mention'),
            content: 'hello there',
            guild: { members: { me } },
            mentions: { roles: new Map([[botRole, {}]]) },
        }),
    );
    assert.equal(h.queued().at(-1)!.messageId, id('role-mention'), 'a bot role mention addresses the bot');
    h.gateway.stop();
}

async function checkAddressing(file: string): Promise<void> {
    const h = gatewayHarness(file);
    const count = () => h.queued().length;
    const start = count();
    const me = { roles: { botRole: { id: botRole } } };
    await h.gateway.message(
        fakeMessage({ id: id('role-elsewhere'), content: 'hi', guild: { members: { me } }, mentions: { roles: new Map() } }),
    );
    await h.gateway.message(fakeMessage({ id: id('no-guild-cache'), content: 'hi', guild: null }));
    assert.equal(count(), start, 'an unrelated role mention or plain chat does not address the bot');
    const reference = { messageId: ids.other, channelId: ids.channel, guildId: ids.guild };
    let fetched = 0;
    const fetchReference = () => {
        fetched++;
        return Promise.resolve({ id: ids.other, channelId: ids.channel, guildId: ids.guild, author: { id: ids.bot } });
    };
    const foreign = { ...reference, guildId: ids.other };
    await h.gateway.message(fakeMessage({ id: id('foreign-reply'), content: 'thanks', reference: foreign, fetchReference }));
    const crossChannel = { ...reference, channelId: ids.other };
    await h.gateway.message(fakeMessage({ id: id('cross-reply'), content: 'thanks', reference: crossChannel, fetchReference }));
    assert.deepEqual([count(), fetched], [start, 0], 'references into another server or channel are never followed');
    const local = { messageId: ids.other, channelId: ids.channel };
    await h.gateway.message(fakeMessage({ id: id('local-reply'), content: 'thanks', reference: local, fetchReference }));
    assert.deepEqual([count(), fetched], [start + 1, 1], 'a reply to the bot without a guild in its reference addresses it');
    h.policy.config.triggers.replyToBot = false;
    await h.gateway.message(fakeMessage({ id: id('reply-off'), content: 'thanks', reference, fetchReference }));
    assert.deepEqual([count(), fetched], [start + 1, 1], 'replies do not address the bot when that trigger is off');
    h.gateway.stop();
}

async function checkReplyOrigins(directory: string): Promise<void> {
    const origins = new ReplyOrigins(join(directory, 'gateway-origins.json'));
    const first = gatewayHarness(join(directory, 'gateway-origins-a.json'), { replyOrigins: origins });
    await first.gateway.message(fakeMessage({ id: id('captured') }));
    const event = first.queued().at(-1)!;
    assert.equal(origins.context(event.id).messageId, id('captured'), 'triggers are recorded as durable reply origins');
    const second = new Gateway(fakeConfig(), first.policy, new EventQueue(), first.api, { replyOrigins: origins });
    await second.message(fakeMessage({ id: id('captured') }));
    assert.equal(second.queue.snapshot(0, 25).events.length, 0, 'an already captured request is not captured again');
    const shared = gatewayHarness(join(directory, 'gateway-origins-b.json'));
    const twin = new Gateway(fakeConfig(), shared.policy, shared.queue, shared.api, { context: shared.gateway.context });
    await shared.gateway.message(fakeMessage({ id: id('twice') }));
    await twin.message(fakeMessage({ id: id('twice') }));
    assert.deepEqual(
        shared.context.ingested.map(([, addressed]) => addressed),
        [true, false],
        'a queue duplicate is observed without a trigger',
    );
    for (const gateway of [first.gateway, second, shared.gateway, twin]) gateway.stop();
}

export async function checkGatewayMessages(directory: string): Promise<void> {
    await checkAddressedThread(join(directory, 'gateway-thread.json'));
    await checkUndelivered(join(directory, 'gateway-undelivered.json'));
    await checkRoleMention(join(directory, 'gateway-role-mention.json'));
    await checkAddressing(join(directory, 'gateway-addressing.json'));
    await checkReplyOrigins(directory);
}
