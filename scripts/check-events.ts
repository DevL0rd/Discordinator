import assert from 'node:assert/strict';
import { Webhook } from 'standardwebhooks';
import { ProtocolError } from '@modelcontextprotocol/server';
import { SubscriptionStore } from '../src/events/store.js';
import { EventsService } from '../src/events/service.js';
import { secretSchema, subscribeSchema, unsubscribeSchema, payload } from '../src/events/schema.js';
import { CallbackError, callbackUrl, connectionOptions, publicAddress, resolveCallback, type CallbackSender } from '../src/events/https.js';
import { Verifier } from '../src/events/security.js';
import { fixture, ids } from './fixtures.js';
import { observed } from './check-context.js';

// Public synthetic signing material for a memory-only mock, never a runtime credential.
const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const replacement = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
const owner = { id: 'mock-owner' };
const request = (delivery: 'addressed' | 'all' = 'addressed') => subscribeSchema.parse({
  name: 'discord.message.created', arguments: { delivery, channel_id: ids.channel },
  delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret }, cursor: null, ttlMs: 120_000,
});

function mockReceiver() {
  const deliveries: { body: string; headers: Record<string, string> }[] = [];
  let status = 200;
  let verifications = 0;
  const sender: CallbackSender = async (_url, body, headers) => {
    const message = JSON.parse(body);
    new Webhook(secret).verify(body, headers);
    if (message.type === 'verification') { verifications++; return { status: 200, body: JSON.stringify({ challenge: message.challenge }) }; }
    assert.equal(headers['webhook-id'], message.eventId);
    assert.equal(message.type, undefined);
    deliveries.push({ body, headers });
    return { status, body: '' };
  };
  return { sender, deliveries, setStatus: (value: number) => { status = value; }, count: () => verifications };
}

export async function checkEvents(directory: string): Promise<void> {
  const f = fixture(`${directory}/events-journal.json`);
  f.policy.config.scopes.push('messages.read');
  f.policy.config.mcpEvents = { enabled: true, allowAllMessages: false };
  const store = new SubscriptionStore(`${directory}/subscriptions.json`);
  let now = Date.now(), ownerAllowed = true;
  const receiver = mockReceiver();
  const service = new EventsService(store, f.policy, id => ownerAllowed && id === owner.id, receiver.sender, () => now);
  const input = request(), sub = await service.subscribe(owner, input);
  assert.equal(receiver.count(), 1);
  assert.equal((await service.subscribe(owner, input)).id, sub.id);
  assert.equal(receiver.count(), 1);
  await assert.rejects(() => service.subscribe({ id: 'other-owner' }, input));
  await assert.rejects(() => service.subscribe(owner, request('all')));
  await service.emit(payload(observed({ actorId: ids.denied }), null));
  assert.equal(store.state.jobs.length, 0);
  await service.emit(payload(observed(), f.event.id));
  receiver.setStatus(503);
  await service.pump();
  assert.equal(store.state.jobs[0]?.attempts, 1);
  await checkRestart(store, f, receiver, () => now, value => { now = value; });
  await service.subscribe(owner, input);
  await checkPermanentResponses(service, store, receiver, payload(observed(), f.event.id));
  ownerAllowed = false;
  await service.emit(payload(observed(), f.event.id));
  await service.pump();
  assert.equal(store.state.subscriptions.length, 0);
  await checkAllMessages(service, store, f, () => { ownerAllowed = true; });
  await checkRotation(directory, f);
  await checkVerificationFailures();
  await checkSsrf();
}

async function checkRestart(store: SubscriptionStore, f: ReturnType<typeof fixture>, receiver: ReturnType<typeof mockReceiver>, now: () => number, setNow: (value: number) => void) {
  const restored = new SubscriptionStore(store.file);
  await restored.load();
  assert.equal(restored.state.subscriptions.length, 1);
  assert.equal(restored.state.jobs[0]?.body, store.state.jobs[0]?.body);
  receiver.setStatus(200);
  setNow(now() + 3000);
  const service = new EventsService(restored, f.policy, id => id === owner.id, receiver.sender, now);
  await service.pump();
  assert.equal(restored.state.jobs.length, 0);
  assert.equal(receiver.deliveries[0]?.body, receiver.deliveries[1]?.body);
  assert.notEqual(receiver.deliveries[0]?.headers['webhook-timestamp'], receiver.deliveries[1]?.headers['webhook-timestamp']);
  const unsub = unsubscribeSchema.parse({ name: request().name, arguments: request().arguments, delivery: { mode: 'webhook', url: request().delivery.url } });
  // Other authenticated accounts cannot remove the owner's deterministic identity.
  await service.unsubscribe({ id: 'other-owner' }, unsub);
  assert.equal(restored.state.subscriptions.length, 1);
  await service.unsubscribe(owner, unsub);
  await service.unsubscribe(owner, unsub);
  assert.equal(restored.state.subscriptions.length, 0);
  store.state = restored.state;
}

async function checkAllMessages(service: EventsService, store: SubscriptionStore, f: ReturnType<typeof fixture>, allow: () => void) {
  allow();
  f.policy.config.mcpEvents.allowAllMessages = true;
  await service.subscribe(owner, request('all'));
  const unaddressed = payload(observed({ actorId: ids.denied }), null);
  await service.emit(unaddressed);
  assert.equal(store.state.jobs.length, 1);
  assert.equal(JSON.parse(store.state.jobs[0]!.body).data.trigger_event_id, null);
  await assert.rejects(() => f.bridge.respond({ eventId: ids.denied, content: 'bypass', idempotencyKey: 'cannot-bypass' }));
  await service.emit(payload(observed({ channelId: ids.other }), f.event.id));
  assert.equal(store.state.jobs.length, 1);
  f.policy.config.channelScope = 'listed';
  f.policy.config.channelIds = [];
  await service.pump();
  assert.equal(store.state.subscriptions.length, 0);
  f.policy.config.channelScope = 'all';
}

async function checkRotation(directory: string, f: ReturnType<typeof fixture>) {
  let now = Date.now();
  let sent = 0;
  const sender: CallbackSender = async (_url, body, headers) => {
    const message = JSON.parse(body);
    const active = message.type === 'verification' ? (sent === 1 ? replacement : secret) : replacement;
    const signedAt = new Date(Number(headers['webhook-timestamp']) * 1000);
    // The artificial clock advances beyond the library's real-time window; compare exact signatures here.
    assert.ok(headers['webhook-signature']!.split(' ').includes(new Webhook(active).sign(headers['webhook-id']!, signedAt, body)));
    if (message.type === 'verification') { sent++; return { status: 200, body: JSON.stringify({ challenge: message.challenge }) }; }
    assert.ok(headers['webhook-signature']!.split(' ').includes(new Webhook(secret).sign(headers['webhook-id']!, signedAt, body)));
    assert.equal(headers['webhook-signature']!.split(' ').length, 2);
    return { status: 200, body: '' };
  };
  const store = new SubscriptionStore(`${directory}/rotation.json`);
  const service = new EventsService(store, f.policy, id => id === owner.id, sender, () => now);
  const input = { ...request(), ttlMs: 600_000 };
  const sub = await service.subscribe(owner, input);
  assert.equal((await service.subscribe(owner, { ...input, delivery: { ...request().delivery, secret: replacement } })).id, sub.id);
  assert.equal(sent, 2);
  await service.emit(payload(observed(), f.event.id));
  await service.pump();
  now += 301_000;
  await service.pump();
  assert.equal(store.state.subscriptions[0]?.previous, undefined);
  now += 301_000;
  await service.pump();
  assert.equal(store.state.subscriptions.length, 0);
  const refreshed = await service.subscribe(owner, { ...request(), ttlMs: null });
  assert.ok(refreshed.refreshBefore);
}

async function checkVerificationFailures() {
  assert.equal(secretSchema.safeParse('whsec_short').success, false);
  assert.equal(subscribeSchema.safeParse({ ...request(), arguments: { rawRest: true } }).success, false);
  const verifier = new Verifier(async () => ({ status: 200, body: '{"challenge":"wrong"}' }));
  await assert.rejects(() => verifier.verify(owner.id, { id: 'sub_mock', url: request().delivery.url, secret }), error =>
    error instanceof ProtocolError && error.code === -32015 && (error.data as { reason: string }).reason === 'challenge_failed');
  const timeout = new Verifier(async () => { throw new CallbackError('timeout'); });
  await assert.rejects(() => timeout.verify(owner.id, { id: 'sub_mock', url: request().delivery.url, secret }), error =>
    error instanceof ProtocolError && (error.data as { reason: string }).reason === 'timeout');
  const redirect = new Verifier(async () => ({ status: 302, body: '{}' }));
  await assert.rejects(() => redirect.verify(owner.id, { id: 'sub_mock', url: request().delivery.url, secret }));
  const signer = new Webhook(secret);
  const body = '{"data":"fixture"}';
  const headers = { 'webhook-id': 'evt_mock', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
    'webhook-signature': signer.sign('evt_mock', new Date(), body) };
  assert.throws(() => signer.verify(`${body} `, headers));
}

async function checkSsrf() {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700::1111'), true);
  assert.throws(() => callbackUrl('http://receiver.example'));
  assert.throws(() => callbackUrl('https://user:password@receiver.example'));
  const signal = AbortSignal.timeout(1000);
  await assert.rejects(() => resolveCallback(request().delivery.url, async () => [{ address: '127.0.0.1', family: 4 }], signal));
  await assert.rejects(() => resolveCallback(request().delivery.url, async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], signal));
  const destination = await resolveCallback(request().delivery.url, async () => [{ address: '8.8.8.8', family: 4 }], signal);
  const options = connectionOptions(destination.url, destination.address, {}, signal);
  assert.equal(options.agent, false);
  assert.equal(options.servername, 'receiver.example');
  options.lookup!('receiver.example', {}, (error, address) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
}

export async function checkCancellation(directory: string): Promise<void> {
  const f = fixture(`${directory}/cancel-journal.json`);
  f.policy.config.scopes.push('messages.read');
  f.policy.config.mcpEvents.enabled = true;
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const received = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sender: CallbackSender = async (_url, body) => {
    entered(); await gate;
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  };
  const store = new SubscriptionStore(`${directory}/cancel.json`);
  const service = new EventsService(store, f.policy, () => true, sender);
  const pending = service.subscribe(owner, request());
  await received;
  await service.unsubscribe(owner, unsubscribeSchema.parse({ name: request().name, arguments: request().arguments,
    delivery: { mode: 'webhook', url: request().delivery.url } }));
  release();
  await assert.rejects(() => pending);
  assert.equal(store.state.subscriptions.length, 0);
}

async function checkPermanentResponses(service: EventsService, store: SubscriptionStore, receiver: ReturnType<typeof mockReceiver>, data: ReturnType<typeof payload>) {
  for (const status of [410, 413]) {
    receiver.setStatus(status);
    await service.emit(data);
    await service.pump();
    assert.equal(store.state.jobs.length, 0);
    assert.equal(store.state.subscriptions[0]?.suspended, true);
    await service.pump();
    assert.equal(store.state.subscriptions.length, 1);
    await service.subscribe(owner, request());
  }
}
