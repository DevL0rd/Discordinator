import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SubscriptionStore, type State } from '../src/events/store.js';
import { EventsService } from '../src/events/service.js';
import { payload, unsubscribeSchema } from '../src/events/schema.js';
import { CallbackError, type CallbackSender } from '../src/events/https.js';
import { fixture, ids } from './fixtures.js';
import { observed } from './check-context.js';
import { request } from './check-events.js';

const owner = { id: 'delivery-owner' };
type Delivery = (signal: AbortSignal) => Promise<{ status: number; body: string }>;

function receiver() {
    let deliver: Delivery = () => Promise.resolve({ status: 200, body: '' });
    let verify: () => Promise<void> = () => Promise.resolve();
    const urls: string[] = [];
    const sender: CallbackSender = async (url, body, _headers, signal) => {
        const message = JSON.parse(body) as { type?: string; challenge?: string };
        if (message.type !== 'verification') {
            urls.push(url);
            return deliver(signal);
        }
        await verify();
        return { status: 200, body: JSON.stringify({ challenge: message.challenge }) };
    };
    return {
        sender,
        urls,
        onDeliver: (value: Delivery) => {
            deliver = value;
        },
        onVerify: (value: () => Promise<void>) => {
            verify = value;
        },
    };
}

function setup(directory: string, name: string) {
    const f = fixture(join(directory, `${name}-journal.json`));
    f.policy.config.scopes.push('messages.read');
    f.policy.config.mcpEvents = { enabled: true, allowAllMessages: false };
    const store = new SubscriptionStore(join(directory, `${name}.json`));
    const hook = receiver();
    const access = { allowed: true };
    const clock = { now: Date.now() };
    const service = new EventsService(
        store,
        f.policy,
        (id) => access.allowed && id === owner.id,
        hook.sender,
        () => clock.now,
    );
    const at = (path: string) => ({ ...request(), delivery: { ...request().delivery, url: `https://receiver.example/${path}` } });
    const event = () => service.emit(payload(observed(), f.event.id));
    return { f, store, hook, access, clock, service, at, event };
}

function deferred() {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

async function checkFailureClassification(directory: string): Promise<void> {
    const { store, hook, service, at, event, clock } = setup(directory, 'classify');
    const denied = new EventsService(store, fixture(join(directory, 'classify-denied.json')).policy, () => false);
    assert.deepEqual(denied.list(owner), { events: [] }, 'Owners without event access see no event types');
    await service.subscribe(owner, at('rejecting'));
    hook.onDeliver(() => Promise.reject(new CallbackError('response_too_large')));
    await event();
    await service.pump();
    assert.equal(store.state.jobs.length, 0, 'Permanent callback errors are not retried');
    assert.equal(store.state.subscriptions[0]?.suspended, true, 'A permanently failing endpoint is suspended');
    await service.subscribe(owner, at('flaky'));
    for (const failure of [new CallbackError('network_error'), new Error('socket closed')]) {
        hook.onDeliver(() => Promise.reject(failure));
        await event();
        await service.pump();
    }
    const retried = store.state.jobs.filter((job) => job.attempts === 1);
    assert.equal(retried.length, 2, 'Network failures and unknown errors are retried');
    assert.ok(
        retried.every((job) => job.nextAt === clock.now + 2000),
        'Retries back off',
    );
    assert.deepEqual(service.status(), { subscriptions: 2, pending: 2, dropped: 0, droppedIngress: 0 });
}

async function checkRevokedData(directory: string): Promise<void> {
    const { f, store, hook, service, event } = setup(directory, 'revoked');
    await service.subscribe(owner, request());
    await event();
    assert.equal(store.state.jobs.length, 1);
    f.policy.config.allowedUserIds = [ids.denied];
    await service.pump();
    assert.equal(store.state.jobs.length, 0, 'Jobs whose author lost access are discarded at delivery');
    assert.equal(hook.urls.length, 0, 'Discarded jobs are never sent');
    assert.equal(store.state.subscriptions.length, 1, 'The subscription itself stays valid');
}

async function checkBackpressure(directory: string): Promise<void> {
    const { store, service, event } = setup(directory, 'pressure');
    await service.subscribe(owner, request());
    await Promise.all(Array.from({ length: 33 }, event));
    assert.equal(service.status().droppedIngress, 1, 'Ingress beyond 32 pending emits is dropped');
    assert.equal(store.state.jobs.length, 32);
    store.state = {
        ...store.state,
        jobs: Array.from({ length: 500 }, (_, index) => ({ ...store.state.jobs[0]!, eventId: `evt_fill_${index}` })),
    };
    await event();
    assert.equal(service.status().dropped, 1, 'A full job queue counts dropped deliveries');
    assert.equal(store.state.jobs.length, 500);
    const limit = setup(directory, 'limit');
    const template = (await limit.service.subscribe(owner, limit.at('first'))).id;
    const base = limit.store.state.subscriptions.find((item) => item.id === template)!;
    limit.store.state = {
        ...limit.store.state,
        subscriptions: Array.from({ length: 100 }, (_, index) => ({ ...base, id: `sub_fill_${index}` })),
    };
    await assert.rejects(limit.service.subscribe(owner, limit.at('second')), /Subscription limit reached/);
}

class FailingStore extends SubscriptionStore {
    failing = false;
    override change<T>(action: (state: State) => T): Promise<T> {
        if (this.failing) return Promise.reject(new Error('disk unavailable'));
        return super.change(action);
    }
}

async function checkPausedDelivery(directory: string): Promise<void> {
    const f = fixture(join(directory, 'paused-journal.json'));
    f.policy.config.scopes.push('messages.read');
    f.policy.config.mcpEvents = { enabled: true, allowAllMessages: false };
    const store = new FailingStore(join(directory, 'paused.json'));
    const hook = receiver();
    const service = new EventsService(store, f.policy, (id) => id === owner.id, hook.sender);
    await service.subscribe(owner, request());
    await service.emit(payload(observed(), f.event.id));
    hook.onDeliver(() => {
        store.failing = true;
        return Promise.resolve({ status: 200, body: '' });
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...values: unknown[]) => errors.push(values.join(' '));
    try {
        await service.pump();
    } finally {
        console.error = original;
    }
    assert.deepEqual(errors, ['Webhook state unavailable; delivery paused'], 'Unwritable state pauses delivery without crashing');
    store.failing = false;
    assert.equal(store.state.jobs.length, 1, 'The undelivered job is kept for a later attempt');
}

async function checkVerificationLimits(directory: string): Promise<void> {
    const { hook, service, at } = setup(directory, 'verifying');
    const gate = deferred();
    hook.onVerify(() => gate.promise);
    const same = Array.from({ length: 16 }, () => service.subscribe(owner, at('same')));
    await assert.rejects(service.subscribe(owner, at('same')), /Too many refresh requests/);
    const others = Array.from({ length: 15 }, (_, index) => service.subscribe(owner, at(`other-${index}`)));
    await assert.rejects(service.subscribe(owner, at('one-too-many')), /Callback verification unavailable/);
    gate.release();
    const settled = await Promise.allSettled([...same, ...others]);
    assert.ok(
        settled.every((item) => item.status === 'fulfilled'),
        'Pending verifications complete once released',
    );
}

async function checkSecretGrace(directory: string): Promise<void> {
    const { store, service } = setup(directory, 'grace');
    const first = request();
    const rotated = { ...first, delivery: { ...first.delivery, secret: `whsec_${Buffer.alloc(32, 9).toString('base64')}` } };
    await service.subscribe(owner, first);
    await service.subscribe(owner, rotated);
    await service.subscribe(owner, rotated);
    assert.equal(store.state.subscriptions[0]?.previous?.secret, first.delivery.secret, 'Refreshing keeps the previous secret grace');
    service.start();
    await service.stop();
    await service.pump();
    assert.equal(store.state.jobs.length, 0, 'A stopped service never pumps');
}

async function inFlight(context: ReturnType<typeof setup>, path: string) {
    const entered = deferred();
    context.hook.onDeliver(
        (signal) =>
            new Promise((_, reject) => {
                entered.release();
                signal.addEventListener('abort', () => reject(new CallbackError('timeout')), { once: true });
            }),
    );
    await context.service.subscribe(owner, context.at(path));
    await context.event();
    const pumping = context.service.pump();
    await entered.promise;
    return { pumping };
}

async function checkCancelledDelivery(directory: string): Promise<void> {
    const removed = setup(directory, 'unsubscribed');
    const { pumping } = await inFlight(removed, 'removed');
    await removed.service.pump();
    assert.equal(removed.hook.urls.length, 1, 'A subscription with a delivery in flight is not sent twice');
    await removed.service.unsubscribe(
        owner,
        unsubscribeSchema.parse({
            name: request().name,
            arguments: request().arguments,
            delivery: { mode: 'webhook', url: removed.at('removed').delivery.url },
        }),
    );
    await pumping;
    assert.equal(removed.store.state.jobs.length, 0, 'Unsubscribing cancels the in-flight delivery');
    const revoked = setup(directory, 'revoked-flight');
    const flight = (await inFlight(revoked, 'revoked')).pumping;
    revoked.access.allowed = false;
    await revoked.service.pump();
    await flight;
    assert.equal(revoked.store.state.subscriptions.length, 0, 'Revoked owners lose their subscriptions');
    assert.equal(revoked.store.state.jobs.length, 0);
    const stopped = setup(directory, 'stopped');
    const halted = (await inFlight(stopped, 'stopped')).pumping;
    await stopped.service.stop();
    await halted;
    assert.equal(stopped.store.state.jobs[0]?.attempts, 1, 'Stopping aborts in-flight delivery and keeps it for retry');
}

async function checkStopDuringVerification(directory: string): Promise<void> {
    const { hook, service, store } = setup(directory, 'stopping');
    const gate = deferred();
    hook.onVerify(() => gate.promise);
    const pending = service.subscribe(owner, request());
    await service.stop();
    gate.release();
    await assert.rejects(pending, /Subscription request cancelled/, 'Stopping cancels pending verifications');
    assert.equal(store.state.subscriptions.length, 0);
}

async function checkStoreBounds(directory: string): Promise<void> {
    const oversized = join(directory, 'oversized-subscriptions.json');
    await writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    await assert.rejects(new SubscriptionStore(oversized).load(), /Subscription store invalid/);
    const corrupt = join(directory, 'corrupt-subscriptions.json');
    await writeFile(corrupt, '{');
    await assert.rejects(new SubscriptionStore(corrupt).load(), /Subscription store invalid/);
    const store = new SubscriptionStore(join(directory, 'bounded-subscriptions.json'));
    const job = { subscriptionId: 'sub', eventId: 'evt', body: 'x'.repeat(8 * 1024 * 1024), attempts: 0, nextAt: 0, expires: 0 };
    await assert.rejects(
        store.change((state) => {
            state.jobs.push(job);
        }),
        /byte limit exhausted/,
    );
    const writes = Array.from({ length: 65 }, (_, index) =>
        store.change((state) => {
            state.dropped = index;
        }),
    );
    const results = await Promise.allSettled(writes);
    assert.equal(results.filter((item) => item.status === 'rejected').length, 1, 'At most 64 state changes may be queued');
    assert.equal(store.state.dropped, 63);
}

export async function checkEventsDelivery(directory: string): Promise<void> {
    await checkFailureClassification(directory);
    await checkRevokedData(directory);
    await checkBackpressure(directory);
    await checkPausedDelivery(directory);
    await checkVerificationLimits(directory);
    await checkSecretGrace(directory);
    await checkCancelledDelivery(directory);
    await checkStopDuringVerification(directory);
    await checkStoreBounds(directory);
}
