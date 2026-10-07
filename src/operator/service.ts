import { channelHistory, withCall, type History } from './history.js';
import { contextWarning, ThresholdMeter, usageWarning } from './context-meter.js';
import type { Bridge } from '../core/bridge.js';
import type { BotEvent, EventQueue } from '../core/queue.js';
import { claudeChoice, localModes, operatorPath, readOperatorConfig, type OperatorConfig } from './config.js';
import { ConversationController } from './controller.js';
import { ControllerStore } from './controller-state.js';
import { DiscordApprovalDispatcher } from './approval-dispatcher.js';
import { CodexAdapter } from './codex-adapter.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { ProcessingIndicator } from './processing-indicator.js';
import { watchFile } from './file-watch.js';
import { SessionRouter } from './session-router.js';
import { desktopInstalled } from './claude-sessions.js';
import { codexDaemonSocket, daemonTransport } from './codex-daemon.js';
import { codexCommand } from './codex-config.js';
import { localTransport } from './codex-protocol.js';
import type { ProviderAdapter, ProviderNotice, UsageWindow } from './provider-adapter.js';
import { claudeUsage } from './providers.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { requestText } from './request-format.js';
import { ownerNote } from '../core/directory.js';
import { desktopGuide, workerBrief } from './manager-guide.js';

const retryMs = 5000;
const maxAttempts = 3;
type Origin = Pick<BotEvent, 'guildId' | 'channelId' | 'actorId'>;

function logFailure(label: string, error: unknown): void {
    console.error(`${label} ${JSON.stringify({ error: error instanceof Error ? error.name : typeof error })}`);
}

export class OperatorService {
    private stopped = false;
    private cursor = 0;
    private mode = 'disabled';
    private appliedConfigAt: string | null = null;
    private blockedReason: string | null = null;
    private controller?: ConversationController;
    private tasks?: ConversationController;
    private dispatcher?: DiscordApprovalDispatcher;
    private indicator?: ProcessingIndicator;
    private router?: SessionRouter;
    private applying: Promise<void> = Promise.resolve();
    private consuming?: Promise<void>;
    private unwatch?: () => void;
    private idleWaiters: (() => void)[] = [];
    private failures = 0;
    private readonly history: History;
    readonly meter: ThresholdMeter;
    onStatus?: () => void;
    private usageCheckedAt = 0;

    constructor(
        readonly queue: EventQueue,
        readonly bridge: Bridge,
    ) {
        this.history = withCall(channelHistory(bridge.context, bridge.policy, bridge.api), () =>
            bridge.voice ? (guildId, actorId, seen) => bridge.voice!.context(guildId, actorId, seen) : undefined,
        );
        this.meter = new ThresholdMeter((eventId, content, idempotencyKey) => this.bridge.respond({ eventId, content, idempotencyKey }));
        bridge.policy.onChange((previous) => {
            if (!this.controller || previous.ownerUserId === bridge.policy.config.ownerUserId) return;
            this.appliedConfigAt = null;
            this.schedule();
        });
    }

    start(): void {
        if (this.unwatch) return;
        this.unwatch = watchFile(operatorPath, () => this.schedule());
        this.schedule();
        this.consuming = this.consume();
    }
    async stop(): Promise<void> {
        this.stopped = true;
        this.unwatch?.();
        this.queue.close();
        await this.applying;
        await this.retire();
        await this.consuming;
    }
    responder(origin?: Origin) {
        const sessionId = this.router?.conversationId ?? this.controller?.conversation(origin)?.sessionId;
        return { mode: this.mode, controller: this.controller, router: this.router, sessionId };
    }
    status() {
        return {
            supportedConfigVersion: 3,
            mode: this.mode,
            appliedConfigAt: this.appliedConfigAt,
            blockedReason: this.blockedReason,
            controller: this.tasks?.status() ?? null,
            session: this.router?.status() ?? null,
        };
    }
    whenIdle(): Promise<void> {
        return new Promise((resolve) => {
            this.idleWaiters.push(resolve);
            this.releaseIdle();
        });
    }
    private releaseIdle(): void {
        if (this.working()) return;
        for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
    private working(): boolean {
        const status = this.tasks?.status();
        if (!status) return false;
        const active = status.tasks.some((task) => ['queued', 'running', 'approval', 'recovering'].includes(task.state));
        return active || status.busy + status.approvals + status.queued + status.pendingDelivery > 0;
    }
    private recordUsage(windows: UsageWindow[], eventId: string | undefined): void {
        for (const window of windows)
            this.meter.record(
                `usage:${window.label}`,
                window.usedPercent,
                eventId,
                usageWarning(window.label, window.usedPercent, window.resetsAt),
            );
    }
    private activeOrigin(): string | undefined {
        return this.controller?.store.snapshot().conversations.find((item) => item.state !== 'idle')?.originEventId;
    }
    private discordTurnFinished(eventId: string): void {
        if (this.mode !== 'claude-session' || Date.now() - this.usageCheckedAt < 5 * 60_000) return;
        this.usageCheckedAt = Date.now();
        void claudeUsage()
            .then((windows) => this.recordUsage(windows, eventId))
            .catch((error: unknown) => logFailure('Claude usage check failed', error));
    }
    private async notice(event: ProviderNotice): Promise<void> {
        if (event.type === 'usage') return this.recordUsage(event.windows, this.activeOrigin());
        const origin = this.originOf(event.sessionId);
        if (event.type === 'context') return this.meter.record(event.sessionId, event.percent, origin, contextWarning(event.percent));
        if (!origin) return;
        const data = event.path ? await readFile(event.path) : Buffer.from(event.data ?? '', 'base64');
        if (!data.length || data.length > 8 * 1024 * 1024) return;
        await this.bridge
            .deliver(origin, { content: '', files: [{ data, name: 'image.png', contentType: 'image/png' }] }, `image-${randomUUID()}`)
            .catch(() => undefined);
    }

    private originOf(sessionId: string): string | undefined {
        const state = this.tasks?.store.snapshot();
        return [...(state?.conversations ?? []), ...(state?.tasks ?? [])].find((item) => item.sessionId === sessionId)?.originEventId;
    }
    private schedule(): void {
        this.applying = this.applying
            .then(() => this.apply())
            .catch(() => {
                this.blockedReason = 'Operator could not apply configuration or connect';
            })
            .finally(() => this.onStatus?.());
    }
    private async apply(): Promise<void> {
        if (this.stopped) return;
        const config = await readOperatorConfig();
        this.mode = config.enabled ? config.mode : 'disabled';
        this.blockedReason = localBlock(config);
        if (!config.enabled || this.blockedReason) {
            await this.retire();
            this.appliedConfigAt = config.updatedAt;
            return;
        }
        if (!localModes.includes(config.mode)) {
            await this.retire();
            this.appliedConfigAt = config.updatedAt;
            return;
        }
        if (!(await this.prepare(config)) || this.stopped || this.tasks || this.router) return;
        await this.build(config);
    }
    private async build(config: OperatorConfig): Promise<void> {
        if (config.mode === 'claude-session') {
            if (!config.backgroundOnly && (await desktopInstalled())) return this.createRouter(config);
            return this.createController(config, new ClaudeAdapter(), true);
        }
        const socket = config.backgroundOnly ? undefined : await codexDaemonSocket();
        const cli = await codexCommand();
        await this.createController(
            config,
            new CodexAdapter({ spawnTransport: socket ? () => daemonTransport(socket) : (current) => localTransport(current, cli) }),
            Boolean(socket),
        );
    }
    private async consume(): Promise<void> {
        while (!this.stopped) {
            const page = await this.queue.poll(this.cursor, 25, 60_000);
            await this.applying;
            for (const event of page.events) {
                if (!(await this.handle(event))) break;
                this.cursor = event.cursor;
            }
        }
    }
    private async handle(event: BotEvent): Promise<boolean> {
        if (!this.controller && !this.router) {
            if (await this.dispatcher?.accept(event).catch(() => false)) return true;
            await this.unavailable(event, this.blockedReason ?? 'the local assistant is not running');
            return true;
        }
        if (await this.accept(event)) {
            this.failures = 0;
            return true;
        }
        if (++this.failures < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, retryMs));
            return false;
        }
        this.failures = 0;
        await this.unavailable(event, this.blockedReason ?? 'the message could not be handed to the assistant');
        return true;
    }
    private async unavailable(event: BotEvent, reason: string): Promise<void> {
        if (!localModes.includes(this.mode as OperatorConfig['mode'])) return;
        await this.bridge
            .respond({ eventId: event.id, content: `Assistant unavailable: ${reason}`, idempotencyKey: `operator-unavailable-${event.id}` })
            .catch((error: unknown) => logFailure('Operator unavailable notice failed', error));
    }
    private async accept(event: BotEvent): Promise<boolean> {
        try {
            if (await this.dispatcher?.accept(event)) return true;
            if (this.router) await this.router.route(event);
            else await this.controller!.ingest(event);
            this.blockedReason = null;
            return true;
        } catch (error) {
            this.blockedReason = error instanceof Error ? error.message : 'A Discord request could not be handed to the assistant yet';
            return false;
        }
    }
    private async prepare(config: OperatorConfig): Promise<boolean> {
        const status = this.tasks?.status();
        if (status?.failed) {
            await this.retire();
            return true;
        }
        if (this.appliedConfigAt === config.updatedAt) return true;
        if (this.router?.status().busy) {
            this.blockedReason = 'Saved provider changes wait for the current reply to finish';
            return false;
        }
        if (status && (status.busy || status.tasks.some((item) => ['running', 'approval'].includes(item.state)))) {
            this.blockedReason = 'Saved provider changes wait for existing work to finish';
            return false;
        }
        await this.retire();
        return true;
    }
    private async retire(): Promise<void> {
        const controller = this.tasks;
        this.controller = undefined;
        this.tasks = undefined;
        this.dispatcher = undefined;
        this.router?.stop();
        this.router = undefined;
        this.indicator?.stop();
        this.indicator = undefined;
        await controller?.stop();
    }
    private async createRouter(config: OperatorConfig): Promise<void> {
        this.router = new SessionRouter(this.bridge, config.workspace, {
            ...(config.claudeModel ? { model: config.claudeModel } : {}),
            ...(config.claudeEffort ? { effort: config.claudeEffort } : {}),
            activity: config.activityVisibility,
            history: this.history,
            finished: (eventId) => this.discordTurnFinished(eventId),
            changed: () => {
                this.schedule();
                this.onStatus?.();
            },
            brief: () => [desktopGuide(claudeChoice(config, true)), this.standing(config)].filter(Boolean).join('\n\n'),
        });
        await this.router.start();
        this.appliedConfigAt = config.updatedAt;
    }
    private standing(config: OperatorConfig): string {
        return [ownerNote(this.bridge.policy, this.bridge.people), config.instructions].filter(Boolean).join('\n\n');
    }
    private async withOwner(config: OperatorConfig): Promise<OperatorConfig> {
        await this.bridge.people.approved();
        const instructions = this.standing(config);
        return instructions ? { ...config, instructions } : config;
    }
    private async createController(config: OperatorConfig, adapter: ProviderAdapter, shared: boolean, primary = true): Promise<void> {
        const dispatcher = new DiscordApprovalDispatcher(this.bridge, (key, decision, origin) =>
            this.tasks!.resolveApproval(key, decision, origin),
        );
        const indicator = new ProcessingIndicator((eventId) => this.bridge.typing(eventId));
        const controller = new ConversationController(
            adapter,
            await this.withOwner(config),
            new ControllerStore(`.data/controller-${config.mode}.json`),
            (eventId, content, idempotencyKey, loose) => this.bridge.respond({ eventId, content, idempotencyKey, status: loose }),
            (request, origin) => dispatcher.request(request, origin),
            {
                activity: config.activityVisibility,
                workerCapacity: 2,
                invalidateApproval: (key) => (key ? dispatcher.invalidate(key) : dispatcher.invalidateAll()),
                processing: (sessionId, eventId, active) => {
                    indicator.set(sessionId, eventId, active);
                    if (!active) this.discordTurnFinished(eventId);
                },
                changed: () => {
                    this.schedule();
                    this.releaseIdle();
                    this.onStatus?.();
                },
                ...(shared ? { sharedConversation: 'discordinator' } : {}),
                history: this.history,
                describe: (event) => requestText(this.bridge.policy, event),
                brief: (eventId, title, prompt) => this.brief(eventId, title, prompt),
                notice: (event) => void this.notice(event).catch((error: unknown) => logFailure('Operator notice failed', error)),
            },
        );
        this.tasks = controller;
        if (primary) this.controller = controller;
        this.dispatcher = dispatcher;
        this.indicator = indicator;
        await controller.start();
        this.appliedConfigAt = config.updatedAt;
    }
    private brief(eventId: string, title: string, prompt: string): string {
        const origin = (() => {
            try {
                return requestText(this.bridge.policy, this.queue.context(eventId).event).split('\n')[0];
            } catch {
                return undefined;
            }
        })();
        return workerBrief(title, prompt, eventId, origin);
    }
}
function localBlock(config: OperatorConfig): string | null {
    if (!config.enabled || !localModes.includes(config.mode)) return null;
    return config.exclusiveLocal ? null : 'Exclusive local ownership is not confirmed';
}
