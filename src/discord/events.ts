import { z } from 'zod';
import { snowflake } from '../core/config.js';
import { define, guild, shortName, sensitive } from './operations.js';

const event = { ...guild, scheduledEventId: snowflake };
export const scheduledEventOperations = [
  define('scheduled_events_list', 'Read scheduled guild events.', 'events.read', 'guild', guild,
    (a, c) => c.api.get(`/guilds/${a.guildId}/scheduled-events`)),
  define('scheduled_event_create', 'Create an external scheduled event, with confirmation.', 'events.write', 'guild',
    { ...guild, name: shortName, description: z.string().max(1000).optional(),
      start: z.iso.datetime(), end: z.iso.datetime(), location: shortName }, (a, c) => {
      if (Date.parse(a.start) <= Date.now() || Date.parse(a.end) <= Date.parse(a.start)) throw new Error('Event times must be ordered and in the future');
      return c.api.post(`/guilds/${a.guildId}/scheduled-events`, {
        name: a.name, description: a.description, scheduled_start_time: a.start, scheduled_end_time: a.end,
        entity_type: 3, entity_metadata: { location: a.location }, privacy_level: 2,
      });
    }, sensitive),
  define('scheduled_event_edit', 'Edit scheduled event text or transition its status, with confirmation.', 'events.write', 'guild',
    { ...event, name: shortName.optional(), description: z.string().max(1000).optional(),
      status: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional() }, (a, c) =>
      c.api.patch(`/guilds/${a.guildId}/scheduled-events/${a.scheduledEventId}`, {
        name: a.name, description: a.description, status: a.status,
      }), sensitive),
  define('scheduled_event_delete', 'Delete a scheduled event, with confirmation.', 'events.write', 'guild', event,
    (a, c) => c.api.delete(`/guilds/${a.guildId}/scheduled-events/${a.scheduledEventId}`), sensitive),
];
