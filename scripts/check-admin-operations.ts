import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, ids } from './fixtures.js';
import { RecordingApi, expectCalls, operationRunner } from './discord-fakes.js';

const g = ids.guild;
const u = ids.user;
const r = ids.other;
const member = { guildId: g, userId: u };
const hour = 3_600_000;

function setup(file: string) {
    const f = fixture(file);
    const api = new RecordingApi(f.policy);
    return { f, api, run: operationRunner(api, f.policy) };
}

async function checkMembers(file: string): Promise<void> {
    const { api, run } = setup(file);
    await expectCalls(run, api, [
        ['member_get', member, { method: 'GET', route: `/guilds/${g}/members/${u}` }],
        ['members_list', { guildId: g, limit: 50, after: u }, { route: `/guilds/${g}/members`, query: `limit=50&after=${u}` }],
        ['member_nickname', { ...member, nickname: null }, { method: 'PATCH', body: { nick: null } }],
        [
            'member_timeout',
            { ...member, durationSeconds: 0, reason: 'calm' },
            { body: { communication_disabled_until: null }, reason: 'calm' },
        ],
        ['member_kick', { ...member, reason: 'spam' }, { method: 'DELETE', route: `/guilds/${g}/members/${u}`, reason: 'spam' }],
        [
            'member_ban',
            { ...member, reason: 'abuse' },
            { method: 'PUT', route: `/guilds/${g}/bans/${u}`, body: { delete_message_seconds: 0 }, reason: 'abuse' },
        ],
        ['member_unban', { ...member, reason: 'appeal' }, { method: 'DELETE', route: `/guilds/${g}/bans/${u}`, reason: 'appeal' }],
        ['bans_list', { guildId: g }, { route: `/guilds/${g}/bans`, query: 'limit=25' }],
        ['roles_list', { guildId: g }, { route: `/guilds/${g}/roles` }],
        [
            'role_create',
            { guildId: g, name: 'Helpers', hoist: true },
            { method: 'POST', body: { name: 'Helpers', permissions: '0', color: undefined, hoist: true, mentionable: undefined } },
        ],
        [
            'role_edit',
            { guildId: g, roleId: r, permissions: '8', color: 255 },
            {
                route: `/guilds/${g}/roles/${r}`,
                body: { name: undefined, permissions: '8', color: 255, hoist: undefined, mentionable: undefined },
            },
        ],
        ['role_delete', { guildId: g, roleId: r }, { method: 'DELETE', route: `/guilds/${g}/roles/${r}` }],
        [
            'role_position',
            { guildId: g, roleId: r, position: 3 },
            { method: 'PATCH', route: `/guilds/${g}/roles`, body: [{ id: r, position: 3 }] },
        ],
        ['member_role_add', { ...member, roleId: r }, { method: 'PUT', route: `/guilds/${g}/members/${u}/roles/${r}` }],
        ['member_role_remove', { ...member, roleId: r }, { method: 'DELETE', route: `/guilds/${g}/members/${u}/roles/${r}` }],
    ]);
    const before = Date.now();
    await run('member_timeout', { ...member, durationSeconds: 60, reason: 'cool off' });
    const until = Date.parse((api.last()!.body as { communication_disabled_until: string }).communication_disabled_until);
    assert.ok(until >= before + 60_000 && until <= Date.now() + 60_000, 'a timeout ends the requested number of seconds from now');
    await assert.rejects(run('member_kick', member), 'moderation needs a reason');
}

async function checkVoice(file: string): Promise<void> {
    const { api, run } = setup(file);
    await run('voice_member_edit', { ...member, channelId: ids.channel, mute: true });
    assert.deepEqual(
        api.calls.map((call) => call.method),
        ['CHANNEL', 'PATCH'],
    );
    assert.deepEqual(api.last()!.body, { channel_id: ids.channel, mute: true, deaf: undefined });
    await run('voice_member_edit', { ...member, channelId: null, deaf: true });
    assert.deepEqual(api.last()!.body, { channel_id: null, mute: undefined, deaf: true }, 'null disconnects without a lookup');
    assert.equal(api.calls.length, 3);
    api.channelGuild = ids.other;
    await assert.rejects(run('voice_member_edit', { ...member, channelId: ids.channel }), /Voice destination is in another guild/);
    assert.equal(api.calls.length, 4);
}

async function checkGuilds(file: string): Promise<void> {
    const { api, run } = setup(file);
    const app = `/applications/${ids.bot}/guilds/${g}/commands`;
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    await expectCalls(run, api, [
        ['guild_get', { guildId: g }, { route: `/guilds/${g}`, query: 'with_counts=true' }],
        [
            'guild_edit',
            { guildId: g, description: null, verificationLevel: 2 },
            { method: 'PATCH', body: { name: undefined, description: null, verification_level: 2 } },
        ],
        ['audit_log', { guildId: g, actionType: 22, limit: 10 }, { route: `/guilds/${g}/audit-logs`, query: 'limit=10&action_type=22' }],
        ['invites_list', { channelId: ids.channel }, { route: `/channels/${ids.channel}/invites` }],
        [
            'invite_create',
            { channelId: ids.channel },
            { method: 'POST', body: { max_age: 3600, max_uses: 1, temporary: false, unique: true } },
        ],
        ['commands_list', { guildId: g }, { method: 'GET', route: app }],
        ['command_delete', { guildId: g, commandId: r }, { method: 'DELETE', route: `${app}/${r}` }],
        ['emojis_list', { guildId: g }, { route: `/guilds/${g}/emojis` }],
        [
            'emoji_create',
            { guildId: g, name: 'wave', image },
            { method: 'POST', route: `/guilds/${g}/emojis`, body: { name: 'wave', image } },
        ],
        [
            'emoji_rename',
            { guildId: g, emojiId: r, name: 'hello' },
            { method: 'PATCH', route: `/guilds/${g}/emojis/${r}`, body: { name: 'hello' } },
        ],
        ['emoji_delete', { guildId: g, emojiId: r }, { method: 'DELETE', route: `/guilds/${g}/emojis/${r}` }],
        ['stickers_list', { guildId: g }, { route: `/guilds/${g}/stickers` }],
        [
            'sticker_edit',
            { guildId: g, stickerId: r, name: 'cat', description: null, tags: 'cat' },
            { method: 'PATCH', route: `/guilds/${g}/stickers/${r}`, body: { name: 'cat', description: null, tags: 'cat' } },
        ],
        ['sticker_delete', { guildId: g, stickerId: r }, { method: 'DELETE', route: `/guilds/${g}/stickers/${r}` }],
    ]);
    await run('command_register', { guildId: g });
    const registered = api.last()!.body as { name: string; default_member_permissions: string; options: { name: string }[] };
    assert.equal(api.last()!.route, app);
    assert.equal(registered.name, 'discordinator');
    assert.equal(registered.default_member_permissions, '0', 'the command starts hidden from members');
    assert.deepEqual(
        registered.options.map((option) => option.name),
        ['text'],
    );
    await assert.rejects(
        run('emoji_create', { guildId: g, name: 'wave', image: 'https://example.invalid/a.png' }),
        'emoji images are never fetched',
    );
}

async function checkInvites(file: string): Promise<void> {
    const { api, run } = setup(file);
    api.responses.set(`/channels/${ids.channel}/invites`, [{ code: 'abc123' }]);
    await run('invite_delete', { channelId: ids.channel, code: 'abc123' });
    assert.deepEqual(api.last(), { method: 'DELETE', route: '/invites/abc123', reason: undefined });
    await assert.rejects(run('invite_delete', { channelId: ids.channel, code: 'zzz999' }), /does not belong/);
    assert.equal(api.last()!.method, 'GET', 'a foreign invite is never revoked');
}

async function checkScheduledEvents(file: string): Promise<void> {
    const { api, run } = setup(file);
    const event = `/guilds/${g}/scheduled-events`;
    const start = new Date(Date.now() + hour).toISOString();
    const end = new Date(Date.now() + 2 * hour).toISOString();
    await expectCalls(run, api, [
        ['scheduled_events_list', { guildId: g }, { method: 'GET', route: event }],
        [
            'scheduled_event_edit',
            { guildId: g, scheduledEventId: r, status: 3 },
            { method: 'PATCH', route: `${event}/${r}`, body: { name: undefined, description: undefined, status: 3 } },
        ],
        ['scheduled_event_delete', { guildId: g, scheduledEventId: r }, { method: 'DELETE', route: `${event}/${r}` }],
    ]);
    await run('scheduled_event_create', { guildId: g, name: 'Meetup', start, end, location: 'Park' });
    assert.deepEqual(api.last()!.body, {
        name: 'Meetup',
        description: undefined,
        scheduled_start_time: start,
        scheduled_end_time: end,
        entity_type: 3,
        entity_metadata: { location: 'Park' },
        privacy_level: 2,
    });
    const past = new Date(Date.now() - hour).toISOString();
    await assert.rejects(
        run('scheduled_event_create', { guildId: g, name: 'Old', start: past, end, location: 'x' }),
        /ordered and in the future/,
    );
    await assert.rejects(run('scheduled_event_create', { guildId: g, name: 'Back', start: end, end: start, location: 'x' }), /ordered/);
    assert.equal(api.calls.length, 4, 'invalid times never reach Discord');
}

async function checkAutomod(file: string): Promise<void> {
    const { api, run } = setup(file);
    const rules = `/guilds/${g}/auto-moderation/rules`;
    await expectCalls(run, api, [
        ['automod_rules_list', { guildId: g }, { method: 'GET', route: rules }],
        [
            'automod_rule_toggle',
            { guildId: g, ruleId: r, enabled: false },
            { method: 'PATCH', route: `${rules}/${r}`, body: { enabled: false } },
        ],
        ['automod_rule_delete', { guildId: g, ruleId: r }, { method: 'DELETE', route: `${rules}/${r}` }],
    ]);
    await run('automod_keyword_create', { guildId: g, name: 'No spoilers', keywords: ['ending'], exemptChannels: [ids.channel] });
    assert.deepEqual(api.last(), {
        method: 'POST',
        route: rules,
        body: {
            name: 'No spoilers',
            event_type: 1,
            trigger_type: 1,
            trigger_metadata: { keyword_filter: ['ending'] },
            actions: [{ type: 1 }],
            enabled: true,
            exempt_roles: [],
            exempt_channels: [ids.channel],
        },
    });
    assert.equal(api.calls.at(-2)!.method, 'CHANNEL', 'exempt channels are checked first');
    api.channelGuild = ids.other;
    await assert.rejects(
        run('automod_keyword_create', { guildId: g, name: 'x', keywords: ['y'], exemptChannels: [ids.channel] }),
        /another guild/,
    );
    assert.equal(api.last()!.method, 'CHANNEL');
}

export async function checkAdminOperations(directory: string): Promise<void> {
    await checkMembers(join(directory, 'member-operations.json'));
    await checkVoice(join(directory, 'voice-operations.json'));
    await checkGuilds(join(directory, 'guild-operations.json'));
    await checkInvites(join(directory, 'invite-operations.json'));
    await checkScheduledEvents(join(directory, 'event-operations.json'));
    await checkAutomod(join(directory, 'automod-operations.json'));
}
