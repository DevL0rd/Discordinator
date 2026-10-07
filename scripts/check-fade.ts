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
    await f.bridge.respond({ eventId: f.event.id, content: 'Working: reading files', idempotencyKey: 'fade-status', status: true });
    await f.bridge.respond({ eventId: f.event.id, content: 'Here is the answer.', idempotencyKey: 'fade-answer' });
    await until(() => deletes(f.api.calls).length === 1, 'the progress update is deleted');
    assert.deepEqual(deletes(f.api.calls)[0]!.route, `/channels/${ids.channel}/messages/${ids.message}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(deletes(f.api.calls).length, 1, 'Real answers stay');
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
