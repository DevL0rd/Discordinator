import { scopeNames } from '../core/config.js';
import { group } from './settings-types.js';

function scopeSettings(path: 'servers' | 'channels', noun: string, maxItems: number) {
    const plural = `${noun}s`;
    return [
        {
            path: `${path}.mode`,
            label: `${noun[0]!.toUpperCase()}${noun.slice(1)} rule`,
            description: `Allowlist: only listed ${plural} (an empty list allows none). Blocklist: every ${noun} except blocked ones (an empty list blocks none). Blocked ${plural} always win. Discord permissions still apply.`,
            kind: 'choice' as const,
            choices: ['allowlist', 'blocklist'],
            defaultValue: 'blocklist',
        },
        {
            path: `${path}.allowed`,
            label: `Allowed ${plural}`,
            description: `Discord ${noun} IDs used when the rule is Allowlist.`,
            kind: 'list' as const,
            maxItems,
            defaultValue: [],
            sensitive: true,
        },
        {
            path: `${path}.blocked`,
            label: `Blocked ${plural}`,
            description: `Discord ${noun} IDs that are always excluded, in either rule.`,
            kind: 'list' as const,
            maxItems,
            defaultValue: [],
            sensitive: true,
        },
    ];
}

export const policySettings = [
    ...group('policy', 'discord', 'live', [
        {
            path: 'allowedUserIds',
            apply: 'live',
            label: 'Approved people',
            description:
                'Discord people and bots (by ID) allowed to create requests. Applies live through the people watcher; removal revokes stored reply authority.',
            kind: 'list',
            defaultValue: [],
            maxItems: 100,
            sensitive: true,
        },
        {
            path: 'ownerUserId',
            apply: 'live',
            label: 'Owner',
            description:
                'Discord user ID of the one approved person who owns this Discordinator. The assistant is told who the owner is, by name and ID. Must be one of the approved people; leave empty for none. Only the ID counts: names never grant authority.',
            kind: 'text',
            sensitive: true,
        },
        {
            path: 'allowedRoleIds',
            apply: 'live',
            label: 'Approved roles',
            description: 'Anyone with one of these server roles may create requests, in addition to the approved people.',
            kind: 'list',
            defaultValue: [],
            maxItems: 100,
        },
        ...scopeSettings('servers', 'server', 100),
        ...scopeSettings('channels', 'channel', 1000),
        {
            path: 'scopes',
            label: 'Capability grants',
            description: 'Explicit granted operation families; Discord permissions are checked independently.',
            kind: 'list',
            choices: scopeNames,
            defaultValue: [...scopeNames],
        },
        {
            path: 'triggers.replyToBot',
            label: 'Replies address the bot',
            description: 'Only references verified as messages from this bot qualify.',
            kind: 'boolean',
            defaultValue: true,
        },
        {
            path: 'triggers.matchNames',
            label: 'Name triggers',
            description: 'Requires Message Content access locally and in Discord.',
            kind: 'boolean',
            defaultValue: true,
        },
        {
            path: 'triggers.names',
            label: 'Bot aliases',
            description:
                'Extra names the bot answers to, in chat and in voice calls. Its own Discord names (app name, server nickname, display name, username) always work, and the app name is what it calls itself; add up to ten more, each 2–32 characters.',
            kind: 'list',
            maxItems: 10,
            defaultValue: [],
        },
    ]),
    ...group('policy', 'context', 'live', [
        {
            path: 'context.enabled',
            label: 'Capture recent context',
            description: 'Enable the bounded in-memory message index.',
            kind: 'boolean',
            defaultValue: true,
        },
        {
            path: 'context.capture',
            label: 'Context capture scope',
            description: 'Observed context never creates write authorization.',
            kind: 'choice',
            choices: ['addressed', 'all'],
            defaultValue: 'all',
        },
        {
            path: 'context.reach',
            label: 'History shared with the assistant',
            description:
                'channel: only the channel it was messaged from. server: every channel in that server, grouped by channel. DMs always use their own conversation.',
            kind: 'choice',
            choices: ['channel', 'server'],
            defaultValue: 'server',
        },
        {
            path: 'context.perChannel',
            label: 'Messages per channel',
            description: 'Per-channel retained-message bound.',
            kind: 'integer',
            minimum: 1,
            maximum: 100,
            defaultValue: 50,
        },
        {
            path: 'context.includeBots',
            label: 'Include bot messages in context',
            description:
                'Lets the assistant see messages from other bots (and its own earlier replies) as context. Bots can never trigger it.',
            kind: 'boolean',
            defaultValue: true,
        },
    ]),
    ...group('policy', 'media', 'live', [
        {
            path: 'media.enabled',
            label: 'Enable media',
            description: 'Enable scoped attachment metadata and verified media tools.',
            kind: 'boolean',
            defaultValue: true,
        },
        {
            path: 'media.capture',
            label: 'Media capture scope',
            description: 'Capture addressed or all approved observations.',
            kind: 'choice',
            choices: ['addressed', 'all'],
            defaultValue: 'all',
        },
        {
            path: 'media.maxAttachments',
            label: 'Retained attachments',
            description: 'Maximum attachment-index entries.',
            kind: 'integer',
            minimum: 1,
            maximum: 1000,
            defaultValue: 500,
        },
        {
            path: 'media.ttlMinutes',
            label: 'Media retention',
            description: 'Attachment metadata retention in minutes.',
            kind: 'integer',
            minimum: 1,
            maximum: 60,
            defaultValue: 30,
        },
        {
            path: 'media.maxFileBytes',
            label: 'Maximum file size',
            description: 'Validated upload/download limit in bytes.',
            kind: 'integer',
            minimum: 1,
            maximum: 8388608,
            defaultValue: 2097152,
        },
    ]),
    ...group('policy', 'connections', 'live', [
        {
            path: 'mcpEvents.enabled',
            label: 'Expose MCP Events',
            description: 'Authenticated Events discovery; the host must create a verified subscription.',
            kind: 'boolean',
            defaultValue: true,
        },
        {
            path: 'mcpEvents.allowAllMessages',
            label: 'Allow all-message subscriptions',
            description: 'Separate opt-in; unaddressed messages never authorize replies.',
            kind: 'boolean',
            defaultValue: true,
        },
    ]),
];
