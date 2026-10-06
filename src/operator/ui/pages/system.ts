import { settings } from '../../settings-registry.js';
import { serviceDescription } from '../../service-status.js';
import { actionItem, note, section, settingItem, statusItem } from '../items.js';
import type { Item, View } from '../model.js';

export const memoryItems = (): Item[] => [
    ...section('context', 'Conversation memory', 'What the assistant sees of your Discord', [
        settingItem('policy.context.enabled', 'Remember recent messages'),
        settingItem('policy.context.capture', 'What to remember'),
        settingItem('policy.context.reach', 'History the assistant sees'),
        settingItem('policy.context.perChannel', 'Messages kept per channel'),
        settingItem('policy.context.includeBots', 'Include other bots'),
    ]),
    ...section('media', 'Images and files', 'Attachments the assistant can open', [
        settingItem('policy.media.enabled', 'Allow images and files'),
        settingItem('policy.media.capture', 'Which attachments to track'),
        settingItem('policy.media.maxAttachments', 'Attachments kept'),
        settingItem('policy.media.ttlMinutes', 'Keep for (minutes)'),
        settingItem('policy.media.maxFileBytes', 'Largest file'),
    ]),
];

const elsewhere = new Set([
    'environment.DISCORDINATOR_RESOURCE_URL',
    'environment.DISCORDINATOR_AUTH_MODE',
    'environment.DISCORDINATOR_OAUTH_SERVER',
    'environment.DISCORD_BOT_TOKEN',
    'environment.DISCORDINATOR_MESSAGE_CONTENT',
    'environment.DISCORDINATOR_GUILD_MEMBERS',
]);
const advanced = settings.filter((field) => field.source === 'environment' && !elsewhere.has(field.id)).map((field) => field.id);

export function systemItems(view: View): Item[] {
    const service = view.observed.service;
    const state = serviceDescription(service);
    return [
        ...section('service', 'Background service', 'Keeps Discordinator running after you log out', [
            statusItem(
                'service-state',
                'Service',
                `${state.charAt(0).toUpperCase()}${state.slice(1)}`,
                service.active ? 'good' : service.installed ? 'warn' : 'idle',
            ),
            actionItem(
                'install-service',
                service.installed ? 'Reinstall service' : 'Install service',
                { type: 'run', action: 'install-service' },
                'Builds, then installs a user service',
            ),
            ...(service.active
                ? [
                      actionItem(
                          'restart-service',
                          'Restart Discordinator',
                          { type: 'run', action: 'restart-service' },
                          'Restarts the background service',
                          'warn',
                      ),
                  ]
                : []),
        ]),
        ...section('events', 'ChatGPT wake-ups', 'How ChatGPT hears about new messages', [
            settingItem('policy.mcpEvents.enabled', 'Offer wake-up events'),
            settingItem('policy.mcpEvents.allowAllMessages', 'Allow all-message subscriptions'),
        ]),
        ...section(
            'advanced',
            'Advanced',
            'Most people never need these',
            advanced.map((id) => settingItem(id)),
        ),
        ...section('backups', 'Backups', '', [
            note('backups-note', 'Before every save Discordinator keeps a private copy of the previous file in .data/setup-backups.'),
        ]),
    ];
}
