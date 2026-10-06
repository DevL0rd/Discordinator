import { settingsUpdate } from '../mcp/settings.js';
import { readOperatorConfig, type OperatingMode, type OperatorConfig } from './config.js';
import { claudeModels, claudeUsage, codexModels } from './providers.js';
import type { UsageWindow } from './provider-adapter.js';
import type { OperatorService } from './service.js';
import { assistantName } from './ui/status.js';

export type CommandReply = { title: string; lines: string[]; tone: 'info' | 'good' | 'warn' };
export type CommandOptions = Record<string, string | undefined>;

const desktopOnly = 'Claude Desktop conversations can only do this from Claude Desktop itself. Open the Discordinator conversation there.';
const bar = (percent: number) => {
    const filled = Math.min(10, Math.max(0, Math.round(percent / 10)));
    return `\`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\` ${percent}%`;
};
function resetsIn(iso?: string): string {
    if (!iso) return '';
    const minutes = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
    const text =
        minutes >= 1440
            ? `${Math.round(minutes / 1440)}d`
            : minutes >= 60
              ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
              : `${minutes}m`;
    return ` · resets in ${text}`;
}
const windowLine = (window: UsageWindow) => `**${window.label}** ${bar(window.usedPercent)}${resetsIn(window.resetsAt)}`;
const isClaude = (mode: string) => mode === 'claude-session';
const modelOf = (config: OperatorConfig) =>
    (isClaude(config.mode) ? config.claudeModel : config.mode === 'codex-local' ? config.codexModel : undefined) || 'default';
function stateText(mode: string, busy: boolean, live: boolean): string {
    const state = mode === 'disabled' ? 'paused' : busy ? 'working' : 'ready';
    return live ? `${state} · live in Claude Desktop` : state;
}

export class CommandService {
    constructor(readonly operator: OperatorService) {}

    run(name: string, options: CommandOptions): Promise<CommandReply> {
        const handlers: Record<string, () => Promise<CommandReply>> = {
            status: () => this.status(),
            usage: () => this.usage(),
            compact: () => this.compact(),
            new: () => this.fresh(),
            stop: () => this.stop(),
            activity: () => this.change('Activity updates', 'operator.activityVisibility', options.mode === 'on'),
            responder: () => this.change('Responder', 'operator.mode', options.name),
            model: () => this.model(options.name ?? ''),
        };
        const handler = handlers[name];
        if (!handler) return Promise.reject(new Error('Unknown command'));
        return handler();
    }

    private context(): string {
        const { sessionId } = this.operator.responder();
        const percent = sessionId ? this.operator.meter.percent(sessionId) : undefined;
        return percent === undefined ? '**Context** not measured yet; it updates after the next reply' : `**Context** ${bar(percent)}`;
    }

    private async status(): Promise<CommandReply> {
        const config = await readOperatorConfig();
        const { mode, controller, router } = this.operator.responder();
        return {
            title: assistantName(config.mode),
            tone: mode === 'disabled' ? 'warn' : 'good',
            lines: [
                `**State** ${stateText(mode, (controller?.status().busy ?? 0) > 0, Boolean(router?.live))}`,
                `**Model** ${modelOf(config)}`,
                `**Activity updates** ${config.activityVisibility ? 'on' : 'off'}`,
                this.context(),
            ],
        };
    }

    private async usage(): Promise<CommandReply> {
        const { mode, controller } = this.operator.responder();
        let windows: UsageWindow[];
        if (isClaude(mode)) windows = await claudeUsage();
        else if (controller?.adapter.usage) windows = await controller.adapter.usage();
        else throw new Error('Plan usage is available for Claude Code and Codex responders.');
        return { title: `${assistantName(mode)} usage`, tone: 'info', lines: [...windows.map(windowLine), this.context()] };
    }

    private async compact(): Promise<CommandReply> {
        const { router, controller, sessionId } = this.operator.responder();
        if (router) throw new Error(desktopOnly);
        if (!controller?.adapter.compact || !sessionId) throw new Error('There is no conversation to compact yet.');
        await controller.adapter.compact(sessionId);
        return { title: 'Compacting', tone: 'good', lines: ['The conversation is being compacted to free up context.'] };
    }

    private async fresh(): Promise<CommandReply> {
        const { router, controller } = this.operator.responder();
        if (!router && !controller) throw new Error('No local responder is running.');
        await (router ? router.reset() : controller!.reset());
        return { title: 'Fresh start', tone: 'good', lines: ['The next message starts a new conversation, with recent channel history.'] };
    }

    private async stop(): Promise<CommandReply> {
        const { router, controller } = this.operator.responder();
        if (router) throw new Error(desktopOnly);
        const running = (controller?.store.snapshot().conversations ?? []).filter(
            (item) => item.sessionId && item.turnId && item.state !== 'idle',
        );
        if (!running.length) return { title: 'Nothing to stop', tone: 'info', lines: ['The assistant is not working on anything.'] };
        for (const item of running) await controller!.adapter.interrupt(item.sessionId!, item.turnId!);
        return { title: 'Stopped', tone: 'good', lines: ['The current work was interrupted.'] };
    }

    private async change(label: string, id: string, value: unknown): Promise<CommandReply> {
        const message = await settingsUpdate([{ id, value }]);
        return { title: label, tone: 'good', lines: [message] };
    }

    private async model(name: string): Promise<CommandReply> {
        const { mode } = await readOperatorConfig();
        const claude = isClaude(mode);
        if (!claude && mode !== 'codex-local') throw new Error('Models can be chosen for Claude Code and Codex responders.');
        const models = claude ? await claudeModels() : await codexModels();
        const wanted = name.trim().toLowerCase() === 'default' ? '' : name.trim();
        if (wanted && !models.models.some((model) => model.id === wanted))
            throw new Error(`Unknown model. Choose one of: default, ${models.models.map((model) => model.id).join(', ')}`);
        return this.change('Model', claude ? 'operator.claudeModel' : 'operator.codexModel', wanted);
    }
}

export const responderChoices: OperatingMode[] = ['claude-session', 'codex-local', 'chatgpt-events', 'manual-mcp'];
