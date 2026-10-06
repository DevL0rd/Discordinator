import { withHistory, type History } from './history.js';
import { progressPost } from './activity-format.js';
import { randomUUID } from 'node:crypto';
import type { BotEvent } from '../core/queue.js';
import type { OperatorConfig } from './config.js';
import { ControllerStore, controllerStatus, conversationKey, type ControllerTask } from './controller-state.js';
import type { ApprovalDecision, ProviderAdapter, ProviderApproval, ProviderEvent, ProviderNotice } from './provider-adapter.js';
import { isNotice } from './provider-adapter.js';
import { controllerTools } from './controller-tools.js';
import { recoverController } from './controller-recovery.js';
import { appendReply, ControllerOutbox } from './controller-outbox.js';

export type ControllerDelivery = (eventId: string, content: string, key: string, loose: boolean) => Promise<unknown>;
export type ControllerApprovalDelivery = (request: ProviderApproval, originEventId: string) => Promise<void>;
export type ControllerOptions = {
    activity?: boolean;
    workerCapacity?: number;
    invalidateApproval?: (key?: string) => void;
    processing?: (sessionId: string, eventId: string, processing: boolean) => void;
    changed?: () => void;
    sharedConversation?: string;
    history?: History;
    notice?: (event: ProviderNotice) => void;
};

export class ConversationController {
    private generation = 0;
    private connected = false;
    private epoch?: string;
    private stopped = false;
    private pumping = false;
    private pumpAgain = false;
    private readonly outbox: ControllerOutbox;
    private approvals = new Map<string, { request: ProviderApproval; originEventId: string }>();
    private progressAt = new Map<string, number>();
    private approvalDeliveryError: string | null = null;
    private failed = false;
    private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
    private deferredFinals = new Map<string, Extract<ProviderEvent, { type: 'final' | 'turn.failed' }>[]>();
    constructor(
        readonly adapter: ProviderAdapter,
        readonly config: OperatorConfig,
        readonly store: ControllerStore,
        readonly deliver: ControllerDelivery,
        readonly requestApproval: ControllerApprovalDelivery,
        readonly options: ControllerOptions = {},
    ) {
        this.outbox = new ControllerOutbox(store, deliver, () => this.generation);
    }
    async start(): Promise<void> {
        await this.store.load();
        this.generation = await this.store.acquire();
        await this.adapter.connect(this.config, {
            onEvent: (event) => (isNotice(event) ? Promise.resolve(this.options.notice?.(event)) : this.handleProviderEvent(event)),
            tools: controllerTools(this, this.store),
        });
        await recoverController(this.adapter, this.store, this.generation, (event) => this.onEvent(event));
        await this.outbox.flush();
        await this.pump();
    }
    async stop(): Promise<void> {
        this.stopped = true;
        this.connected = false;
        this.approvals.clear();
        this.options.invalidateApproval?.();
        for (const timer of this.timeouts.values()) clearTimeout(timer);
        this.timeouts.clear();
        this.stopProcessing();
        this.outbox.stop();
        await this.adapter.close();
    }
    status() {
        const live = { connected: this.connected, failed: this.failed, deliveryError: this.outbox.error, generation: this.generation };
        return controllerStatus(this.store.snapshot(), {
            ...live,
            approvals: this.approvals.size,
            approvalDeliveryError: this.approvalDeliveryError,
        });
    }
    async reset(): Promise<void> {
        await this.store.update((state) => {
            for (const item of state.conversations) Object.assign(item, { sessionId: undefined, seen: {} });
        }, this.generation);
    }
    async ingest(event: BotEvent): Promise<boolean> {
        if (this.stopped) throw new Error('Controller stopped');
        const added = await this.store.enqueue(event);
        if (!added) {
            this.schedulePump();
            return false;
        }
        this.schedulePump();
        return true;
    }
    async startTask(conversation: string, prompt: string): Promise<string> {
        if (!prompt.trim() || prompt.length > 32000) throw new Error('Task prompt is empty or too large');
        const owner = this.store.snapshot().conversations.find((item) => item.key === conversation);
        if (!owner) throw new Error('Task has no verified owning conversation');
        const id = randomUUID();
        await this.store.update((state) => {
            state.tasks.push({ id, conversationKey: conversation, originEventId: owner.originEventId, prompt, state: 'queued' });
        }, this.generation);
        this.schedulePump();
        return id;
    }
    getTaskStatus(id: string): ControllerTask {
        const task = this.store.snapshot().tasks.find((item) => item.id === id);
        if (!task) throw new Error('Task not found');
        return task;
    }
    async steerTask(id: string, text: string): Promise<void> {
        const task = this.getTaskStatus(id);
        if (!task.sessionId || !task.turnId || !['running', 'approval'].includes(task.state)) throw new Error('Task is not active');
        await this.adapter.steer(task.sessionId, task.turnId, text);
    }
    async cancelTask(id: string): Promise<void> {
        const task = this.getTaskStatus(id);
        if (task.sessionId && task.turnId && ['running', 'approval'].includes(task.state))
            await this.adapter.interrupt(task.sessionId, task.turnId);
        await this.store.update((state) => {
            const current = state.tasks.find((item) => item.id === id)!;
            current.state = 'cancelled';
        }, this.generation);
    }
    async resolveApproval(key: string, decision: ApprovalDecision, originEventId: string): Promise<void> {
        const pending = this.approvals.get(key);
        if (!pending || pending.originEventId !== originEventId) throw new Error('Approval is not pending for this origin');
        this.approvals.delete(key);
        try {
            await this.adapter.resolveApproval(key, decision);
        } catch (error) {
            this.approvals.set(key, pending);
            throw error;
        }
        if (decision.action === 'cancel') {
            await this.adapter.interrupt(pending.request.sessionId, pending.request.turnId);
        }
    }
    async retryApproval(key: string): Promise<void> {
        const pending = this.approvals.get(key);
        if (!pending) throw new Error('The provider request is no longer pending');
        await this.requestApproval(pending.request, pending.originEventId);
        this.approvalDeliveryError = null;
    }
    async retryDelivery(): Promise<void> {
        await this.outbox.flush();
    }
    private async handleProviderEvent(event: ProviderEvent): Promise<void> {
        if (this.stopped) return;
        try {
            await this.onEvent(event);
        } catch {
            this.fail();
        }
    }
    private fail(): void {
        this.connected = false;
        this.failed = true;
        this.options.changed?.();
    }
    private schedulePump(): void {
        void this.pump().catch(() => this.fail());
    }
    private async pump(): Promise<void> {
        if (this.pumping) {
            this.pumpAgain = true;
            return;
        }
        if (!this.available()) return;
        this.pumping = true;
        try {
            for (const event of this.store.snapshot().inbox) {
                const key = this.options.sharedConversation ?? conversationKey(event);
                const existing = this.store.snapshot().conversations.find((item) => item.key === key);
                if (existing && existing.state !== 'idle') continue;
                let sessionId = existing?.sessionId;
                await this.store.update((state) => {
                    const item = state.conversations.find((item) => item.key === key);
                    if (item) Object.assign(item, { state: 'busy', originEventId: event.id });
                    else
                        state.conversations.push({
                            key,
                            actorId: event.actorId,
                            channelId: event.channelId,
                            seen: {},
                            originEventId: event.id,
                            state: 'busy',
                        });
                }, this.generation);
                let submitted = false;
                try {
                    sessionId = await this.openConversation(key, sessionId);
                    submitted = true;
                    const text = await withHistory(this.store, this.generation, key, event, this.options.history);
                    const turn = await this.adapter.startTurn(sessionId, { text, originEventId: event.id });
                    this.armTimeout(sessionId, turn.turnId);
                    this.progressAt.set(sessionId, Date.now());
                    await this.store.update((state) => {
                        const item = state.conversations.find((item) => item.key === key)!;
                        if (item.state === 'busy') item.turnId = turn.turnId;
                        state.inbox = state.inbox.filter((item) => item.id !== event.id);
                    }, this.generation);
                    await this.drainFinals(sessionId, turn.turnId);
                } catch (error) {
                    await this.store.update((state) => {
                        const item = state.conversations.find((item) => item.key === key)!;
                        item.state = submitted ? 'recovering' : 'idle';
                    }, this.generation);
                    throw error;
                }
            }
            await this.startWorkers();
        } finally {
            this.pumping = false;
            if (this.pumpAgain) {
                this.pumpAgain = false;
                this.schedulePump();
            }
        }
    }
    private async openConversation(key: string, sessionId?: string): Promise<string> {
        const opened = await this.adapter.openSession({ role: 'controller', conversationKey: key, ...(sessionId ? { sessionId } : {}) });
        if (opened.id !== sessionId)
            await this.store.update((state) => {
                Object.assign(
                    state.conversations.find((item) => item.key === key)!,
                    { sessionId: opened.id, seen: {} },
                );
            }, this.generation);
        return opened.id;
    }
    private async startWorkers(): Promise<void> {
        const state = this.store.snapshot();
        const active = state.tasks.filter((item) => ['running', 'approval', 'recovering'].includes(item.state)).length;
        for (const task of state.tasks
            .filter((item) => item.state === 'queued')
            .slice(0, Math.max(0, (this.options.workerCapacity ?? 2) - active))) {
            const session = await this.adapter.openSession({ role: 'worker', conversationKey: task.conversationKey });
            await this.store.update((state) => {
                Object.assign(
                    state.tasks.find((item) => item.id === task.id)!,
                    { sessionId: session.id, state: 'running' },
                );
            }, this.generation);
            const turn = await this.adapter.startTurn(session.id, {
                text: task.prompt,
                originEventId: task.originEventId,
                taskId: task.id,
            });
            this.armTimeout(session.id, turn.turnId);
            await this.store.update((state) => {
                state.tasks.find((item) => item.id === task.id)!.turnId = turn.turnId;
            }, this.generation);
            await this.drainFinals(session.id, turn.turnId);
        }
    }
    private async onEvent(event: ProviderEvent): Promise<void> {
        if (event.type === 'connected') {
            this.connected = true;
            this.epoch = event.epoch;
        } else if (event.type === 'disconnected') this.disconnected();
        else if (event.type === 'approval.resolved') await this.resolved(event);
        else if (event.type === 'approval.requested') await this.approval(event.request);
        else if (event.type === 'turn.started') await this.started(event.sessionId, event.turnId);
        else if (event.type === 'final' || event.type === 'turn.failed') await this.finished(event);
        else if (event.type === 'progress') await this.progress(event);
    }
    private disconnected(): void {
        this.stopProcessing();
        this.approvals.clear();
        this.options.invalidateApproval?.();
        if (!this.stopped) this.fail();
    }
    private available(): boolean {
        return !this.stopped && this.connected;
    }
    private stopProcessing(): void {
        const state = this.store.snapshot();
        for (const owner of [...state.conversations, ...state.tasks])
            if (owner.sessionId) this.options.processing?.(owner.sessionId, owner.originEventId, false);
    }
    private owner(sessionId: string) {
        const state = this.store.snapshot();
        return state.tasks.find((item) => item.sessionId === sessionId) ?? state.conversations.find((item) => item.sessionId === sessionId);
    }
    private async resolved(event: Extract<ProviderEvent, { type: 'approval.resolved' }>): Promise<void> {
        if (event.epoch !== this.epoch) return;
        const pending = this.approvals.get(event.key);
        this.approvals.delete(event.key);
        this.options.invalidateApproval?.(event.key);
        if (pending) await this.markSession(pending.request.sessionId, 'busy');
    }
    private async started(sessionId: string, turnId: string): Promise<void> {
        const owner = this.owner(sessionId);
        if (owner?.turnId && owner.turnId !== turnId) return;
        if (owner) this.options.processing?.(sessionId, owner.originEventId, true);
        await this.store.update((current) => {
            const worker = current.tasks.find((item) => item.sessionId === sessionId);
            const controller = current.conversations.find((item) => item.sessionId === sessionId);
            if (worker) worker.turnId = turnId;
            if (controller) controller.turnId = turnId;
        }, this.generation);
        await this.drainFinals(sessionId, turnId);
    }
    private async approval(request: ProviderApproval): Promise<void> {
        const owner = this.owner(request.sessionId);
        if (!owner || request.epoch !== this.epoch) return;
        if (owner.turnId && owner.turnId !== request.turnId) return;
        this.options.processing?.(request.sessionId, owner.originEventId, false);
        this.approvals.set(request.key, { request, originEventId: owner.originEventId });
        await this.markSession(request.sessionId, 'approval');
        try {
            await this.requestApproval(request, owner.originEventId);
        } catch {
            this.approvalDeliveryError =
                'Harness prompt delivery failed; action remains blocked. Retry the pending prompt or complete/deny it in the local provider; never infer approval.';
        }
    }
    private async finished(event: Extract<ProviderEvent, { type: 'final' | 'turn.failed' }>): Promise<void> {
        const owner = this.owner(event.sessionId);
        if (!owner) return;
        if ('state' in owner && owner.state === 'cancelled') return this.release(event.sessionId, event.turnId, owner.originEventId);
        if (!owner.turnId) {
            this.deferFinal(event, owner.state);
            return;
        }
        if (owner.turnId !== event.turnId) return;
        this.release(event.sessionId, event.turnId, owner.originEventId);
        const text = event.type === 'final' ? event.text : 'The provider stopped with an error. I have not retried the action.';
        await this.store.update((current) => {
            appendReply(current, owner.originEventId, text, `controller-final-${event.sessionId}-${event.turnId}`);
            const worker = current.tasks.find((item) => item.sessionId === event.sessionId);
            if (worker && worker.state !== 'cancelled') {
                worker.state = event.type === 'final' ? 'completed' : 'failed';
                worker.result = text;
            }
            const controller = current.conversations.find((item) => item.sessionId === event.sessionId);
            if (controller) {
                controller.state = 'idle';
                delete controller.turnId;
            }
        }, this.generation);
        if (this.closesAfterTurn(owner)) await this.adapter.closeSession?.(event.sessionId).catch(() => undefined);
        await this.outbox.flush();
        this.schedulePump();
        this.options.changed?.();
    }
    private closesAfterTurn(owner: object): boolean {
        return 'prompt' in owner || Boolean(this.options.sharedConversation);
    }
    private release(sessionId: string, turnId: string, originEventId: string): void {
        this.options.processing?.(sessionId, originEventId, false);
        clearTimeout(this.timeouts.get(`${sessionId}:${turnId}`));
        this.timeouts.delete(`${sessionId}:${turnId}`);
    }
    private deferFinal(event: Extract<ProviderEvent, { type: 'final' | 'turn.failed' }>, state: string): void {
        if (state === 'idle') return;
        const pending = this.deferredFinals.get(event.sessionId) ?? [];
        if (pending.length < 32) pending.push(event);
        this.deferredFinals.set(event.sessionId, pending);
    }
    private async progress(event: Extract<ProviderEvent, { type: 'progress' }>): Promise<void> {
        if (event.activity && !this.options.activity) return;
        const owner = this.owner(event.sessionId);
        if (!owner || owner.turnId !== event.turnId) return;
        const quiet = this.progressAt.get(event.sessionId) ?? Date.now();
        const text = progressPost(Boolean(event.activity), event.text, quiet, this.config.progressSeconds ?? 60);
        if (!text) return;
        this.progressAt.set(event.sessionId, Date.now());
        await this.outbox.queue(owner.originEventId, text, `controller-progress-${event.sessionId}-${Date.now()}`, true);
    }
    private async drainFinals(sessionId: string, turnId: string): Promise<void> {
        const pending = this.deferredFinals.get(sessionId) ?? [];
        this.deferredFinals.delete(sessionId);
        for (const event of pending.filter((item) => item.turnId === turnId)) await this.finished(event);
    }
    private armTimeout(sessionId: string, turnId: string): void {
        if (!this.config.timeoutSeconds) return;
        const key = `${sessionId}:${turnId}`;
        if (this.timeouts.has(key)) return;
        this.timeouts.set(
            key,
            setTimeout(() => {
                this.timeouts.delete(key);
                void this.adapter.interrupt(sessionId, turnId).catch(() => this.fail());
            }, this.config.timeoutSeconds * 1000),
        );
    }
    private async markSession(sessionId: string, state: 'busy' | 'approval'): Promise<void> {
        const owner = this.owner(sessionId);
        if (owner) this.options.processing?.(sessionId, owner.originEventId, state === 'busy');
        await this.store.update((current) => {
            const task = current.tasks.find((item) => item.sessionId === sessionId);
            const conversation = current.conversations.find((item) => item.sessionId === sessionId);
            if (task && task.state !== 'cancelled') task.state = state === 'busy' ? 'running' : 'approval';
            if (conversation) conversation.state = state;
        }, this.generation);
    }
}
