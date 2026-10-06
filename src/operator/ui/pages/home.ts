import { blank, box, hstack, line, span, truncate, width, type Line } from '../canvas.js';
import { color, glyph, tone } from '../theme.js';
import { actionItem, dotFor, heading, note } from '../items.js';
import type { Item, View } from '../model.js';
import {
    assistantName,
    assistants,
    assistantSignal,
    discordSignal,
    operator,
    runtimeSignal,
    savedDiffers,
    type Signal,
} from '../status.js';
import type { OperatingMode } from '../../config.js';
import { wordmark } from '../wordmark.js';

function node(title: string, signal: Signal, caption: string, size: number): Line[] {
    return [
        line([span(truncate(title, size), color.muted, { bold: true })]),
        line([span(`${dotFor(signal.tone)} `, tone[signal.tone]), span(truncate(signal.label, size - 2), color.text, { bold: true })]),
        line([span(truncate(caption, size), color.dim)]),
    ];
}

function link(size: number, flowing: boolean, tick: number, offset: number): Line {
    const cells = Array.from({ length: size }, (_, index) =>
        flowing && (index + offset * 3) % size === tick % size ? glyph.pulse : glyph.flow,
    );
    return line([span(cells.join(''), flowing ? color.violetDeep : color.line)]);
}

function pipeline(view: View, size: number): Line[] {
    const live = operator(view);
    const mode = (live.mode && live.mode !== 'disabled' ? live.mode : view.snapshot.documents.operator.mode) as OperatingMode;
    const [discord, runtime, assistant] = [discordSignal(view), runtimeSignal(view), assistantSignal(view)];
    const flowing = assistant.tone === 'good' && discord.tone === 'good';
    const inner = size - 4;
    const nodeSize = Math.min(20, Math.floor((inner - 6) / 3));
    const gap = Math.floor((inner - nodeSize * 3) / 2);
    const cols = [
        { lines: node('DISCORD', discord, discord.detail, nodeSize), size: nodeSize, bg: color.panel },
        { lines: [blank(), link(gap - 2, flowing, view.tick, 0)], size: gap, bg: color.panel },
        { lines: node('DISCORDINATOR', runtime, runtime.detail, nodeSize), size: nodeSize, bg: color.panel },
        { lines: [blank(), link(gap - 2, flowing, view.tick, 1)], size: gap, bg: color.panel },
        {
            lines: node(assistants[mode]?.provider.toUpperCase() ?? 'ASSISTANT', assistant, assistant.detail, nodeSize),
            size: nodeSize,
            bg: color.panel,
        },
    ];
    return box([blank(), ...hstack(cols, 3), blank()], size, {
        border: flowing ? color.violetDeep : color.line,
        title: [span(` ${glyph.brand} `, color.violet), span(flowing ? 'Live ' : 'Overview ', color.soft, { bold: true })],
    });
}

function tiles(view: View, size: number): Line[] {
    const controller = operator(view).controller;
    const stats: [string, string, string][] = [
        ['In progress', String(controller?.busy ?? 0), 'chats'],
        ['Needs you', String(controller?.approvals ?? 0), 'approvals'],
        ['Unsent', String(controller?.pendingDelivery ?? 0), 'replies'],
    ];
    const tile = Math.floor((size - 2) / 3);
    const cols = stats.map(([title, value, caption], index) => {
        const width = index === 2 ? size - 2 - tile * 2 : tile;
        return {
            lines: box(
                [line([span(title, color.muted)]), line([span(value, color.text, { bold: true }), span(`  ${caption}`, color.dim)])],
                width - (index === 2 ? 0 : 1),
            ),
            size: width,
            bg: color.base,
        };
    });
    return hstack([{ lines: [], size: 2, bg: color.base }, ...cols], 4);
}

const block = (id: string, render: (size: number, view: View) => Line[]): Item => ({
    id,
    lines: (size, _selected, view) => render(size, view),
});

function primary(view: View): Item {
    const mode = operator(view).mode;
    const saved = assistantName(view.snapshot.documents.operator.mode);
    if (mode && mode !== 'disabled' && !savedDiffers(view))
        return actionItem('pause', `${glyph.off} Pause`, { type: 'run', action: 'pause' }, 'Stop answering Discord');
    return actionItem(
        'start',
        `▶ Start ${saved}`,
        { type: 'run', action: 'start' },
        savedDiffers(view) ? 'Waiting for Discordinator to switch' : 'Begin answering Discord',
        'good',
    );
}

function attention(view: View): Item[] {
    const notes: string[] = [];
    if (savedDiffers(view)) notes.push(`You saved ${assistantName(view.observed.active.mode)}, but it is not active yet.`);
    if (!view.observed.live && view.observed.runtime)
        notes.push('Discordinator is running an older build. Restart it to load this version.');
    if (view.changes.length) notes.push(`${view.changes.length} unsaved change${view.changes.length === 1 ? '' : 's'}. Press S to review.`);
    if (!notes.length) return [];
    return [
        heading('attention', 'Needs attention'),
        ...notes.map((value, index) => note(`attention-${index}`, `${glyph.warn} ${value}`, color.amber)),
    ];
}

export function homeItems(view: View): Item[] {
    const recent = view.activity.slice(0, 5);
    return [
        block('brand', () => {
            const [top, bottom] = wordmark();
            return [
                blank(),
                line([span('  '), ...top!.spans]),
                line([span('  '), ...bottom!.spans]),
                line([span('  Discord, answered by your AI', color.muted)]),
            ];
        }),
        block('hero', (size, current) => [blank(), ...pipeline(current, size - 2).map((value) => line([span('  '), ...value.spans]))]),
        block('gap', () => [blank()]),
        primary(view),
        block('tiles', (size, current) => [blank(), ...tiles(current, size)]),
        ...attention(view),
        heading('recent', 'Recent activity'),
        ...(recent.length
            ? recent.map((item, index) =>
                  block(`activity-${index}`, (size) => [
                      line([
                          span('  '),
                          span(`${item.at}  `, color.dim),
                          span(`${dotFor(item.tone)} `, tone[item.tone]),
                          span(truncate(item.text, size - width(item.at) - 8), color.soft),
                      ]),
                  ]),
              )
            : [note('quiet', 'Nothing yet. Actions you take here appear in this list.')]),
    ];
}
