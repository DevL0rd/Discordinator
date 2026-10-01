import { z } from 'zod';
import { snowflake } from '../core/config.js';
import { define, member, guild, shortName, pagination, query, sensitive, reason } from './operations.js';

const role = { ...guild, roleId: snowflake };
const roleSettings = { name: shortName.optional(), permissions: z.string().regex(/^\d{1,25}$/).optional(),
  color: z.number().int().min(0).max(16777215).optional(), hoist: z.boolean().optional(), mentionable: z.boolean().optional() };

export const memberOperations = [
  define('member_get', 'Read one member and their role IDs.', 'members.read', 'guild', member,
    (a, c) => c.api.get(`/guilds/${a.guildId}/members/${a.userId}`)),
  define('members_list', 'Read a bounded member page; Server Members intent is required.', 'members.read', 'guild',
    { ...guild, ...pagination }, (a, c) => c.api.get(`/guilds/${a.guildId}/members`, query({ limit: a.limit, after: a.before }))),
  define('member_nickname', 'Change a member nickname, with confirmation.', 'members.write', 'guild',
    { ...member, nickname: z.string().max(32).nullable() }, (a, c) =>
      c.api.patch(`/guilds/${a.guildId}/members/${a.userId}`, { nick: a.nickname }), sensitive),
  define('member_timeout', 'Set or clear a member timeout, with confirmation. Discord hierarchy applies.', 'moderation.write', 'guild',
    { ...member, durationSeconds: z.number().int().min(0).max(28 * 86400), reason }, (a, c) =>
      c.api.patch(`/guilds/${a.guildId}/members/${a.userId}`, {
        communication_disabled_until: a.durationSeconds === 0 ? null : new Date(Date.now() + a.durationSeconds * 1000).toISOString(),
      }, a.reason), sensitive),
  define('member_kick', 'Kick a member, with confirmation. No automatic DM is sent.', 'moderation.write', 'guild',
    { ...member, reason }, (a, c) => c.api.delete(`/guilds/${a.guildId}/members/${a.userId}`, a.reason), sensitive),
  define('member_ban', 'Ban a member, optionally delete up to seven days of messages, with confirmation.', 'moderation.write', 'guild',
    { ...member, deleteMessageSeconds: z.number().int().min(0).max(604800).default(0), reason }, (a, c) =>
      c.api.put(`/guilds/${a.guildId}/bans/${a.userId}`, { delete_message_seconds: a.deleteMessageSeconds }, a.reason), sensitive),
  define('member_unban', 'Remove a guild ban, with confirmation.', 'moderation.write', 'guild',
    { ...member, reason }, (a, c) => c.api.delete(`/guilds/${a.guildId}/bans/${a.userId}`, a.reason), sensitive),
  define('bans_list', 'Read a bounded list of bans.', 'members.read', 'guild',
    { ...guild, ...pagination }, (a, c) => c.api.get(`/guilds/${a.guildId}/bans`, query({ limit: a.limit, before: a.before }))),
  define('roles_list', 'Read guild roles and permission bitfields.', 'roles.read', 'guild', guild,
    (a, c) => c.api.get(`/guilds/${a.guildId}/roles`)),
  define('role_create', 'Create a role, including explicit permission bits, with confirmation.', 'roles.write', 'guild',
    { ...guild, ...roleSettings, name: shortName, permissions: z.string().regex(/^\d{1,25}$/).default('0') }, (a, c) => c.api.post(`/guilds/${a.guildId}/roles`, {
      name: a.name, permissions: a.permissions, color: a.color, hoist: a.hoist, mentionable: a.mentionable,
    }), sensitive),
  define('role_edit', 'Edit a role or its permissions, with confirmation.', 'roles.write', 'guild',
    { ...role, ...roleSettings }, (a, c) => c.api.patch(`/guilds/${a.guildId}/roles/${a.roleId}`, {
      name: a.name, permissions: a.permissions, color: a.color, hoist: a.hoist, mentionable: a.mentionable,
    }), sensitive),
  define('role_delete', 'Delete a role, with confirmation.', 'roles.write', 'guild', role,
    (a, c) => c.api.delete(`/guilds/${a.guildId}/roles/${a.roleId}`), sensitive),
  define('role_position', 'Move a role in the hierarchy, with confirmation.', 'roles.write', 'guild',
    { ...role, position: z.number().int().min(0).max(1000) }, (a, c) =>
      c.api.patch(`/guilds/${a.guildId}/roles`, [{ id: a.roleId, position: a.position }]), sensitive),
  define('member_role_add', 'Assign a guild role, with confirmation.', 'roles.write', 'guild',
    { ...member, roleId: snowflake }, (a, c) => c.api.put(`/guilds/${a.guildId}/members/${a.userId}/roles/${a.roleId}`), sensitive),
  define('member_role_remove', 'Remove a member role, with confirmation.', 'roles.write', 'guild',
    { ...member, roleId: snowflake }, (a, c) => c.api.delete(`/guilds/${a.guildId}/members/${a.userId}/roles/${a.roleId}`), sensitive),
  define('voice_member_edit', 'Move, disconnect, mute or deafen a member, with confirmation; no audio capture/playback.', 'voice.write', 'guild',
    { ...member, channelId: snowflake.nullable().optional(), mute: z.boolean().optional(), deaf: z.boolean().optional() }, async (a, c) => {
      if (a.channelId) {
        const destination = await c.api.channel(a.channelId);
        if (destination.guild_id !== a.guildId) throw new Error('Voice destination is in another guild');
      }
      return c.api.patch(`/guilds/${a.guildId}/members/${a.userId}`, { channel_id: a.channelId, mute: a.mute, deaf: a.deaf });
    }, sensitive),
];
