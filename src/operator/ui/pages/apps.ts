import { scalar } from '../../../core/text.js';
import { publicDomain } from '../../connection-domain.js';
import { appNames, statusHint, type AppId } from '../../connections.js';
import { connectorStatus } from '../../web-connectors.js';
import { line, span } from '../canvas.js';
import { actionItem, card, heading, note, pill, section, settingItem } from '../items.js';
import type { Item, View } from '../model.js';
import { color, type Tone } from '../theme.js';

function appTone(status: string): Tone {
    if (status === 'Connected') return 'good';
    return status === 'Not connected' || status === 'Not installed' ? 'idle' : 'warn';
}

function appCard(id: string, title: string, status: string, about: string, action: `app-${AppId}` | 'web-chatgpt'): Item {
    return card({
        id,
        intent: { type: 'run', action },
        title,
        badge: pill(status, appTone(status)),
        body: [line([span(about, color.soft)]), line([span(statusHint[status] ?? '', color.muted)])],
    });
}

const claudeAbout = (domain: string) =>
    domain
        ? 'Discord tools through your claude.ai connector, also on the web and phone.'
        : 'Discord tools for every Claude Code session through a local plugin.';

export function appsItems(view: View): Item[] {
    const domain = publicDomain(view.drafts.environment.DISCORDINATOR_RESOURCE_URL);
    const url = domain ? `https://${domain}/mcp` : undefined;
    const status = (id: AppId) => view.extras.apps[id]?.status ?? 'Checking…';
    const chatgpt = domain ? connectorStatus(view.extras.web?.chatgpt, url).text : 'Needs a public domain';
    const wakeups = view.observed.live?.events.subscriptions ?? 0;
    return [
        heading('apps-local', 'On this computer', 'Connect as many as you like'),
        appCard('app-claude-code', appNames['claude-code'], status('claude-code'), claudeAbout(domain), 'app-claude-code'),
        appCard('app-codex', appNames.codex, status('codex'), 'Discord tools for Codex on this computer, with no sign-in.', 'app-codex'),
        heading('apps-cloud', 'In the cloud', domain ? `Reached through ${domain}` : 'Set a public domain below to use these'),
        appCard(
            'web-chatgpt',
            'ChatGPT',
            chatgpt,
            wakeups
                ? `Answers Discord · ${wakeups} wake-up${wakeups === 1 ? '' : 's'} active`
                : 'Reads Discord and can answer through wake-ups.',
            'web-chatgpt',
        ),
        ...section('address', 'Your public address', 'Optional · for cloud apps', [
            note(
                'address-port',
                `Point your domain (Cloudflare Tunnel or a reverse proxy) at http://127.0.0.1:${scalar(view.drafts.environment.DISCORDINATOR_PORT) || '8787'}.`,
            ),
            settingItem('environment.DISCORDINATOR_RESOURCE_URL', 'Public domain'),
            actionItem('sign-in-password', 'Sign-in password', { type: 'run', action: 'sign-in-password' }, 'Set or change it'),
        ]),
        actionItem('refresh-apps', 'Check again', { type: 'run', action: 'refresh' }, 'Re-reads every app'),
    ];
}
