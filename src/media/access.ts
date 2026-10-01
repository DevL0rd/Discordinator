import type { Policy } from '../core/policy.js';
import type { EventQueue } from '../core/queue.js';
import type { Api } from '../discord/api.js';

export class MediaAccess {
  constructor(readonly policy: Policy, readonly queue: EventQueue, readonly api: Api) {}
  event(id: string, write = false) {
    const context = this.queue.context(id);
    this.policy.assertOrigin(context.event);
    this.policy.assertScope(write ? 'media.write' : 'media.read');
    this.policy.assertScope(write ? 'messages.write' : 'messages.read');
    if (!this.policy.config.media.enabled) throw new Error('Media is disabled');
    return context;
  }
  async channel(eventId: string, channelId: string): Promise<string | null> {
    const origin = this.event(eventId).event;
    if (!origin.guildId) {
      if (origin.channelId !== channelId) throw new Error('DM media must remain in the originating DM');
      return null;
    }
    const channel = await this.api.channel(channelId);
    if (channel.guild_id !== origin.guildId) throw new Error('Media must remain in the originating guild');
    this.event(eventId);
    return origin.guildId;
  }
}
