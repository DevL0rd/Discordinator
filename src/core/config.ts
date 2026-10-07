import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { isIP } from 'node:net';
import { chatgptRedirect, validAppRedirect, oauthDirectory } from '../oauth/registration.js';

export const snowflake = z.string().regex(/^\d{17,20}$/);
const scope = z.enum([
    'guild.read',
    'messages.read',
    'messages.write',
    'reactions.write',
    'threads.write',
    'channels.write',
    'members.read',
    'members.write',
    'roles.read',
    'roles.write',
    'moderation.write',
    'events.read',
    'events.write',
    'commands.write',
    'invites.read',
    'invites.write',
    'guild.write',
    'audit.read',
    'automod.read',
    'automod.write',
    'expressions.read',
    'expressions.write',
    'voice.write',
    'media.read',
    'media.write',
    'interactions.write',
    'voice.listen',
    'voice.speak',
]);
export type Scope = z.infer<typeof scope>;
const withoutRetiredKeys = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { ttlMinutes: _ttl, maxMessages: _total, contentLimit: _characters, ...rest } = value as Record<string, unknown>;
    return rest;
};
const scopeList = (maxItems: number) =>
    z
        .object({
            mode: z.enum(['allowlist', 'blocklist']),
            allowed: z.array(snowflake).max(maxItems).default([]),
            blocked: z.array(snowflake).max(maxItems).default([]),
        })
        .strict();
export type ScopeList = z.infer<ReturnType<typeof scopeList>>;
function migrateScope(raw: Record<string, unknown>, legacyMode: string, legacyIds: string, target: string): void {
    if (!(legacyMode in raw) && !(legacyIds in raw)) return;
    const ids = Array.isArray(raw[legacyIds]) ? raw[legacyIds] : [];
    raw[target] ??= raw[legacyMode] === 'all' ? { mode: 'blocklist', allowed: ids, blocked: [] } : { mode: 'allowlist', allowed: ids };
    delete raw[legacyMode];
    delete raw[legacyIds];
}
function migratePolicy(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const raw = { ...(value as Record<string, unknown>) };
    migrateScope(raw, 'guildScope', 'guildIds', 'servers');
    migrateScope(raw, 'channelScope', 'channelIds', 'channels');
    return raw;
}
const modelSlug = z
    .string()
    .trim()
    .regex(/^[\w.:/-]{1,100}$/);
const retiredVoiceKeys = [
    'followUpSeconds',
    'jumpInModel',
    'sttModel',
    'speakReplies',
    'conversation',
    'conversationModel',
    'listening',
    'ttsModel',
    'ttsVoice',
    'ttsSpeed',
    'maxSpokenCharacters',
    'jumpIn',
    'jumpInMinutes',
];
const withoutRetiredVoiceKeys = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !retiredVoiceKeys.includes(key)));
};
const voiceObject = z
    .object({
        enabled: z.boolean().default(false),
        autoJoin: z.boolean().default(true),
        leaveAfterSeconds: z.number().int().min(5).max(3600).default(60),
        transcribe: z.enum(['everyone', 'approved']).default('everyone'),
        retentionDays: z.number().int().min(1).max(365).default(30),
        contextMinutes: z.number().int().min(1).max(120).default(10),
        transcribeModel: modelSlug.default('gemini-3.5-flash-lite'),
        language: z
            .string()
            .trim()
            .regex(/^([a-z]{2})?$/)
            .default(''),
        liveModel: modelSlug.default('gemini-3.8-live'),
        liveVoice: z.string().trim().max(60).default(''),
        idleSeconds: z.number().int().min(10).max(600).default(60),
        resultTiming: z.enum(['pause', 'immediately']).default('pause'),
        pauseMs: z.number().int().min(0).max(3000).default(0),
    })
    .strict();
const voiceSchema = z.preprocess(withoutRetiredVoiceKeys, voiceObject);
export type VoiceConfig = z.infer<typeof voiceObject>;
const policyObject = z
    .object({
        allowedUserIds: z.array(snowflake).max(100).default([]),
        ownerUserId: z.preprocess((value) => (value === '' || value === null ? undefined : value), snowflake.optional()),
        allowedRoleIds: z.array(snowflake).max(100).default([]),
        servers: scopeList(100).default({ mode: 'allowlist', allowed: [], blocked: [] }),
        channels: scopeList(1000).default({ mode: 'allowlist', allowed: [], blocked: [] }),
        scopes: z.array(scope).default([]),
        triggers: z
            .object({
                replyToBot: z.boolean().default(true),
                matchNames: z.boolean().default(false),
                names: z.array(z.string().trim().min(2).max(32)).max(10).default([]),
            })
            .strict()
            .default({ replyToBot: true, matchNames: false, names: [] }),
        context: z
            .preprocess(
                withoutRetiredKeys,
                z
                    .object({
                        enabled: z.boolean().default(false),
                        capture: z.enum(['addressed', 'all']).default('addressed'),
                        reach: z.enum(['channel', 'server']).default('channel'),
                        perChannel: z.number().int().min(1).max(100).default(50),
                        includeBots: z.boolean().default(true),
                    })
                    .strict(),
            )
            .prefault({}),
        mcpEvents: z
            .object({
                enabled: z.boolean().default(false),
                allowAllMessages: z.boolean().default(false),
            })
            .strict()
            .prefault({}),
        media: z
            .object({
                enabled: z.boolean().default(false),
                capture: z.enum(['addressed', 'all']).default('addressed'),
                maxAttachments: z.number().int().min(1).max(1000).default(500),
                ttlMinutes: z.number().int().min(1).max(60).default(30),
                maxFileBytes: z
                    .number()
                    .int()
                    .min(1)
                    .max(8 * 1024 * 1024)
                    .default(2 * 1024 * 1024),
            })
            .strict()
            .prefault({}),
        voice: voiceSchema.prefault({}),
        proactive: z
            .array(
                z
                    .object({
                        channelId: snowflake,
                        scopes: z.array(z.enum(['message.send'])).max(1),
                    })
                    .strict(),
            )
            .max(100)
            .default([]),
    })
    .strict()
    .refine((policy) => !policy.ownerUserId || policy.allowedUserIds.includes(policy.ownerUserId), {
        message: 'The owner must be one of the approved people',
        path: ['ownerUserId'],
    });
export const policySchema = z.preprocess(migratePolicy, policyObject);
export type PolicyConfig = z.infer<typeof policyObject>;

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:');
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), httpsUrl.optional());
const resourceUrl = z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.union([httpsUrl, z.string().regex(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)]).optional(),
);
export const envSchema = z.object({
    DISCORD_BOT_TOKEN: z
        .string()
        .min(1)
        .refine((value) => !value.startsWith('replace-')),
    DISCORDINATOR_POLICY_FILE: z.string().default('policy.json'),
    DISCORDINATOR_PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
    DISCORDINATOR_BIND_HOST: z.literal('127.0.0.1').default('127.0.0.1'),
    DISCORDINATOR_AUTH_MODE: z.enum(['bearer', 'oauth']).default('bearer'),
    DISCORDINATOR_MCP_TOKEN: z.string().optional(),
    DISCORDINATOR_RESOURCE_URL: resourceUrl,
    DISCORDINATOR_OAUTH_ISSUER: optionalUrl,
    DISCORDINATOR_OAUTH_JWKS_URL: optionalUrl,
    DISCORDINATOR_OAUTH_SUBJECTS: z.string().default(''),
    DISCORDINATOR_OAUTH_SERVER: z.enum(['external', 'bundled']).default('bundled'),
    DISCORDINATOR_OAUTH_DATA_DIR: oauthDirectory,
    DISCORDINATOR_TRUSTED_PROXIES: z.string().default(''),
    DISCORDINATOR_OAUTH_REDIRECT_URIS: z.string().default(chatgptRedirect),
    DISCORDINATOR_ALLOWED_HOSTS: z.string().default(''),
    DISCORDINATOR_ALLOWED_ORIGINS: z.string().default(''),
    DISCORDINATOR_MESSAGE_CONTENT: z.enum(['true', 'false']).default('true'),
    DISCORDINATOR_GUILD_MEMBERS: z.enum(['true', 'false']).default('true'),
    GEMINI_API_KEY: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(8).max(500).optional()),
});
export type Config = z.infer<typeof envSchema>;

export function csv(value: string): string[] {
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function derivePublicAccess(config: Config): void {
    const resource = config.DISCORDINATOR_RESOURCE_URL;
    if (!resource || !httpsUrl.safeParse(resource).success) return;
    const url = new URL(resource);
    const add = (list: string, value: string) => [...new Set([...csv(list), value])].join(',');
    config.DISCORDINATOR_ALLOWED_HOSTS = add(config.DISCORDINATOR_ALLOWED_HOSTS, url.host);
    config.DISCORDINATOR_ALLOWED_ORIGINS = add(config.DISCORDINATOR_ALLOWED_ORIGINS, url.origin);
    if (config.DISCORDINATOR_OAUTH_SERVER === 'bundled') config.DISCORDINATOR_OAUTH_ISSUER = url.origin;
}

export function validateAuth(config: Config): void {
    derivePublicAccess(config);
    if (config.DISCORDINATOR_AUTH_MODE === 'bearer') {
        const token = config.DISCORDINATOR_MCP_TOKEN ?? '';
        if (token.length < 32 || token.startsWith('replace-')) throw new Error('Invalid MCP credential configuration');
        return;
    }
    if (config.DISCORDINATOR_OAUTH_SERVER === 'bundled') return validateBundled(config);
    const required = [config.DISCORDINATOR_RESOURCE_URL, config.DISCORDINATOR_OAUTH_ISSUER, config.DISCORDINATOR_OAUTH_JWKS_URL];
    if (required.some((value) => !value) || !csv(config.DISCORDINATOR_OAUTH_SUBJECTS).length) {
        throw new Error('Incomplete OAuth resource configuration');
    }
    if (!httpsUrl.safeParse(config.DISCORDINATOR_RESOURCE_URL).success) throw new Error('OAuth requires an HTTPS resource URL');
}

function validateBundled(config: Config): void {
    if (!config.DISCORDINATOR_RESOURCE_URL || !config.DISCORDINATOR_OAUTH_ISSUER)
        throw new Error('Bundled OAuth requires resource and issuer URLs');
    const issuer = new URL(config.DISCORDINATOR_OAUTH_ISSUER);
    const resource = new URL(config.DISCORDINATOR_RESOURCE_URL);
    if (
        config.DISCORDINATOR_OAUTH_ISSUER !== issuer.origin ||
        config.DISCORDINATOR_RESOURCE_URL !== `${issuer.origin}/mcp` ||
        resource.protocol !== 'https:'
    ) {
        throw new Error('Bundled OAuth requires an origin-only issuer and its exact HTTPS /mcp resource');
    }
    if (!csv(config.DISCORDINATOR_ALLOWED_HOSTS).includes(issuer.host))
        throw new Error('Bundled OAuth requires the exact issuer Host allowlist entry');
    const proxies = csv(config.DISCORDINATOR_TRUSTED_PROXIES);
    if (!proxies.length || proxies.some((proxy) => !isIP(proxy)))
        throw new Error('Bundled OAuth requires exact trusted proxy IP addresses');
    config.DISCORDINATOR_OAUTH_REDIRECT_URIS = bundledRedirects(config.DISCORDINATOR_OAUTH_REDIRECT_URIS);
    config.DISCORDINATOR_OAUTH_JWKS_URL = new URL('/oauth/jwks', issuer).href;
}

function bundledRedirects(value: string): string {
    const redirects = csv(value);
    if (!redirects.length || redirects.length > 4 || redirects.some((redirect) => !validAppRedirect(redirect))) {
        throw new Error('Bundled OAuth requires exact approved ChatGPT or Claude callback URLs');
    }
    return redirects.join(',');
}

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<{ config: Config; policy: PolicyConfig }> {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) throw new Error('Invalid environment configuration; check docs/configuration.md');
    validateAuth(parsed.data);
    parsed.data.DISCORDINATOR_RESOURCE_URL ??= `http://127.0.0.1:${parsed.data.DISCORDINATOR_PORT}/mcp`;
    const policy = policySchema.safeParse(JSON.parse(await readFile(parsed.data.DISCORDINATOR_POLICY_FILE, 'utf8')));
    if (!policy.success) throw new Error('Invalid policy configuration; check policy.example.json');
    if (policy.data.triggers.matchNames && parsed.data.DISCORDINATOR_MESSAGE_CONTENT !== 'true') {
        throw new Error('Name matching requires DISCORDINATOR_MESSAGE_CONTENT=true and the Developer Portal Message Content intent');
    }
    return { config: parsed.data, policy: policy.data };
}
