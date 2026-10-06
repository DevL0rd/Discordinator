import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { fixture, ids } from './fixtures.js';
import { EventsService } from '../src/events/service.js';
import { SubscriptionStore } from '../src/events/store.js';
import { interactionEventName, interactionPayload, subscribeSchema } from '../src/events/schema.js';
import type { CallbackSender } from '../src/events/https.js';

export async function checkInteractionEvents(directory: string): Promise<void> {
    const f = fixture(join(directory, 'interaction-events-journal.json'));
    f.policy.config.scopes.push('messages.read');
    f.policy.config.mcpEvents.enabled = true;
    const secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
    const delivered: unknown[] = [];
    const sender: CallbackSender = (_url, body, headers) => {
        new Webhook(secret).verify(body, headers);
        const event = JSON.parse(body) as { type?: string; challenge?: string };
        if (event.type === 'verification') return Promise.resolve({ status: 200, body: JSON.stringify({ challenge: event.challenge }) });
        delivered.push(event);
        return Promise.resolve({ status: 200, body: '' });
    };
    const store = new SubscriptionStore(join(directory, 'interaction-event-subscriptions.json'));
    const service = new EventsService(store, f.policy, (id) => id === 'verified-owner', sender);
    const owner = { id: 'verified-owner' };
    const input = {
        arguments: { delivery: 'addressed' },
        delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret },
        cursor: null,
    };
    await service.subscribe(owner, subscribeSchema.parse({ ...input, name: 'discord.message.created' }));
    await service.subscribe(owner, subscribeSchema.parse({ ...input, name: interactionEventName }));
    const child = f.queue.add('verified-control', {
        ...f.event,
        kind: 'interaction',
        name: 'discordinator.control',
        sourceEventId: f.event.id,
        text: '{"choices":["a","b"]}',
    })!;
    await service.emit(interactionPayload(child, ids.other), interactionEventName);
    assert.equal(store.state.jobs.length, 1);
    const job = JSON.parse(store.state.jobs[0]!.body) as { name: string; data: { sourceEventId?: string } };
    assert.equal(job.name, interactionEventName);
    assert.equal(job.data.sourceEventId, f.event.id);
    await service.pump();
    assert.equal(delivered.length, 1);
    await service.emit(interactionPayload({ ...child, actorId: ids.denied }, ids.other), interactionEventName);
    assert.equal(store.state.jobs.length, 0);
    assert.deepEqual(
        service.list(owner).events.map((event) => event.name),
        ['discord.message.created', interactionEventName],
    );
    await service.stop();
}
