import type { Api, Json } from '../src/discord/api.js';
import { policySchema, type Config } from '../src/core/config.js';
import { Policy } from '../src/core/policy.js';
import { EventQueue } from '../src/core/queue.js';
import { Journal } from '../src/core/journal.js';
import { Approvals } from '../src/core/approvals.js';
import { Bridge } from '../src/core/bridge.js';

export const ids = { user: '111111111111111111', denied: '222222222222222222', bot: '333333333333333333',
  guild: '444444444444444444', channel: '555555555555555555', other: '666666666666666666', message: '777777777777777777' };

export class FakeApi implements Api {
  botId = ids.bot;
  calls: { method: string; route: string; body?: unknown }[] = [];
  constructor(readonly policy: Policy) {}
  private request(method: string, route: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, route, body });
    return Promise.resolve({ id: ids.message, channel_id: ids.channel });
  }
  get(route: string) { return this.request('GET', route); }
  post(route: string, body: unknown) { return this.request('POST', route, body); }
  patch(route: string, body: unknown) { return this.request('PATCH', route, body); }
  put(route: string, body?: unknown) { return this.request('PUT', route, body); }
  delete(route: string) { return this.request('DELETE', route); }
  channel(id: string): Promise<Json> {
    this.policy.assertChannel(id); this.policy.assertGuild(ids.guild);
    return Promise.resolve({ id, guild_id: ids.guild });
  }
  message(): Promise<Json> { return Promise.resolve({ author: { id: this.botId } }); }
}

export function fixture(file: string) {
  const policy = new Policy(policySchema.parse({ allowedUserIds: [ids.user], guildScope: 'all', channelScope: 'all',
    scopes: ['guild.read', 'messages.write', 'moderation.write', 'channels.write'],
    triggers: { matchNames: true, names: ['DotBot', 'dot', 'dot+'] } }));
  const queue = new EventQueue();
  const journal = new Journal(file);
  const approvals = new Approvals(policy);
  const api = new FakeApi(policy);
  const bridge = new Bridge(policy, queue, journal, approvals, api);
  const event = queue.add('fixture', { actorId: ids.user, channelId: ids.channel, guildId: ids.guild,
    messageId: ids.message, kind: 'message', text: 'DotBot help' })!;
  return { policy, queue, journal, approvals, api, bridge, event };
}

export function fakeConfig(port = 8787): Config {
  return { DISCORD_BOT_TOKEN: '', DOTBOT_POLICY_FILE: 'policy.json', DOTBOT_PORT: port,
    DOTBOT_AUTH_MODE: 'bearer', DOTBOT_MCP_TOKEN: 'local-validation-fixture-never-a-real-credential',
    DOTBOT_OAUTH_SUBJECTS: '', DOTBOT_ALLOWED_HOSTS: '', DOTBOT_ALLOWED_ORIGINS: '',
    DOTBOT_MESSAGE_CONTENT: 'true', DOTBOT_GUILD_MEMBERS: 'false' };
}
