import { mcpAddresses, publicDomain } from '../../connection-domain.js';
import { connectorStatus } from '../../web-connectors.js';
import type { OperatingMode } from '../../config.js';
import { box, line, span, wrap, type Line, type Span } from '../canvas.js';
import { color, glyph } from '../theme.js';
import { actionItem, heading, note, section, settingItem } from '../items.js';
import type { Item, View } from '../model.js';
import type { AppId } from '../../connections.js';
import { assistants, chatgptHowTo, operator } from '../status.js';

const offered: OperatingMode[] = ['claude-session', 'codex-local', 'chatgpt-events', 'manual-mcp'];

function badge(mode: OperatingMode, view: View): Span[] {
    const active = operator(view).mode === mode;
    const saved = view.snapshot.documents.operator.mode === mode;
    const chosen = view.drafts.operator.mode === mode;
    if (chosen && !saved) return [span(' SELECTED · UNSAVED ', color.ink, { bg: color.amber, bold: true })];
    if (active) return [span(' ACTIVE ', color.ink, { bg: color.mint, bold: true })];
    if (saved) return [span(' SAVED ', color.ink, { bg: color.violet, bold: true })];
    return [];
}
const badgeWidth = (mode: OperatingMode, view: View) => badge(mode, view).reduce((total, item) => total + item.text.length, 0);

const check = (ok: boolean | undefined, label: string): Span[] => [
    span(ok ? `${glyph.check} ` : `${glyph.off} `, ok ? color.mint : color.dim),
    span(`${label}   `, ok ? color.soft : color.muted),
];

function desktop(view: View): Span[] {
    if (view.drafts.operator.backgroundOnly === true) return [];
    if (operator(view).session?.live) return check(true, 'Live in Claude Desktop');
    return [span(`${glyph.pending} Opens in Claude Desktop when needed`, color.muted)];
}

function chatgptReadiness(view: View): Span[][] {
    const domain = publicDomain(view.drafts.environment.DISCORDINATOR_RESOURCE_URL);
    const added = domain && connectorStatus(view.extras.web?.chatgpt, `https://${domain}/mcp`).current;
    const policy = view.drafts.policy as { mcpEvents?: { enabled?: boolean } };
    return [
        check(Boolean(domain), 'Public domain set (Apps page)'),
        check(view.extras.password, 'Sign-in password set (Apps page)'),
        check(Boolean(added), 'ChatGPT (web) connector added'),
        check(policy.mcpEvents?.enabled, 'Wake-up events allowed'),
        check((view.observed.live?.events.subscriptions ?? 0) > 0, 'A ChatGPT chat turned on wake-ups'),
    ];
}

function readiness(mode: OperatingMode, view: View): Span[][] {
    if (mode === 'claude-session')
        return [[...check(view.extras.apps['claude-code']?.connected, 'Discord tools connected'), ...desktop(view)]];
    if (mode === 'codex-local') return [check(view.extras.apps.codex?.connected, 'Discord tools connected')];
    if (mode === 'chatgpt-events') return chatgptReadiness(view);
    return [[span('Your MCP app connects to the addresses below and answers itself.', color.muted)]];
}

function card(mode: OperatingMode): Item {
    return {
        id: `mode:${mode}`,
        intent: { type: 'mode', mode },
        lines: (size, selected, view) => {
            const chosen = view.drafts.operator.mode === mode;
            const bg = selected ? color.raised : color.panel;
            const inner = size - 8;
            const title: Line = line([
                span(chosen ? glyph.radioOn : glyph.radioOff, chosen ? color.violet : color.dim),
                span(` ${assistants[mode].name}`, chosen || selected ? color.text : color.soft, { bold: true }),
                span(' '.repeat(Math.max(1, size - 8 - assistants[mode].name.length - badgeWidth(mode, view)))),
                ...badge(mode, view),
            ]);
            const rows = [
                title,
                ...wrap(assistants[mode].blurb, inner - 2).map((value) => line([span(`  ${value}`, color.muted)])),
                ...readiness(mode, view).map((row) => line([span('  '), ...row])),
            ];
            return box(rows, size - 2, { border: selected ? color.violet : chosen ? color.violetDeep : color.line, bg }).map((value) => ({
                ...line([span('  '), ...value.spans]),
                target: `mode:${mode}`,
            }));
        },
    };
}

const background = (provider: 'claude' | 'codex'): Item[] => [
    settingItem(`operator.${provider}Model`, 'Model'),
    settingItem(`operator.${provider}Effort`, 'Thinking effort'),
    settingItem('operator.instructions', 'Extra instructions'),
    settingItem('operator.progressSeconds', 'Progress update every (s)'),
    settingItem('operator.timeoutSeconds', 'Time limit (s, 0 = none)'),
    settingItem('operator.activityVisibility', 'Show tool activity in Discord'),
];

const tools = (app: AppId, view: View): Item =>
    actionItem(`tools-${app}`, 'Discord tools', { type: 'run', action: `app-${app}` }, view.extras.apps[app]?.status ?? 'Checking…');

function modeSettings(mode: OperatingMode, view: View): Item[] {
    if (mode === 'claude-session')
        return [
            tools('claude-code', view),
            settingItem('operator.workspace', 'Working folder'),
            settingItem('operator.backgroundOnly', 'Always run in the background'),
            actionItem(
                'open-session',
                'Open in Claude Desktop',
                { type: 'run', action: 'open-session' },
                'Starts the app if needed',
                'good',
            ),
            note(
                'claude-note',
                'The settings below apply when it runs in the background. In Claude Desktop you choose the model in the app.',
            ),
            ...background('claude'),
        ];
    if (mode === 'codex-local')
        return [
            tools('codex', view),
            settingItem('operator.workspace', 'Working folder'),
            settingItem('operator.backgroundOnly', 'Always run in the background'),
            ...background('codex'),
        ];
    if (mode === 'manual-mcp') return mcpAddresses(view.drafts.environment).map((text, index) => note(`mcp-address-${index}`, text));
    return [
        actionItem('chatgpt-guide', 'ChatGPT connector guide', { type: 'run', action: 'chatgpt-guide' }, 'Add it and turn on wake-ups'),
        settingItem('policy.mcpEvents.enabled', 'Allow wake-up events'),
        note('chatgpt-note', chatgptHowTo),
    ];
}

export function assistantItems(view: View): Item[] {
    const mode = view.drafts.operator.mode as OperatingMode;
    const modes = offered.includes(mode) ? offered : [...offered, mode];
    return [
        heading('who', 'Primary responder', 'Exactly one answers new Discord messages'),
        ...modes.map(card),
        ...section('mode-settings', `${assistants[mode].name} settings`, '', modeSettings(mode, view)),
    ];
}
