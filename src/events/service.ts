import { randomUUID } from 'node:crypto';
import { ProtocolError } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Policy } from '../core/policy.js';
import { EventAccess } from './access.js';
import { CallbackError, httpsSender, type CallbackSender } from './https.js';
import { Verifier, hash, signedHeaders, type Principal } from './security.js';
import { eventName, filtersSchema, payloadSchema, matches, type Payload, type SubscribeInput, type UnsubscribeInput } from './schema.js';
import { SubscriptionStore, type Subscription, type Job } from './store.js';

function identity(owner: string, input: UnsubscribeInput): string {
    return `sub_${hash([owner, input.delivery.url, input.name, input.arguments])}`;
}

export class EventsService {
    readonly access: EventAccess;
    private readonly verifier: Verifier;
    private inFlight = new Map<string, AbortController>();
    private timer?: ReturnType<typeof setInterval>;
    private pumping = false;
    private pumpTask?: Promise<void>;
    private closed = false;
    private verifications = new Map<string, Set<AbortController>>();
    private pendingEmits = 0;
    private droppedIngress = 0;
    constructor(
        readonly store: SubscriptionStore,
        policy: Policy,
        ownerAllowed: (owner: string) => boolean,
        readonly sender: CallbackSender = httpsSender(),
        readonly now = Date.now,
    ) {
        this.access = new EventAccess(policy, ownerAllowed, now);
        this.verifier = new Verifier(sender, now);
    }

    list(owner: Principal) {
        try {
            this.access.authorize(owner, filtersSchema.parse({}));
        } catch {
            return { events: [] };
        }
        return {
            events: [
                {
                    name: eventName,
                    description:
                        'New human messages in approved readable scope. Addressed delivery needs an allowed verified trigger; all-message observation is separately opt-in and cannot authorize responses. No replay.',
                    delivery: ['webhook'],
                    inputSchema: z.toJSONSchema(filtersSchema),
                    payloadSchema: z.toJSONSchema(payloadSchema),
                },
            ],
        };
    }

    async subscribe(owner: Principal, input: SubscribeInput) {
        this.access.authorize(owner, input.arguments);
        const id = identity(owner.id, input);
        const controller = this.beginVerification(id);
        try {
            await this.verifier.verify(owner.id, { id, url: input.delivery.url, secret: input.delivery.secret }, controller.signal);
            return await this.store.change((state) => {
                if (controller.signal.aborted || this.closed) throw new ProtocolError(-32602, 'Subscription request cancelled');
                this.access.authorize(owner, input.arguments);
                const existing = state.subscriptions.find((item) => item.id === id);
                if (!existing && state.subscriptions.length >= 100) throw new ProtocolError(-32602, 'Subscription limit reached');
                const expires = this.expiration(owner, input.ttlMs);
                const subscription: Subscription = {
                    id,
                    owner: owner.id,
                    ownerExpires: owner.expiresAt,
                    url: input.delivery.url,
                    name: input.name,
                    arguments: input.arguments,
                    secret: input.delivery.secret,
                    expires,
                    verifiedAt: this.now(),
                    suspended: false,
                };
                this.rotate(subscription, existing);
                state.subscriptions = state.subscriptions.filter((item) => item.id !== id);
                state.subscriptions.push(subscription);
                return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
            });
        } finally {
            const controllers = this.verifications.get(id);
            controllers?.delete(controller);
            if (!controllers?.size) this.verifications.delete(id);
        }
    }

    private beginVerification(id: string): AbortController {
        if (this.closed || this.verifications.size >= 16) throw new ProtocolError(-32602, 'Callback verification unavailable');
        const controllers = this.verifications.get(id) ?? new Set<AbortController>();
        if (controllers.size >= 16) throw new ProtocolError(-32602, 'Too many refresh requests');
        const controller = new AbortController();
        controllers.add(controller);
        this.verifications.set(id, controllers);
        return controller;
    }

    private rotate(subscription: Subscription, existing?: Subscription): void {
        if (!existing) return;
        if (existing.secret !== subscription.secret) subscription.previous = { secret: existing.secret, until: this.now() + 5 * 60_000 };
        else if (existing.previous && existing.previous.until > this.now()) subscription.previous = existing.previous;
    }

    private expiration(owner: Principal, requested: number | null | undefined): number {
        const ttl = requested == null ? 60 * 60_000 : Math.min(24 * 60 * 60_000, Math.max(60_000, requested));
        return Math.min(this.now() + ttl, owner.expiresAt ?? Infinity);
    }

    async unsubscribe(owner: Principal, input: UnsubscribeInput) {
        const id = identity(owner.id, input);
        this.inFlight.get(id)?.abort();
        for (const controller of this.verifications.get(id) ?? []) controller.abort();
        await this.store.change((state) => {
            state.subscriptions = state.subscriptions.filter((item) => item.id !== id);
            state.jobs = state.jobs.filter((item) => item.subscriptionId !== id);
        });
        return {};
    }

    async emit(data: Payload): Promise<void> {
        if (this.closed) return;
        if (this.pendingEmits >= 32) {
            this.droppedIngress++;
            return;
        }
        if (!this.store.state.subscriptions.some((item) => this.access.allowsData(item, data))) return;
        this.pendingEmits++;
        try {
            await this.enqueue(data);
        } finally {
            this.pendingEmits--;
        }
    }

    private async enqueue(data: Payload): Promise<void> {
        payloadSchema.parse(data);
        const eventId = `evt_${randomUUID()}`;
        const body = JSON.stringify({ eventId, name: eventName, timestamp: data.timestamp, data, cursor: null });
        if (Buffer.byteLength(body) > 262144) throw new Error('Event body exceeds 256 KiB');
        await this.store.change((state) => {
            for (const subscription of state.subscriptions) {
                if (!this.access.allowsData(subscription, data) || !matches(subscription.arguments, data)) continue;
                if (state.jobs.length >= 500) {
                    state.dropped++;
                    continue;
                }
                state.jobs.push({
                    subscriptionId: subscription.id,
                    eventId,
                    body,
                    attempts: 0,
                    nextAt: this.now(),
                    expires: Math.min(subscription.expires, this.now() + 10 * 60_000),
                });
            }
        });
    }

    start(): void {
        this.closed = false;
        this.timer = setInterval(() => {
            void this.pump().catch(() => {
                console.error('Webhook state unavailable; delivery paused');
            });
        }, 1000);
        this.timer.unref();
    }
    async stop(): Promise<void> {
        this.closed = true;
        clearInterval(this.timer);
        for (const controller of this.inFlight.values()) controller.abort();
        for (const controllers of this.verifications.values()) for (const controller of controllers) controller.abort();
        await this.pumpTask;
        // Already transmitted packets cannot be recalled.
        await this.store.change(() => {});
    }

    async pump(): Promise<void> {
        if (this.pumping || this.closed) return;
        this.pumping = true;
        this.pumpTask = this.runPump();
        try {
            await this.pumpTask;
        } finally {
            this.pumping = false;
            this.pumpTask = undefined;
        }
    }

    private async runPump(): Promise<void> {
        await this.prune();
        const due = this.store.state.jobs.filter((job) => job.nextAt <= this.now()).slice(0, 4);
        for (const job of due) {
            if (!this.closed) await this.deliver(job);
        }
    }

    private async prune(): Promise<void> {
        for (const subscription of this.store.state.subscriptions)
            if (!this.access.active(subscription)) this.inFlight.get(subscription.id)?.abort();
        await this.store.change((state) => {
            state.subscriptions = state.subscriptions.filter((item) => this.access.valid(item));
            for (const item of state.subscriptions) if (item.previous && item.previous.until <= this.now()) delete item.previous;
            state.jobs = state.jobs.filter(
                (job) =>
                    job.expires > this.now() &&
                    state.subscriptions.some((item) => item.id === job.subscriptionId && this.access.active(item)),
            );
        });
    }

    private async deliver(job: Job): Promise<void> {
        const subscription = this.store.state.subscriptions.find((item) => item.id === job.subscriptionId);
        if (!subscription || !this.access.allowsData(subscription, JSON.parse(job.body).data)) return this.removeJob(job);
        const controller = new AbortController();
        this.inFlight.set(subscription.id, controller);
        let status: number;
        try {
            const headers = signedHeaders(job.eventId, job.body, subscription, this.now());
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
            status = (await this.sender(subscription.url, job.body, headers, signal)).status;
        } catch (error) {
            status = deliveryFailure(error);
        } finally {
            this.inFlight.delete(subscription.id);
        }
        await this.outcome(job, status);
    }

    private async removeJob(job: Job): Promise<void> {
        await this.store.change((state) => {
            state.jobs = state.jobs.filter((item) => item.eventId !== job.eventId || item.subscriptionId !== job.subscriptionId);
        });
    }

    private async outcome(job: Job, status: number): Promise<void> {
        const retry = status === 0 || status === 429 || status >= 500;
        await this.store.change((state) => {
            const current = state.jobs.find((item) => item.eventId === job.eventId && item.subscriptionId === job.subscriptionId);
            if (!current) return;
            current.attempts++;
            if (retry && current.attempts < 6) {
                current.nextAt = this.now() + Math.min(60_000, 1000 * 2 ** current.attempts);
                return;
            }
            state.jobs = state.jobs.filter((item) => item !== current);
            const subscription = state.subscriptions.find((item) => item.id === job.subscriptionId);
            if (subscription && !(status >= 200 && status < 300)) subscription.suspended = true;
        });
    }

    status() {
        return {
            subscriptions: this.store.state.subscriptions.length,
            pending: this.store.state.jobs.length,
            dropped: this.store.state.dropped,
            droppedIngress: this.droppedIngress,
        };
    }
}

function deliveryFailure(error: unknown): number {
    if (error instanceof CallbackError && !['timeout', 'network_error'].includes(error.reason)) return 400;
    return 0;
}
