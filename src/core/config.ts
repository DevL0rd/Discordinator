import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const snowflake = z.string().regex(/^\d{17,20}$/);
export const scope = z.enum([
  'guild.read', 'messages.read', 'messages.write', 'reactions.write',
  'threads.write', 'channels.write', 'members.read', 'members.write',
  'roles.read', 'roles.write', 'moderation.write', 'events.read',
  'events.write', 'commands.write', 'invites.read', 'invites.write',
  'guild.write', 'audit.read', 'automod.read', 'automod.write',
  'expressions.read', 'expressions.write', 'voice.write',
]);
export type Scope = z.infer<typeof scope>;
export const policySchema = z.object({
  allowedUserIds: z.array(snowflake).max(100).default([]),
  guildScope: z.enum(['listed', 'all']).default('listed'),
  channelScope: z.enum(['listed', 'all']).default('listed'),
  guildIds: z.array(snowflake).max(100).default([]),
  channelIds: z.array(snowflake).max(1000).default([]),
  scopes: z.array(scope).default([]),
  triggers: z.object({
    replyToBot: z.boolean().default(true),
    matchNames: z.boolean().default(false),
    names: z.array(z.string().trim().min(2).max(32)).max(10).default([]),
  }).strict().default({ replyToBot: true, matchNames: false, names: [] }),
  context: z.object({
    enabled: z.boolean().default(false),
    capture: z.enum(['addressed', 'all']).default('addressed'),
    maxMessages: z.number().int().min(1).max(2000).default(500),
    perChannel: z.number().int().min(1).max(100).default(50),
    ttlMinutes: z.number().int().min(1).max(60).default(30),
    contentLimit: z.number().int().min(1).max(2000).default(1000),
    includeBots: z.boolean().default(false),
  }).strict().prefault({}),
  mcpEvents: z.object({
    enabled: z.boolean().default(false),
    allowAllMessages: z.boolean().default(false),
  }).strict().prefault({}),
  proactive: z.array(z.object({
    channelId: snowflake,
    scopes: z.array(z.enum(['message.send'])).max(1),
  }).strict()).max(100).default([]),
}).strict();
export type PolicyConfig = z.infer<typeof policySchema>;

const httpsUrl = z.string().url().refine(value => new URL(value).protocol === 'https:');
const optionalUrl = z.preprocess(value => value === '' ? undefined : value, httpsUrl.optional());
const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1).refine(value => !value.startsWith('replace-')),
  DOTBOT_POLICY_FILE: z.string().default('policy.json'),
  DOTBOT_PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  DOTBOT_AUTH_MODE: z.enum(['bearer', 'oauth']).default('bearer'),
  DOTBOT_MCP_TOKEN: z.string().optional(),
  DOTBOT_RESOURCE_URL: optionalUrl,
  DOTBOT_OAUTH_ISSUER: optionalUrl,
  DOTBOT_OAUTH_JWKS_URL: optionalUrl,
  DOTBOT_OAUTH_SUBJECTS: z.string().default(''),
  DOTBOT_ALLOWED_HOSTS: z.string().default(''),
  DOTBOT_ALLOWED_ORIGINS: z.string().default(''),
  DOTBOT_MESSAGE_CONTENT: z.enum(['true', 'false']).default('false'),
  DOTBOT_GUILD_MEMBERS: z.enum(['true', 'false']).default('false'),
});
export type Config = z.infer<typeof envSchema>;

export function csv(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function validateAuth(config: Config): void {
  if (config.DOTBOT_AUTH_MODE === 'bearer') {
    const token = config.DOTBOT_MCP_TOKEN ?? '';
    if (token.length < 32 || token.startsWith('replace-')) throw new Error('Invalid MCP credential configuration');
    return;
  }
  const required = [config.DOTBOT_RESOURCE_URL, config.DOTBOT_OAUTH_ISSUER, config.DOTBOT_OAUTH_JWKS_URL];
  if (required.some(value => !value) || !csv(config.DOTBOT_OAUTH_SUBJECTS).length) {
    throw new Error('Incomplete OAuth resource configuration');
  }
}

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<{ config: Config; policy: PolicyConfig }> {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error('Invalid environment configuration; check .env.example');
  validateAuth(parsed.data);
  const policy = policySchema.safeParse(JSON.parse(await readFile(parsed.data.DOTBOT_POLICY_FILE, 'utf8')));
  if (!policy.success) throw new Error('Invalid policy configuration; check policy.example.json');
  if (policy.data.triggers.matchNames && parsed.data.DOTBOT_MESSAGE_CONTENT !== 'true') {
    throw new Error('Name matching requires DOTBOT_MESSAGE_CONTENT=true and the Developer Portal Message Content intent');
  }
  return { config: parsed.data, policy: policy.data };
}
