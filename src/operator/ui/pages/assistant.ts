import { publicDomainBlock } from '../../connection-domain.js';
import type { OperatingMode } from '../../config.js';
import { box, line, span, wrap, type Line, type Span } from '../canvas.js';
import { color, glyph } from '../theme.js';
import { actionItem, heading, note, section, settingItem } from '../items.js';
import type { Item, View } from '../model.js';
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

function readiness(mode: OperatingMode, view: View): Span[] {
    if (publicDomainBlock(mode, view.drafts.environment))
        return [span(`${glyph.off} Unavailable: needs a public domain (Apps page)`, color.amber)];
    const check = (ok: boolean | undefined, label: string): Span[] => [
        span(ok ? `${glyph.check} ` : `${glyph.off} `, ok ? color.mint : color.dim),
        span(`${label}   `, ok ? color.soft : color.muted),
    ];
    if (mode === 'claude-session')
        return [
            ...check(view.extras.apps['claude-code']?.connected, 'Discord tools connected'),
            ...check(operator(view).session?.live, 'Live in Claude Desktop'),
        ];
    if (mode === 'chatgpt-events') return check((view.observed.live?.events.subscriptions ?? 0) > 0, 'Wake-ups connected');
    if (mode === 'manual-mcp') return [span('Connect your app from the Apps page', color.muted)];
    return [span('One ongoing conversation that survives restarts', color.muted)];
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
                line([span('  '), ...readiness(mode, view)]),
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

function modeSettings(mode: OperatingMode): Item[] {
    if (mode === 'claude-session')
        return [
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
            settingItem('operator.workspace', 'Working folder'),
            settingItem('operator.backgroundOnly', 'Always run in the background'),
            ...background('codex'),
        ];
    if (mode === 'manual-mcp') return [settingItem('operator.publicEndpoint', 'MCP endpoint URL')];
    return [note('chatgpt-note', chatgptHowTo)];
}

export function assistantItems(view: View): Item[] {
    const mode = view.drafts.operator.mode as OperatingMode;
    const modes = offered.includes(mode) ? offered : [...offered, mode];
    return [
        heading('who', 'Primary responder', 'Exactly one answers new Discord messages'),
        ...modes.map(card),
        ...section('mode-settings', `${assistants[mode].name} settings`, '', modeSettings(mode)),
    ];
}
