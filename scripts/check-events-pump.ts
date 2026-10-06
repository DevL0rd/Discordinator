import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { SubscriptionStore } from '../src/events/store.js';
import { EventsService } from '../src/events/service.js';
import { payload } from '../src/events/schema.js';
import type { CallbackSender } from '../src/events/https.js';
import { fixture } from './fixtures.js';
import { observed } from './check-context.js';
import { request } from './check-events.js';

const owner = { id: 'pump-owner' };
const slowUrl = 'https://slow.example/callback';

function gatedReceiver() {
    let release: () => void = () => {};
    let fast: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const fastDelivered = new Promise<void>((resolve) => {
        fast = resolve;
    });
    let slowDelivered = false;
    const sender: CallbackSender = async (url, body) => {
        const message = JSON.parse(body) as { type?: string; challenge?: string };
        if (message.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: message.challenge }) };
        if (url !== slowUrl) fast();
        else {
            await gate;
            slowDelivered = true;
        }
        return { status: 200, body: '' };
    };
    return { sender, release, fastDelivered, slow: () => slowDelivered };
}

async function checkIdle(directory: string, f: ReturnType<typeof fixture>): Promise<void> {
    const store = new SubscriptionStore(`${directory}/idle-subscriptions.json`);
    let writes = 0;
    store.onChange = () => writes++;
    const service = new EventsService(store, f.policy, () => true, gatedReceiver().sender);
    service.start();
    await service.pump();
    await service.stop();
    assert.equal(writes, 0, 'An idle events service never rewrites its state');
    await assert.rejects(() => access(store.file), /ENOENT/);
}

export async function checkEventsPump(directory: string): Promise<void> {
    const f = fixture(`${directory}/pump-journal.json`);
    f.policy.config.scopes.push('messages.read');
    f.policy.config.mcpEvents = { enabled: true, allowAllMessages: false };
    await checkIdle(directory, f);
    const receiver = gatedReceiver();
    const store = new SubscriptionStore(`${directory}/pump-subscriptions.json`);
    const service = new EventsService(store, f.policy, (id) => id === owner.id, receiver.sender);
    service.start();
    const alive = setInterval(() => undefined, 1000);
    try {
        await service.subscribe(owner, { ...request(), delivery: { ...request().delivery, url: slowUrl } });
        await service.subscribe(owner, request());
        await service.emit(payload(observed(), f.event.id));
        await receiver.fastDelivered;
        assert.equal(receiver.slow(), false, 'A slow webhook does not hold back other subscriptions');
        receiver.release();
        await new Promise<void>((resolve) => {
            store.onChange = (state) => {
                if (!state.jobs.length) resolve();
            };
        });
        assert.equal(receiver.slow(), true, 'Queued jobs wake delivery without polling');
    } finally {
        clearInterval(alive);
        await service.stop();
    }
}
