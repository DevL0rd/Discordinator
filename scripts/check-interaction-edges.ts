import { until } from './discord-fakes.js';
import { fade } from '../src/core/fade.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { ButtonInteraction } from 'discord.js';
import { captureInteraction, handleControl } from '../src/interactions/gateway.js';
import { promptSchema } from '../src/interactions/schema.js';
import { fixture, ids } from './fixtures.js';

function checkPromptShapes(): void {
    const option = { key: 'a', label: 'A' };
    const field = { key: 'note', label: 'Note' };
    const issues = (value: Record<string, unknown>) => {
        const parsed = promptSchema.safeParse({ content: 'Pick', ...value });
        return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    assert.deepEqual(issues({ mode: 'buttons', options: [] }), ['Buttons/select require valid options only']);
    assert.deepEqual(issues({ mode: 'buttons', options: [option], fields: [field] }), ['Buttons/select require valid options only']);
    assert.deepEqual(
        issues({ mode: 'buttons', options: ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => ({ key, label: key })) }),
        ['Buttons/select require valid options only'],
        'At most five buttons fit one row',
    );
    assert.deepEqual(issues({ mode: 'modal', fields: [field], options: [option] }), ['Modal requires fields only']);
    assert.deepEqual(issues({ mode: 'modal' }), ['Modal requires fields only']);
    assert.deepEqual(issues({ mode: 'select', options: [option, option] }), ['Keys must be unique']);
    assert.deepEqual(issues({ mode: 'buttons', options: [option], maxValues: 2 }), [
        'Multiple selections require select mode and enough options',
    ]);
    assert.deepEqual(issues({ mode: 'select', options: [option], maxValues: 1 }), []);
}

function fakeInteraction(id: string) {
    const calls: { method: string; value?: Record<string, unknown> }[] = [];
    const record = (method: string) => (value?: Record<string, unknown>) => {
        calls.push({ method, value });
        return Promise.resolve({ id: ids.message, channelId: ids.channel });
    };
    const interaction = {
        id,
        deferReply: record('deferReply'),
        deferUpdate: record('deferUpdate'),
        editReply: record('editReply'),
        followUp: record('followUp'),
        deleteReply: record('deleteReply'),
    };
    return { interaction: interaction as unknown as ButtonInteraction, calls };
}

async function checkCapture(directory: string): Promise<void> {
    const f = fixture(join(directory, 'interaction-capture.json'));
    const input = { actorId: ids.user, channelId: ids.channel, guildId: ids.guild, kind: 'interaction' as const, text: 'go' };
    const payload = {
        content: 'Done',
        components: [],
        embeds: [{ title: 'Result' }],
        files: [{ data: Buffer.from('x'), name: 'result.txt', contentType: 'text/plain' }],
    };
    const loud = fakeInteraction('900000000000000001');
    const event = (await captureInteraction(loud.interaction, input, f.policy, f.queue))!;
    assert.equal(loud.calls[0]!.method, 'deferReply');
    assert.deepEqual(await f.queue.context(event.id).deliver!(payload), { id: ids.message, channel_id: ids.channel });
    const edited = loud.calls.at(-1)!;
    assert.equal(edited.method, 'editReply');
    assert.deepEqual(edited.value?.embeds, payload.embeds);
    assert.deepEqual(edited.value?.components, []);
    assert.deepEqual(edited.value?.attachments, [], 'Uploaded files replace earlier attachments');
    assert.deepEqual(edited.value?.files, [{ attachment: payload.files[0]!.data, name: 'result.txt' }]);
    assert.equal(await captureInteraction(loud.interaction, input, f.policy, f.queue), null, 'Duplicate interactions are ignored');
    fade.ms = 10;
    try {
        await f.queue.context(event.id).respond!('Working: reading files', true);
        assert.equal(loud.calls.at(-1)!.method, 'followUp', 'A progress update is its own private message, not the answer');
        await until(() => loud.calls.at(-1)!.method === 'deleteReply', 'the progress update disappears');
    } finally {
        fade.ms = 6000;
    }
    const quiet = fakeInteraction('900000000000000002');
    const captured = (await captureInteraction(quiet.interaction, input, f.policy, f.queue, true))!;
    assert.equal(quiet.calls[0]!.method, 'deferUpdate');
    await f.queue.context(captured.id).deliver!(payload);
    const followed = quiet.calls.at(-1)!;
    assert.equal(followed.method, 'followUp');
    assert.deepEqual(followed.value?.files, [{ attachment: payload.files[0]!.data, name: 'result.txt' }]);
}

async function checkIgnoredControls(directory: string): Promise<void> {
    const f = fixture(join(directory, 'interaction-ignored.json'));
    const base = { user: { id: ids.user }, isModalSubmit: () => false };
    const foreign = { ...base, channelId: ids.channel, customId: 'someone-else:button' } as unknown as ButtonInteraction;
    await handleControl(foreign, f.bridge.flows, f.policy, f.queue);
    assert.equal(f.queue.snapshot(0, 25).events.length, 1, 'Other applications’ controls are ignored');
    const channelless = { ...base, channelId: null, customId: 'discordinator:x' } as unknown as ButtonInteraction;
    await assert.rejects(handleControl(channelless, f.bridge.flows, f.policy, f.queue), /Control has no channel/);
}

export async function checkInteractionEdges(directory: string): Promise<void> {
    checkPromptShapes();
    await checkCapture(directory);
    await checkIgnoredControls(directory);
}
