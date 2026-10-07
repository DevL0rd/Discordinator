import assert from 'node:assert/strict';
import type { PolicyConfig } from '../src/core/config.js';
import { ids } from './fixtures.js';
import { until } from './discord-fakes.js';
import { tone, voiceChannel, voiceHarness } from './voice-fakes.js';

type Harness = ReturnType<typeof voiceHarness>;

const save = (h: Harness, change: (policy: PolicyConfig) => PolicyConfig) => h.policy.update(change(structuredClone(h.policy.config)));
const voice = (h: Harness, settings: Partial<PolicyConfig['voice']>) =>
    save(h, (policy) => ({ ...policy, voice: { ...policy.voice, ...settings } }));

async function wake(h: Harness): Promise<void> {
    const before = h.providers.sessions.length;
    h.providers.heard.push('Discordinator are you there');
    h.link().talk(ids.user, tone(1));
    await until(() => h.providers.sessions.length === before + 1, 'its name opens the live voice');
}

async function checkPeople(h: Harness): Promise<void> {
    voice(h, { leaveAfterSeconds: 5 });
    save(h, (policy) => ({ ...policy, ownerUserId: undefined, allowedUserIds: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(h.voice.session(ids.guild), 'removing the last approved person starts the leave timer');
    voice(h, { leaveAfterSeconds: 0.05 });
    await until(() => !h.voice.session(ids.guild), 'a shorter leave time applies to the timer already running');
    save(h, (policy) => ({ ...policy, ownerUserId: ids.user, allowedUserIds: [ids.user] }));
    await until(() => Boolean(h.voice.session(ids.guild)), 'approving someone already in a call brings it back');
    assert.equal(h.links.length, 2);
}

async function checkLiveVoice(h: Harness): Promise<void> {
    await wake(h);
    const first = h.providers.session;
    const opened = h.providers.sessions.length;
    voice(h, { liveVoice: 'Kore' });
    await until(() => h.providers.sessions.length === opened + 1, 'a new voice reconnects the live conversation');
    assert.equal(first.closed, true, 'the old voice stops');
    assert.equal(h.providers.session.options.voice, 'Kore');
    first.events.closed();
    first.events.audio(new Int16Array(4800));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.providers.sessions.length, opened + 1, 'the replaced session cannot reconnect or speak');
    voice(h, { idleSeconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.providers.sessions.length, opened + 1, 'settings the live voice does not use leave it connected');
    h.voice.keyChanged();
    await until(() => h.providers.sessions.length === opened + 2, 'a new Gemini key reconnects it too');
    save(h, (policy) => ({ ...policy, scopes: policy.scopes.filter((scope) => scope !== 'voice.speak') }));
    await until(() => h.providers.session.closed, 'losing voice.speak ends the live conversation');
    save(h, (policy) => ({ ...policy, scopes: [...policy.scopes, 'voice.speak'] }));
}

async function checkSwitches(h: Harness): Promise<void> {
    voice(h, { enabled: false });
    await until(() => !h.voice.session(ids.guild), 'turning voice off leaves the call');
    voice(h, { enabled: true });
    await until(() => Boolean(h.voice.session(ids.guild)), 'turning it back on joins approved people already in a call');
    save(h, (policy) => ({ ...policy, channels: { mode: 'blocklist', allowed: [], blocked: [voiceChannel] } }));
    await until(() => !h.voice.session(ids.guild), 'blocking the channel leaves the call');
    save(h, (policy) => ({ ...policy, channels: { mode: 'blocklist', allowed: [], blocked: [] } }));
    await until(() => Boolean(h.voice.session(ids.guild)), 'unblocking it joins again');
    await h.voice.stop();
}

export async function checkVoiceSettings(directory: string): Promise<void> {
    const h = voiceHarness(directory, 'voice-settings');
    h.guilds.seats.set(ids.user, voiceChannel);
    await h.voice.ready();
    assert.ok(h.voice.session(ids.guild), 'it joins an approved person at startup');
    await checkPeople(h);
    await checkLiveVoice(h);
    await checkSwitches(h);
}
