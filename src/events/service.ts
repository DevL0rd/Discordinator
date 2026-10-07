import { randomUUID } from 'node:crypto';
import { ProtocolError } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Policy } from '../core/policy.js';
import { EventAccess } from './access.js';
import { CallbackError, httpsSender, type CallbackSender } from './https.js';
import { Verifier, hash, signedHeaders, type Principal } from './security.js';
import {
    eventName,
    interactionEventName,
    interactionPayloadSchema,
    filtersSchema,
    payloadSchema,
    matches,
    type EventPayload,
    type SubscribeInput,
    type UnsubscribeInput,
} from './schema.js';
import { SubscriptionStore, type Subscription, type Job, type State } from './store.js';

function identity(owner: string, input: UnsubscribeInput): string {
    return `sub_${hash([owner, input.delivery.url, input.name, input.arguments])}`;
}

export class EventsService {
    readonly access: EventAccess;
    private readonly verifier: Verifier;
    private inFlight = new Map<string, AbortController>();
    private lanes = new Set<Promise<void>>();
    private timer?: ReturnType<typeof setTimeout>;
    private running = false;
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
        readonly delivering: () => boolean = () => true,
    ) {
        this.access = new EventAccess(policy, ownerAllowed, now);
        this.verifier = new Verifier(sender, now);
        policy.onChange(() => {
            if (this.running) void this.pump().catch(paused);
        });
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
                        'New human messages in approved readable scope. Addressed delivery needs an allowed verified trigger. Answer Discord-origin requests and ordinary follow-ups in their originating Discord conversation unless the requester explicitly asks to move them. For work that may take time, acknowledge promptly and keep the requester informed there through completion or a clear blocker. All-message observation is separately opt-in and cannot authorize responses. No replay.',
                    delivery: ['webhook'],
                    inputSchema: z.toJSONSchema(filtersSchema),
                    payloadSchema: z.toJSONSchema(payloadSchema),
                },
                {
                    name: interactionEventName,
                    description:
                        'Verified approved-requester Discord commands and correlated button/select/modal answers. Wake the same originating conversation, fetch the captured child event and resolve its exact pending provider callback. Receipt is not proof of model processing; no replay.',
                    delivery: ['webhook'],
                    inputSchema: z.toJSONSchema(filtersSchema),
                    payloadSchema: z.toJSONSchema(interactionPayloadSchema),
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
            this.schedule();
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
        this.schedule();
        return {};
    }

    async emit(data: EventPayload, name: SubscribeInput['name'] = eventName): Promise<void> {
        if (this.closed || !this.delivering()) return;
        if (this.pendingEmits >= 32) {
            this.droppedIngress++;
            return;
        }
        if (!this.store.state.subscriptions.some((item) => item.name === name && this.access.allowsData(item, data))) return;
        this.pendingEmits++;
        try {
            await this.enqueue(data, name);
        } finally {
            this.pendingEmits--;
        }
    }

    private async enqueue(data: EventPayload, name: SubscribeInput['name']): Promise<void> {
        (name === interactionEventName ? interactionPayloadSchema : payloadSchema).parse(data);
        const eventId = `evt_${randomUUID()}`;
        const body = JSON.stringify({ eventId, name, timestamp: data.timestamp, data, cursor: null });
        if (Buffer.byteLength(body) > 262144) throw new Error('Event body exceeds 256 KiB');
        await this.store.change((state) => {
            for (const subscription of state.subscriptions) {
                if (subscription.name !== name || !this.access.allowsData(subscription, data) || !matches(subscription.arguments, data))
                    continue;
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
        this.schedule();
    }

    start(): void {
        this.closed = false;
        this.running = true;
        this.schedule();
    }
    async stop(): Promise<void> {
        this.closed = true;
        this.running = false;
        clearTimeout(this.timer);
        for (const controller of this.inFlight.values()) controller.abort();
        for (const controllers of this.verifications.values()) for (const controller of controllers) controller.abort();
        await Promise.allSettled([...this.lanes]);
        // Already transmitted packets cannot be recalled.
        await this.store.change(() => {});
    }

    async pump(): Promise<void> {
        if (this.closed) return;
        await this.prune();
        const lanes = this.launch();
        this.schedule();
        await Promise.all(lanes);
    }

    private launch(): Promise<void>[] {
        const lanes: Promise<void>[] = [];
        for (const job of this.store.state.jobs) {
            if (this.closed || job.nextAt > this.now() || this.inFlight.has(job.subscriptionId)) continue;
            const lane = this.deliver(job)
                .then(
                    () => this.schedule(),
                    () => paused(),
                )
                .finally(() => this.lanes.delete(lane));
            this.lanes.add(lane);
            lanes.push(lane);
        }
        return lanes;
    }

    private schedule(): void {
        clearTimeout(this.timer);
        const wake = this.running ? nextWake(this.store.state, this.inFlight) : undefined;
        if (wake === undefined) return;
        this.timer = setTimeout(
            () => {
                void this.pump().catch(paused);
            },
            Math.min(Math.max(0, wake - this.now()), 24 * 60 * 60_000),
        );
        this.timer.unref();
    }

    private async prune(): Promise<void> {
        for (const subscription of this.store.state.subscriptions)
            if (!this.access.active(subscription)) this.inFlight.get(subscription.id)?.abort();
        await this.store.change((state) => {
            state.subscriptions = state.subscriptions.filter((item) => this.access.retained(item));
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
        if (!subscription || !this.access.allowsData(subscription, (JSON.parse(job.body) as { data: EventPayload }).data))
            return this.removeJob(job);
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

function paused(): void {
    console.error('Webhook state unavailable; delivery paused');
}

function nextWake(state: State, inFlight: Map<string, AbortController>): number | undefined {
    const times = [
        ...state.jobs.filter((job) => !inFlight.has(job.subscriptionId)).map((job) => job.nextAt),
        ...state.subscriptions.flatMap((item) => [item.expires, ...(item.previous ? [item.previous.until] : [])]),
    ];
    return times.length ? Math.min(...times) : undefined;
}

function deliveryFailure(error: unknown): number {
    if (error instanceof CallbackError && !['timeout', 'network_error'].includes(error.reason)) return 400;
    return 0;
}
