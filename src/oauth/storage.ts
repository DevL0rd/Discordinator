import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { validAppRedirect } from './registration.js';

async function privateDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
        throw new Error('OAuth directory must be owned by this user with mode 700');
    }
}

export async function readPrivate<T>(file: string): Promise<T> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
            throw new Error('OAuth files must be owned by this user with mode 600');
        }
        return JSON.parse(await handle.readFile('utf8')) as T;
    } finally {
        await handle.close();
    }
}

export async function writePrivate(file: string, value: unknown, exclusive = false): Promise<void> {
    const target = exclusive ? file : `${file}.pending`;
    const handle = await open(target, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
    } finally {
        await handle.close();
    }
    if (!exclusive) await rename(target, file);
    const directory = await open(join(file, '..'), constants.O_RDONLY);
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

export async function lockDirectory(directory: string): Promise<() => Promise<void>> {
    await privateDirectory(directory);
    const file = join(directory, 'operation.lock');
    const handle = await open(file, 'wx', 0o600);
    let released = false;
    return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(file);
    };
}

type RecordValue = { payload: AdapterPayload; expires?: number };
type Records = Record<string, RecordValue>;

export class OAuthStore {
    private records: Records = {};
    private pending: Promise<void> = Promise.resolve();
    constructor(readonly directory: string) {}

    async load(): Promise<void> {
        try {
            this.records = await readPrivate<Records>(join(this.directory, 'state.json'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }

    private purge(): void {
        for (const [key, record] of Object.entries(this.records)) {
            if (record.expires !== undefined && record.expires <= Date.now()) delete this.records[key];
        }
    }

    mutate(change: (records: Records) => void): Promise<void> {
        const operation = this.pending.then(async () => {
            this.purge();
            const next = structuredClone(this.records);
            change(next);
            if (Object.keys(next).length > 10_000) throw new Error('OAuth state capacity exhausted');
            await writePrivate(join(this.directory, 'state.json'), next);
            this.records = next;
        });
        this.pending = operation.catch(() => {});
        return operation;
    }

    async find(model: string, test: (id: string, payload: AdapterPayload) => boolean): Promise<AdapterPayload | undefined> {
        await this.pending;
        this.purge();
        const prefix = `${model}:`;
        const found = Object.entries(this.records).find(
            ([key, record]) => key.startsWith(prefix) && test(key.slice(prefix.length), record.payload),
        );
        return found ? structuredClone(found[1].payload) : undefined;
    }

    async clientCount(): Promise<number> {
        await this.pending;
        return Object.keys(this.records).filter((key) => key.startsWith('Client:')).length;
    }

    async migrateChatgptClients(): Promise<number> {
        let migrated = 0;
        await this.mutate((records) => {
            for (const [key, record] of Object.entries(records)) {
                if (!key.startsWith('Client:')) continue;
                const payload = record.payload as Record<string, unknown>;
                const redirects = payload.redirect_uris;
                if (
                    payload.scope !== 'discordinator:control' ||
                    payload.token_endpoint_auth_method !== 'none' ||
                    !Array.isArray(redirects) ||
                    !redirects.length ||
                    !redirects.every((redirect) => typeof redirect === 'string' && validAppRedirect(redirect))
                )
                    continue;
                payload.scope = 'openid discordinator:control';
                payload.grant_types = ['authorization_code', 'refresh_token'];
                migrated++;
            }
        });
        return migrated;
    }

    adapter = (model: string): Adapter => ({
        upsert: (id, payload, expiresIn) =>
            this.mutate((records) => {
                const key = `${model}:${id}`;
                if (
                    model === 'Client' &&
                    !records[key] &&
                    Object.keys(records).filter((item) => item.startsWith('Client:')).length >= 200
                ) {
                    throw new Error('OAuth client capacity exhausted');
                }
                records[key] = { payload, expires: expiresIn === undefined ? undefined : Date.now() + expiresIn * 1000 };
            }),
        find: (id) => this.find(model, (key) => key === id),
        findByUid: (uid) => this.find(model, (_key, payload) => payload.uid === uid),
        findByUserCode: (code) => this.find(model, (_key, payload) => payload.userCode === code),
        consume: (id) =>
            this.mutate((records) => {
                const entry = records[`${model}:${id}`];
                if (entry) entry.payload.consumed = Math.floor(Date.now() / 1000);
            }),
        destroy: (id) =>
            this.mutate((records) => {
                delete records[`${model}:${id}`];
            }),
        revokeByGrantId: (grantId) =>
            this.mutate((records) => {
                for (const [key, entry] of Object.entries(records)) {
                    if (entry.payload.grantId === grantId) delete records[key];
                }
            }),
    });
}
