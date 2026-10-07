import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { envSchema, validateAuth, type Config } from './core/config.js';
import { watchFile } from './operator/file-watch.js';

const gatewayKeys: (keyof Config)[] = ['DISCORD_BOT_TOKEN', 'DISCORDINATOR_MESSAGE_CONTENT', 'DISCORDINATOR_GUILD_MEMBERS'];
const listenerKeys: (keyof Config)[] = [
    'DISCORDINATOR_PORT',
    'DISCORDINATOR_AUTH_MODE',
    'DISCORDINATOR_RESOURCE_URL',
    'DISCORDINATOR_OAUTH_SERVER',
    'DISCORDINATOR_OAUTH_DATA_DIR',
    'DISCORDINATOR_OAUTH_ISSUER',
    'DISCORDINATOR_OAUTH_JWKS_URL',
    'DISCORDINATOR_OAUTH_REDIRECT_URIS',
];

/** The parts of a running Discordinator that can be rebuilt in place when settings change. */
export interface Reconfigurable {
    movePolicy(path: string): Promise<void>;
    restartListener(): Promise<void>;
    reconnectGateway(): Promise<void>;
}

export function parseEnvironment(base: NodeJS.ProcessEnv, text: string): Config {
    const parsed = envSchema.safeParse({ ...base, ...parseEnv(text) });
    if (!parsed.success) throw new Error('Invalid environment configuration');
    validateAuth(parsed.data);
    parsed.data.DISCORDINATOR_RESOURCE_URL ??= `http://127.0.0.1:${parsed.data.DISCORDINATOR_PORT}/mcp`;
    return parsed.data;
}

/** The process environment without the values that came from a .env file, so later edits can remove keys too. */
export function baseEnvironment(env: NodeJS.ProcessEnv, text: string): NodeJS.ProcessEnv {
    const fromFile = parseEnv(text);
    return Object.fromEntries(Object.entries(env).filter(([key, value]) => !(key in fromFile) || fromFile[key] !== value));
}

export function changedKeys(before: Config, after: Config): (keyof Config)[] {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof Config)[]);
    return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function replace(config: Config, next: Config): void {
    for (const key of Object.keys(config) as (keyof Config)[]) if (!(key in next)) delete config[key];
    Object.assign(config, next);
}

function withRuntimeOwner(config: Config, next: Config): Config {
    const bundled = next.DISCORDINATOR_AUTH_MODE === 'oauth' && next.DISCORDINATOR_OAUTH_SERVER === 'bundled';
    return bundled && !next.DISCORDINATOR_OAUTH_SUBJECTS
        ? { ...next, DISCORDINATOR_OAUTH_SUBJECTS: config.DISCORDINATOR_OAUTH_SUBJECTS }
        : next;
}

/** Applies new settings to the running process: values in place, and only the affected parts rebuilt. Rolls back on failure. */
export async function reconfigure(config: Config, saved: Config, target: Reconfigurable): Promise<(keyof Config)[]> {
    const next = withRuntimeOwner(config, saved);
    const changed = changedKeys(config, next);
    if (!changed.length) return [];
    const previous = { ...config };
    const touches = (keys: (keyof Config)[]) => changed.some((key) => keys.includes(key));
    replace(config, next);
    const steps: (() => Promise<void>)[] = [
        ...(changed.includes('DISCORDINATOR_POLICY_FILE') ? [() => target.movePolicy(config.DISCORDINATOR_POLICY_FILE)] : []),
        ...(touches(listenerKeys) ? [() => target.restartListener()] : []),
        ...(touches(gatewayKeys) ? [() => target.reconnectGateway()] : []),
    ];
    let done = 0;
    try {
        for (const step of steps) {
            done++;
            await step();
        }
    } catch (error) {
        replace(config, previous);
        for (const step of steps.slice(0, done)) await step().catch(() => undefined);
        throw error;
    }
    return changed;
}

export function environmentStamp(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function watchEnvironment(
    path: string,
    base: NodeJS.ProcessEnv,
    apply: (next: Config, stamp: string) => Promise<void>,
    invalid: (stamp: string) => void = () => undefined,
): () => void {
    let work = Promise.resolve();
    return watchFile(path, () => {
        work = work.then(async () => {
            const text = await readFile(path, 'utf8').catch(() => '');
            let next: Config;
            try {
                next = parseEnvironment(base, text);
            } catch {
                console.error(`${path} changed but could not be applied; the current settings stay in effect`);
                return invalid(environmentStamp(text));
            }
            await apply(next, environmentStamp(text));
        });
    });
}
