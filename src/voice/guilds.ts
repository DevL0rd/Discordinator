import type { Client } from 'discord.js';
import { person } from '../core/directory.js';
import type { VoiceGuilds } from './service.js';

export function discordGuilds(client: Client): VoiceGuilds {
    const guild = (id: string) => client.guilds.cache.get(id);
    return {
        occupants: (guildId, channelId) =>
            [...(guild(guildId)?.voiceStates.cache.values() ?? [])]
                .filter((state) => state.channelId === channelId && state.id !== client.user?.id)
                .map((state) => state.id),
        channelOf: (guildId, userId) => guild(guildId)?.voiceStates.cache.get(userId)?.channelId ?? null,
        channelName: (channelId) => {
            const channel = client.channels.cache.get(channelId);
            return channel && 'name' in channel && typeof channel.name === 'string' ? channel.name : null;
        },
        person: (guildId, userId) => {
            const member = guild(guildId)?.members.cache.get(userId);
            const user = member?.user ?? client.users.cache.get(userId);
            return user ? person(userId, user.username, user.globalName, member?.nickname) : person(userId);
        },
        self: () => (client.user ? person(client.user.id, client.user.username, client.user.globalName, null) : person('0'.repeat(17))),
        serverMuted: (guildId) => guild(guildId)?.members.me?.voice.serverMute === true,
        states: () =>
            [...client.guilds.cache.values()].flatMap((item) =>
                [...item.voiceStates.cache.values()]
                    .filter((state) => state.channelId && state.id !== client.user?.id)
                    .map((state) => ({ guildId: item.id, userId: state.id, channelId: state.channelId! })),
            ),
    };
}
