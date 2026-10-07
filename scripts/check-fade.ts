import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fade, fadeLater } from '../src/core/fade.js';
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
    const status = (content: string, key: string) => f.bridge.respond({ eventId: f.event.id, content, idempotencyKey: key, status: true });
    fade.ms = 300;
    await status('On it, reading files', 'fade-status-1');
    await status('Running the tests', 'fade-status-2');
    assert.equal(sent('POST').length, 1, 'status updates share one message');
    const edits = sent('PATCH', `${route}/${ids.message}`);
    assert.deepEqual(
        edits.map((call) => (call.body as { content: string }).content),
        ['Running the tests'],
        'later updates edit it in place',
    );
    await f.bridge.respond({ eventId: f.event.id, content: 'Here is the answer.', idempotencyKey: 'fade-answer' });
    assert.deepEqual(
        deletes(f.api.calls).map((call) => call.route),
        [`${route}/${ids.message}`],
        'the status message goes as soon as the answer arrives',
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(deletes(f.api.calls).length, 1, 'Real answers stay');
    fade.ms = 20;
    await status('Still working', 'fade-status-3');
    await until(() => deletes(f.api.calls).length === 2, 'a status message with no further updates is removed');
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
        await checkMutedCall(directory);
    } finally {
        fade.ms = 6000;
    }
}
