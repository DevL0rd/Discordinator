import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
    listServers,
    serverState,
    uniqueMembers,
    withServerAllowed,
    withServerChannels,
    type ServerInfo,
} from '../src/operator/servers.js';
import { serverItems } from '../src/operator/ui/pages/servers.js';
import type { View } from '../src/operator/ui/model.js';
import { PresenceWriter, presenceFile, readPresence } from '../src/operator/presence.js';
import { discordRoutes, fake, inScratch, withDiscord } from './onboarding-fakes.js';

async function checkListing(): Promise<void> {
    const routes = discordRoutes();
    const listed = await withDiscord(routes, () => listServers('fixture-token'));
    assert.equal(listed.bot, `Fixture Bot (${fake.bot})`);
    assert.equal(listed.botId, fake.bot);
    const [main, quiet] = listed.servers;
    assert.equal(main!.name, 'Fixture Guild');
    assert.deepEqual(
        main!.channels.map((channel) => channel.name),
        ['general', 'news', '999999999999999991'],
        'only text, announcement and forum channels, named by ID when unnamed',
    );
    assert.deepEqual(
        main!.members.map((member) => member.name),
        ['@amy', 'Boss (@owner)', 'Zed Global (@zed)'],
        'bots are hidden and people are sorted by display name',
    );
    assert.deepEqual(main!.roles, [{ id: fake.role, name: 'Mods' }], '@everyone and managed roles are hidden');
    assert.deepEqual(quiet, { id: fake.quiet, name: fake.quiet, channels: [], members: [], roles: [] }, 'unreadable servers stay empty');
    const duplicated = [main!, { ...main!, id: 'copy', members: [main!.members[0]!] }];
    assert.equal(uniqueMembers(duplicated).length, 3, 'people in two servers are listed once');
    const anonymous = Object.fromEntries(Object.entries(routes).filter(([route]) => route !== '/users/@me/guilds'));
    anonymous['/users/@me'] = { id: fake.bot, bot: true };
    assert.deepEqual(await withDiscord(anonymous, () => listServers('fixture-token')), {
        bot: `bot (${fake.bot})`,
        botId: fake.bot,
        servers: [],
    });
    await assert.rejects(
        withDiscord({ '/users/@me': { id: fake.owner, username: 'person' } }, () => listServers('user-token')),
        /did not resolve to a Discord bot/,
    );
}

const server: ServerInfo = {
    id: fake.guild,
    name: 'Fixture Guild',
    channels: [
        { id: fake.channel, name: 'general' },
        { id: fake.announcements, name: 'news' },
    ],
    members: [],
    roles: [],
};

function checkScopes(): void {
    assert.deepEqual(serverState({}, server), { allowed: false, channels: [] }, 'nothing is allowed by default');
    const allowed = withServerChannels(withServerAllowed({}, fake.guild, true), server, [fake.channel]);
    assert.deepEqual(allowed.servers, { mode: 'allowlist', allowed: [fake.guild], blocked: [] });
    assert.deepEqual(serverState(allowed, server), { allowed: true, channels: [fake.channel] });
    const removed = withServerAllowed(allowed, fake.guild, false);
    assert.deepEqual(removed.servers, { mode: 'allowlist', allowed: [], blocked: [] });
    const open = { servers: { mode: 'blocklist' }, channels: { mode: 'blocklist' } };
    assert.deepEqual(serverState(open, server), { allowed: true, channels: [fake.channel, fake.announcements] });
    const blocked = withServerChannels(withServerAllowed(open, fake.guild, false), server, [fake.announcements]);
    assert.deepEqual(blocked.servers, { mode: 'blocklist', allowed: [], blocked: [fake.guild] });
    assert.deepEqual(blocked.channels, { mode: 'blocklist', allowed: [], blocked: [fake.channel] });
    assert.deepEqual(serverState(withServerAllowed(blocked, fake.guild, true), server), { allowed: true, channels: [fake.announcements] });
}

function pageText(policy: Record<string, unknown>, servers?: ServerInfo[]): string {
    const view = {
        drafts: { policy },
        extras: servers ? { servers: { bot: 'Fixture Bot', botId: fake.bot, servers } } : {},
    } as unknown as View;
    return serverItems(view)
        .flatMap((item) => item.lines(80, false, view))
        .map((line) => line.spans.map((part) => part.text).join(''))
        .join('\n');
}

function checkServerPage(server: ServerInfo): void {
    assert.match(pageText({}), /Loading servers…/);
    assert.match(pageText({}, []), /0 servers · select one[\s\S]*The bot is not in any server yet/);
    assert.match(pageText({}, [server]), /1 server · [\s\S]*OFF[\s\S]*Not answering here/);
    const allowed = withServerAllowed({}, server.id, true);
    assert.match(
        pageText(allowed, [server, { ...server, id: 'other' }]),
        /2 servers[\s\S]*NO CHANNELS[\s\S]*Allowed, but no channels chosen yet/,
    );
    assert.match(pageText(withServerChannels(allowed, server, [fake.channel]), [server]), /ANSWERING[\s\S]*Answers in 1 of 2 channels/);
    const single = { ...server, channels: [server.channels[0]!] };
    assert.match(pageText(withServerChannels(allowed, single, [fake.channel]), [single]), /Answers in 1 of 1 channel\b/);
}

async function checkPresence(): Promise<void> {
    assert.deepEqual(await readPresence(), { subscriptions: 0 }, 'no presence file reads as idle');
    await writeFile(presenceFile, '{"subscriptions":-1}');
    assert.deepEqual(await readPresence(), { subscriptions: 0 }, 'an invalid presence file reads as idle');
    await writeFile(presenceFile, JSON.stringify({ remoteAt: '2026-01-01T00:00:00.000Z', subscriptions: 4 }));
    const writer = new PresenceWriter();
    await writer.start(2);
    const started = await readPresence();
    assert.equal(started.remoteAt, '2026-01-01T00:00:00.000Z', 'an earlier remote sign-in is kept across restarts');
    assert.equal(started.subscriptions, 2);
    assert.ok(started.startedAt);
    writer.remoteSignedIn();
    writer.update({ subscriptions: 2 });
    assert.deepEqual(await readPresence(), started, 'unchanged presence is not rewritten');
    await writeFile(presenceFile, '{}');
    const first = new PresenceWriter();
    await first.start(1);
    assert.equal((await readPresence()).remoteAt, undefined);
    first.remoteSignedIn();
    first.update({ subscriptions: 5 });
    await first.start(5);
    const signed = JSON.parse(await readFile(presenceFile, 'utf8')) as { remoteAt?: string; subscriptions: number };
    assert.ok(signed.remoteAt, 'a first remote sign-in is recorded');
    assert.equal(signed.subscriptions, 5);
}

export async function checkServers(directory: string): Promise<void> {
    await checkListing();
    checkScopes();
    checkServerPage(server);
    await inScratch(directory, checkPresence);
}
