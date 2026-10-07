import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fade, fadeLater } from '../src/core/fade.js';
import { statusSection } from '../src/core/status-board.js';
import { until } from './discord-fakes.js';
import { fixture, ids } from './fixtures.js';
import { tone, voiceChannel, voiceHarness } from './voice-fakes.js';

const deletes = (calls: { method: string; route: string }[]) => calls.filter((call) => call.method === 'DELETE');

async function checkTimer(): Promise<void> {
    const removed: string[] = [];
    fadeLater(() => Promise.resolve(void removed.push('gone')), 5);
    fadeLater(() => Promise.reject(new Error('already deleted')), 5);
    await until(() => removed.length === 1, 'a faded message is removed');
    assert.equal(fade.ms, 6000, 'Progress updates last about six seconds');
}

async function checkMessageOrigin(directory: string): Promise<void> {
    const f = fixture(join(directory, 'fade.json'));
    const route = `/channels/${ids.channel}/messages`;
    const sent = (method: string, path = route) => f.api.calls.filter((call) => call.method === method && call.route === path);
    const contents = () => sent('PATCH', `${route}/${ids.message}`).map((call) => (call.body as { content: string }).content);
    const status = (content: string, key: string) => f.bridge.respond({ eventId: f.event.id, content, idempotencyKey: key, status: true });
    await f.bridge.respond({ eventId: f.event.id, content: 'On it.', idempotencyKey: 'status-ack' });
    await status('Reading files', 'status-1');
    await status('Reading files', 'status-1b');
    await status('Running the tests', 'status-2');
    assert.equal(sent('POST').length, 1, 'progress never posts a new message after the acknowledgement');
    assert.equal(contents().length, 2, 'a repeated step does not edit again');
    assert.equal(
        contents().at(-1),
        `On it.\n\n${statusSection(['Reading files', 'Running the tests'])}`,
        'steps show under the acknowledgement',
    );
    assert.match(contents().at(-1)!, /✓ Reading files[\s\S]*Running the tests/);
    await f.bridge.respond({ eventId: f.event.id, content: 'Here is the answer.', idempotencyKey: 'status-answer' });
    assert.equal(contents().at(-1), 'On it.', 'the answer removes the status section and keeps the acknowledgement');
    assert.equal(deletes(f.api.calls).length, 0, 'nothing is deleted');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent('PATCH', `${route}/${ids.message}`).length, 3, 'nothing changes on its own later');
}

async function checkWithoutAcknowledgement(directory: string): Promise<void> {
    const f = fixture(join(directory, 'fade-bare.json'));
    await f.bridge.respond({ eventId: f.event.id, content: 'Checking', idempotencyKey: 'bare-1', status: true });
    assert.equal(
        f.api.calls.filter((call) => call.method === 'POST').length,
        1,
        'without an acknowledgement the status gets its own reply',
    );
    await f.bridge.respond({ eventId: f.event.id, content: 'Done.', idempotencyKey: 'bare-answer' });
    assert.equal(deletes(f.api.calls).length, 1, 'a status-only reply goes when the answer arrives');
}

async function checkMutedCall(directory: string): Promise<void> {
    const h = voiceHarness(directory, 'fade-voice');
    h.guilds.seats.set(ids.user, voiceChannel);
    await h.voice.join(ids.guild, voiceChannel);
    h.link().muted = true;
    h.providers.heard.push('Discordinator check the logs');
    h.link().talk(ids.user, tone(1));
    await until(() => h.queue.snapshot(0, 100).events.some((event) => event.kind === 'voice'), 'muted, the request goes to the responder');
    const event = h.queue.snapshot(0, 100).events.find((item) => item.kind === 'voice')!;
    await h.bridge.respond({ eventId: event.id, content: 'Working: reading logs', idempotencyKey: 'fade-voice-status', status: true });
    await until(() => deletes(h.api.calls).length === 1, 'progress typed in a muted call is deleted too');
    await h.voice.stop();
}

export async function checkFade(directory: string): Promise<void> {
    await checkTimer();
    fade.ms = 20;
    try {
        await checkMessageOrigin(directory);
        await checkWithoutAcknowledgement(directory);
        await checkMutedCall(directory);
    } finally {
        fade.ms = 6000;
    }
}
