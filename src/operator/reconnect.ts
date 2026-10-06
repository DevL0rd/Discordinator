import { appNames, appState, disconnectApp, type AppId } from './connections.js';
import { forgetChatgpt } from './web-connectors.js';
import type { SettingChange } from './settings-registry.js';

const affected: Record<string, { apps: AppId[]; web: boolean; reason: string }> = {
    'environment.DISCORDINATOR_PORT': { apps: ['codex'], web: false, reason: 'the port changed' },
    'environment.DISCORDINATOR_RESOURCE_URL': { apps: ['claude-code'], web: true, reason: 'the public address changed' },
    'environment.DISCORDINATOR_AUTH_MODE': { apps: [], web: true, reason: 'how apps sign in changed' },
    'environment.DISCORDINATOR_OAUTH_SERVER': { apps: [], web: true, reason: 'the sign-in provider changed' },
};

export async function disconnectAffected(changes: readonly SettingChange[]): Promise<string> {
    const hits = changes.flatMap((change) => (affected[change.id] ? [affected[change.id]!] : []));
    if (!hits.length) return '';
    const apps = [...new Set(hits.flatMap((hit) => hit.apps))];
    const disconnected: string[] = [];
    for (const app of apps) {
        if (!(await appState(app)).connected) continue;
        await disconnectApp(app).catch(() => undefined);
        disconnected.push(appNames[app]);
    }
    const web = hits.some((hit) => hit.web);
    if (web) await forgetChatgpt();
    const reasons = [...new Set(hits.map((hit) => hit.reason))].join(' and ');
    const names = [...disconnected, ...(web ? ['ChatGPT and Claude on the web'] : [])];
    return names.length ? ` Because ${reasons}, reconnect ${names.join(', ')} on the Apps page.` : '';
}
