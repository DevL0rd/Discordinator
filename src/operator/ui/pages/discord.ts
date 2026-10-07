import type { ScopeList } from '../../../core/config.js';
import { color } from '../theme.js';
import { note, section, settingItem } from '../items.js';
import { serverItems } from './servers.js';
import type { Item, View } from '../model.js';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function scopeSummary(list: ScopeList | undefined, noun: string): { text: string; warn: boolean } {
    const value = list ?? { mode: 'allowlist', allowed: [], blocked: [] };
    if (value.mode === 'blocklist')
        return {
            text: `every ${noun}${value.blocked.length ? ` except ${plural(value.blocked.length, 'blocked ' + noun)}` : ''}`,
            warn: false,
        };
    const allowed = value.allowed.filter((id) => !value.blocked.includes(id)).length;
    if (!allowed) return { text: `no ${noun}s (the allowlist is empty)`, warn: true };
    return { text: `only ${plural(allowed, 'listed ' + noun)}`, warn: false };
}

function scopeItems(view: View, path: 'servers' | 'channels', noun: string): Item[] {
    const list = view.drafts.policy[path] as ScopeList | undefined;
    return [
        settingItem(`policy.${path}.mode`),
        ...(list?.mode === 'blocklist' ? [] : [settingItem(`policy.${path}.allowed`)]),
        settingItem(`policy.${path}.blocked`),
        note(
            `${path}-help`,
            list?.mode === 'blocklist'
                ? `Works in every ${noun} the bot can see, except blocked ones.`
                : `Works only in listed ${noun}s. Blocked ${noun}s always win.`,
        ),
    ];
}

export function discordItems(view: View): Item[] {
    const servers = scopeSummary(view.drafts.policy.servers as ScopeList, 'server');
    const channels = scopeSummary(view.drafts.policy.channels as ScopeList, 'channel');
    const warn = servers.warn || channels.warn;
    return [
        ...section('reach', 'Where Discordinator answers', '', [
            note(
                'reach-summary',
                `Discordinator answers in ${servers.text}, in ${channels.text}. Discord's own permissions still apply.`,
                warn ? color.amber : color.soft,
            ),
        ]),
        ...section('people', 'Who can ask', 'Pick people and roles from your servers', [
            settingItem('policy.allowedUserIds', 'People who can ask'),
            settingItem('policy.ownerUserId', 'Owner'),
            settingItem('policy.allowedRoleIds', 'Roles that can ask'),
        ]),
        ...serverItems(view),
        ...section('bot', 'Bot', '', [
            settingItem('environment.DISCORD_BOT_TOKEN', 'Bot token'),
            settingItem('environment.DISCORDINATOR_MESSAGE_CONTENT', 'Read message text'),
            settingItem('environment.DISCORDINATOR_GUILD_MEMBERS', 'See server members'),
        ]),
        ...section('triggers', 'When it responds', '', [
            settingItem('policy.triggers.replyToBot', 'Replies to the bot count'),
            settingItem('policy.triggers.matchNames', 'Respond to its name'),
            settingItem('policy.triggers.names', 'Names it answers to'),
        ]),
        ...section('abilities', 'What it may do', '', [
            settingItem('policy.scopes', 'Allowed abilities'),
            settingItem('policy.proactive', 'Channels for standalone messages'),
        ]),
        ...section('advanced-reach', 'Advanced rules', 'Raw lists, including servers the bot is not in', [
            ...scopeItems(view, 'servers', 'server'),
            ...scopeItems(view, 'channels', 'channel'),
        ]),
    ];
}
