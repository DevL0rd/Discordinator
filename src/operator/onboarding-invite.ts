import type { DiscordDiscovery } from './onboarding-store.js';

export const inviteLink = (botId: string) =>
    `https://discord.com/oauth2/authorize?client_id=${botId}&scope=bot+applications.commands&permissions=8`;

export const inviteReady = (discovery?: DiscordDiscovery) =>
    Boolean(discovery?.servers.length && discovery.intents.messageContent && discovery.intents.members);

export function inviteCopy(discovery?: DiscordDiscovery): { title: string; body: string[] } {
    if (!discovery) return { title: 'Add the bot to your server', body: ['Checking your bot…'] };
    const mark = (ok: boolean) => (ok ? '✓' : '○');
    return {
        title: 'Add the bot to your server',
        body: [
            'Discordinator needs two things on the Developer Portal Bot page, and the bot in your server with Administrator.',
            `${mark(discovery.intents.messageContent)} Message Content Intent is on (Bot → Privileged Gateway Intents)`,
            `${mark(discovery.intents.members)} Server Members Intent is on (same section)`,
            `${mark(discovery.servers.length > 0)} The bot is in a server${discovery.servers.length ? `: ${discovery.servers.join(', ')}` : ''}`,
            `Invite link (Administrator, slash commands): ${inviteLink(discovery.botId)}`,
            'Administrator lets it manage channels, roles and messages when you ask. It still only answers the people and channels you approve.',
        ],
    };
}

const snowflake = /^\d{17,20}$/;

export function ownerMatches(discovery: DiscordDiscovery | undefined, input: string): { id: string; name: string }[] {
    const query = input.trim().toLowerCase();
    if (snowflake.test(query)) return [];
    return (discovery?.members ?? []).filter((member) => member.name.toLowerCase().includes(query)).slice(0, 12);
}

export function ownerFrom(discovery: DiscordDiscovery | undefined, input: string, selected: number): string {
    if (snowflake.test(input.trim())) return input.trim();
    const match = ownerMatches(discovery, input)[selected];
    if (!match) throw new Error('Pick yourself from the list, or paste your Discord user ID.');
    return match.id;
}
