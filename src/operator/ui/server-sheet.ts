import { openInBrowser } from '../web-connectors.js';
import { inviteLink } from '../onboarding-invite.js';
import { serverState, withServerAllowed, withServerChannels, type ServerInfo } from '../servers.js';
import type { SettingDefinition } from '../settings-registry.js';
import { confirm, type Store } from './effects.js';
import type { Sheet } from './sheets.js';
import { logged } from './state.js';

const channelsPrefix = 'server-channels:';
const find = (store: Store, id: string) => store.get().extras.servers?.servers.find((server) => server.id === id);

function stage(store: Store, policy: Record<string, unknown>, message: string): void {
    store.set((state) => logged({ ...state, sheet: undefined, drafts: { ...state.drafts, policy } }, message, 'info'));
}

function channelSheet(store: Store, server: ServerInfo): void {
    const field: SettingDefinition = {
        id: `${channelsPrefix}${server.id}`,
        source: 'policy',
        path: 'channels',
        page: 'discord',
        label: `Channels in ${server.name}`,
        description: 'Space toggles a channel, A selects all, Enter keeps your choice.',
        kind: 'list',
        choices: server.channels.map((channel) => channel.id),
        apply: 'live',
    };
    const labels = Object.fromEntries(server.channels.map((channel) => [channel.id, `#${channel.name}`]));
    const chosen = serverState(store.get().drafts.policy, server).channels;
    store.set((state) => ({ ...state, sheet: { kind: 'multi', field, label: field.label, chosen, index: 0, labels } }));
}

function serverSheet(store: Store, id: string): void {
    const server = find(store, id);
    if (!server) return;
    const policy = store.get().drafts.policy;
    const state = serverState(policy, server);
    confirm(
        store,
        server.name,
        [
            state.allowed
                ? `Discordinator answers here in ${state.channels.length} of ${server.channels.length} channels.`
                : 'Discordinator does not answer in this server.',
            'Changes are staged until you press S to save.',
        ],
        [
            {
                label: state.allowed ? 'Stop answering here' : 'Answer in this server',
                tone: state.allowed ? 'bad' : 'good',
                run: () =>
                    stage(
                        store,
                        withServerAllowed(policy, id, !state.allowed),
                        `${server.name}: ${state.allowed ? 'turned off' : 'turned on'}. Press S to save.`,
                    ),
            },
            { label: 'Choose channels', tone: 'info', run: () => channelSheet(store, server) },
            { label: 'Close', tone: 'idle', run: () => store.set((current) => ({ ...current, sheet: undefined })) },
        ],
    );
}

export const isServerChannels = (sheet: Extract<Sheet, { kind: 'multi' }>) => sheet.field.id.startsWith(channelsPrefix);

export function commitServerChannels(store: Store, sheet: Extract<Sheet, { kind: 'multi' }>): void {
    const server = find(store, sheet.field.id.slice(channelsPrefix.length));
    if (!server) return;
    stage(
        store,
        withServerChannels(store.get().drafts.policy, server, sheet.chosen),
        `Channels for ${server.name} staged. Press S to save.`,
    );
}

function inviteServer(store: Store): void {
    const botId = store.get().extras.servers?.botId;
    if (!botId) return store.set((state) => logged(state, 'The bot has not loaded yet. Press R to refresh, then try again.', 'warn'));
    void openInBrowser(inviteLink(botId)).catch(() => undefined);
    store.set((state) => logged(state, 'Opened the invite in your browser. After adding the bot, press R to see the new server.', 'info'));
}

export function openServer(store: Store, id?: string): void {
    if (id) serverSheet(store, id);
    else inviteServer(store);
}
