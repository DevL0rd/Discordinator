import type { OperatingMode } from '../config.js';
import type { Tone } from './theme.js';
import type { View } from './model.js';

export const assistants: Record<OperatingMode, { name: string; provider: string; blurb: string }> = {
    'claude-session': {
        name: 'Claude Code',
        provider: 'Claude',
        blurb: 'Discord messages go to one ongoing Claude conversation. With Claude Desktop installed it opens there, starting the app if needed, so you can watch and chat; otherwise it runs in the background.',
    },
    'codex-local': {
        name: 'Codex',
        provider: 'Codex',
        blurb: 'Discord messages go to one ongoing Codex conversation in the shared Codex service on this computer, so any Codex app attached to it can follow along. Uses your Codex login.',
    },
    'chatgpt-events': {
        name: 'ChatGPT - Dot',
        provider: 'ChatGPT',
        blurb: 'New messages wake your Discordinator app in ChatGPT through your public domain.',
    },
    'chatgpt-poll': {
        name: 'ChatGPT · scheduled checks',
        provider: 'ChatGPT',
        blurb: 'A scheduled ChatGPT task checks Discordinator for new messages.',
    },
    'manual-mcp': {
        name: 'Another MCP app',
        provider: 'Your app',
        blurb: 'Any MCP-capable app connects to Discordinator and answers messages itself.',
    },
};
export const assistantName = (mode: unknown): string => assistants[mode as OperatingMode]?.name ?? 'Paused';

export interface Signal {
    label: string;
    detail: string;
    tone: Tone;
}
type Operator = { mode?: string; blockedReason?: string | null; session?: { live?: boolean } | null; controller?: Controller | null };
type Controller = {
    connected?: boolean;
    failed?: boolean;
    busy?: number;
    approvals?: number;
    pendingDelivery?: number;
    deliveryError?: string | null;
};
export const operator = (view: View): Operator => view.observed.live?.operator ?? {};

export function runtimeSignal(view: View): Signal {
    if (view.observed.live) return { label: 'Running', detail: 'Bridge is up', tone: 'good' };
    if (view.observed.runtime) return { label: 'Outdated', detail: 'Restart to update', tone: 'warn' };
    return { label: 'Stopped', detail: 'Not running', tone: 'bad' };
}

export function discordSignal(view: View): Signal {
    const gateway = view.observed.live?.gateway;
    if (gateway === 'ready') return { label: 'Connected', detail: 'Bot online', tone: 'good' };
    if (!gateway) return { label: 'Unknown', detail: 'Not reporting', tone: 'idle' };
    return { label: 'Connecting', detail: gateway, tone: 'warn' };
}

const modeSignals: Partial<Record<OperatingMode, (live: Operator, view: View) => Signal>> = {
    'claude-session': (live) => {
        if (!live.session) return controllerSignal(live.controller);
        return live.session.live
            ? { label: 'Listening', detail: 'Live in Desktop', tone: 'good' }
            : { label: 'Ready', detail: 'Opens Desktop on demand', tone: 'good' };
    },
    'codex-local': (live) => controllerSignal(live.controller),
    'chatgpt-events': (_live, view) =>
        (view.observed.live?.events.subscriptions ?? 0) > 0
            ? { label: 'Listening', detail: 'Chat subscribed', tone: 'good' }
            : { label: 'Waiting', detail: 'No chat subscribed', tone: 'warn' },
};

export function assistantSignal(view: View): Signal {
    const live = operator(view);
    const mode = live.mode as OperatingMode | 'disabled' | undefined;
    if (!view.observed.live || !mode) return { label: 'Offline', detail: 'Nothing running', tone: 'idle' };
    if (mode === 'disabled') return { label: 'Paused', detail: 'Not answering Discord', tone: 'idle' };
    if (live.blockedReason) return { label: 'Blocked', detail: live.blockedReason, tone: 'warn' };
    return modeSignals[mode]?.(live, view) ?? { label: 'External', detail: 'Managed by your app', tone: 'info' };
}

function controllerSignal(controller?: Controller | null): Signal {
    if (!controller) return { label: 'Starting', detail: 'Connecting', tone: 'warn' };
    if (controller.failed) return { label: 'Reconnecting', detail: 'Restarting', tone: 'warn' };
    if (controller.deliveryError) return { label: 'Listening', detail: 'Retrying a reply', tone: 'warn' };
    return controller.busy
        ? { label: 'Working', detail: `${controller.busy} in progress`, tone: 'good' }
        : { label: 'Listening', detail: 'Ready for messages', tone: 'good' };
}

export function savedDiffers(view: View): boolean {
    const active = operator(view).mode;
    const saved = view.snapshot.documents.operator;
    return Boolean(view.observed.live) && saved.enabled !== false && active !== saved.mode && active !== undefined;
}

export const chatgptHowTo =
    'In ChatGPT, open a chat with the Discordinator app and ask: “Turn on automatic wake-ups for new Discord messages addressed to you.” That chat then answers Discord.';
