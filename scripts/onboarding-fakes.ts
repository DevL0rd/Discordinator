import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface Handler {
    onConnect(abort: () => void): void;
    onHeaders(status: number, headers: Buffer[], resume: () => void, text: string): void;
    onData(chunk: Buffer): void;
    onComplete(trailers: Buffer[]): void;
}
export type DiscordRoutes = Record<string, unknown>;
const dispatcherKey = Symbol.for('undici.globalDispatcher.1');

export const fake = {
    bot: '333333333333333333',
    owner: '111111111111111111',
    guild: '444444444444444444',
    quiet: '888888888888888888',
    channel: '555555555555555555',
    announcements: '666666666666666666',
    role: '777777777777777777',
};

function fakeDispatcher(routes: DiscordRoutes, seen: string[]) {
    return {
        dispatch(options: { path: string }, handler: Handler) {
            const path = options.path.replace(/^\/api\/v\d+/, '');
            seen.push(path);
            const known = path in routes;
            const body = Buffer.from(JSON.stringify(known ? routes[path] : { message: 'Unknown', code: 0 }));
            handler.onConnect(() => undefined);
            handler.onHeaders(known ? 200 : 404, [Buffer.from('content-type'), Buffer.from('application/json')], () => undefined, '');
            handler.onData(body);
            handler.onComplete([]);
            return true;
        },
        close: () => Promise.resolve(),
        destroy: () => Promise.resolve(),
    };
}

export async function withDiscord<T>(routes: DiscordRoutes, run: (seen: string[]) => Promise<T>): Promise<T> {
    const store = globalThis as unknown as Record<symbol, unknown>;
    const previous = store[dispatcherKey];
    const seen: string[] = [];
    store[dispatcherKey] = fakeDispatcher(routes, seen);
    try {
        return await run(seen);
    } finally {
        store[dispatcherKey] = previous;
    }
}

export function discordRoutes(flags = (1 << 18) | (1 << 14)): DiscordRoutes {
    const members = `/guilds/${fake.guild}/members?limit=1000`;
    return {
        '/users/@me': { id: fake.bot, username: 'Fixture Bot', bot: true },
        '/users/@me/guilds': [{ id: fake.guild, name: 'Fixture Guild' }, { id: fake.quiet }],
        '/applications/@me': { flags },
        [`/guilds/${fake.guild}/channels`]: [
            { id: fake.channel, name: 'general', type: 0 },
            { id: fake.announcements, name: 'news', type: 5 },
            { id: '999999999999999991', type: 15 },
            { id: '999999999999999992', name: 'voice', type: 2 },
            { id: '999999999999999993', name: 'untyped' },
        ],
        [members]: [
            { nick: 'Boss', user: { id: fake.owner, username: 'owner' } },
            { user: { id: '222222222222222222', username: 'zed', global_name: 'Zed Global' } },
            { nick: null, user: { id: '222222222222222223', username: 'amy', global_name: null } },
            { user: { id: '222222222222222224', username: 'helper', bot: true } },
        ],
        [`/guilds/${fake.guild}/roles`]: [
            { id: fake.guild, name: '@everyone' },
            { id: fake.role, name: 'Mods' },
            { id: '999999999999999994', name: 'Integration', managed: true },
        ],
        [`/users/${fake.owner}`]: { id: fake.owner, username: 'owner' },
        [`/channels/${fake.channel}`]: { id: fake.channel, name: 'general', guild_id: fake.guild, type: 0 },
    };
}

type Fetch = typeof fetch;
export interface LiveFake {
    subscriptions: number;
    blockedReason?: string;
    mode?: string;
    online: boolean;
    probes: string[];
}

async function liveStatus(live: LiveFake): Promise<Response> {
    const saved = await readFile(join('.data', 'operator.json'), 'utf8').catch(() => '');
    const config = (saved ? JSON.parse(saved) : {}) as { mode?: string; enabled?: boolean; updatedAt?: string };
    const operator = {
        mode: live.mode ?? (config.enabled ? config.mode : 'off'),
        appliedConfigAt: config.updatedAt ?? null,
        blockedReason: live.blockedReason ?? null,
    };
    const text = JSON.stringify({ gateway: 'ready', operator, events: { subscriptions: live.subscriptions } });
    return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });
}

export async function withLocal<T>(live: LiveFake, run: () => Promise<T>): Promise<T> {
    const previous = globalThis.fetch;
    globalThis.fetch = ((input: string | URL) => {
        const url = String(input);
        if (!url.startsWith('http://127.0.0.1:')) {
            live.probes.push(url);
            return Promise.resolve(new Response('', { status: 401 }));
        }
        return live.online ? liveStatus(live) : Promise.reject(new Error('offline'));
    }) as Fetch;
    try {
        return await run();
    } finally {
        globalThis.fetch = previous;
    }
}

export async function inScratch<T>(parent: string, run: () => Promise<T>): Promise<T> {
    await mkdir(parent, { recursive: true });
    const directory = resolve(await mkdtemp(join(parent, 'wizard-')));
    const previous = process.cwd();
    process.chdir(directory);
    try {
        await mkdir('.data', { recursive: true });
        await writeFile(join('.data', 'local.key'), 'fixture-local-key\n');
        return await run();
    } finally {
        process.chdir(previous);
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
}
