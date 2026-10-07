import assert from 'node:assert/strict';
import { buttonsFor, choices, count, startable, stepView, textSteps, type State, type Step } from '../src/operator/onboarding-copy.js';
import type { DiscordDiscovery } from '../src/operator/onboarding-store.js';
import { assistants } from '../src/operator/ui/status.js';
import { fake } from './onboarding-fakes.js';

const blank = (step: Step, patch: Partial<State> = {}): State => ({
    step,
    input: '',
    selected: 0,
    draft: { token: '', ownerId: fake.owner, channelId: fake.channel },
    ...patch,
});

const ready: DiscordDiscovery = {
    bot: 'Fixture Bot',
    botId: fake.bot,
    servers: ['Fixture Guild'],
    intents: { messageContent: true, members: true },
    members: [
        { id: fake.owner, name: 'Boss (@owner)' },
        { id: '222222222222222222', name: '@amy' },
    ],
    channels: Array.from({ length: 14 }, (_, index) => ({ id: String(index), name: `room-${index}`, guild: 'Fixture Guild' })),
};

function checkTitles(): void {
    const titles: [Step, Partial<State>, RegExp, number][] = [
        ['loading', {}, /^Welcome$/, 0],
        ['welcome', {}, /Welcome to Discordinator/, 0],
        ['token', {}, /bot token/, 0],
        ['invite', {}, /Add the bot/, 0],
        ['owner', {}, /owner/, 0],
        ['channel', {}, /First channel/, 0],
        ['discord-review', {}, /Check Discord/, 0],
        ['ai', {}, /Who answers/, 1],
        ['domain', {}, /public domain/, 1],
        ['password', {}, /sign-in password/, 1],
        ['password-confirm', {}, /Confirm/, 1],
        ['ai-review', {}, /Ready to save/, 1],
        ['connect', { choice: 'codex-local' }, /Connect Codex/, 2],
        ['service', {}, /Install Discordinator/, 3],
        ['verify', {}, /Make sure it works/, 3],
    ];
    for (const [step, patch, title, stage] of titles) {
        const view = stepView(blank(step, patch), 2);
        assert.match(view.title, title, step);
        assert.equal(view.stage, stage, `${step} belongs to stage ${stage}`);
        assert.equal(view.tick, 2);
        assert.ok(view.body.length > 0, `${step} explains itself`);
        assert.equal(Boolean(view.input), textSteps.includes(step), `${step} input`);
    }
    assert.equal(stepView(blank('connect'), 0).title, 'Connect Claude Code', 'Claude Code is the default local app');
    assert.equal(stepView(blank('token', { input: 'secret' }), 0).input?.masked, true, 'the token is hidden');
    assert.equal(stepView(blank('password'), 0).input?.masked, true);
    assert.equal(stepView(blank('password-confirm'), 0).input?.masked, true);
    assert.equal(stepView(blank('domain', { input: 'bot.example.com' }), 0).input?.masked, false, 'the domain is visible');
}

function checkBodies(): void {
    const unchecked = stepView(blank('discord-review', { discovery: ready }), 0).body;
    assert.deepEqual(unchecked, ['Bot: Fixture Bot', `Owner: ${fake.owner}`, `Channel: ${fake.channel}`]);
    assert.equal(stepView(blank('discord-review'), 0).body[0], 'Bot: not checked yet');
    const identity = { bot: 'Bot (1)', owner: 'Owner (2)', channel: 'general (3)', guildId: fake.guild };
    assert.deepEqual(stepView(blank('discord-review', { identity }), 0).body, ['Bot: Bot (1)', 'Owner: Owner (2)', 'Channel: general (3)']);
    for (const [selected, choice] of choices.entries())
        assert.deepEqual(stepView(blank('ai', { selected }), 0).body, [assistants[choice].blurb], `${choice} blurb`);
    assert.deepEqual(stepView(blank('ai', { selected: 9 }), 0).body, [assistants['claude-session'].blurb]);
    const previous = process.env.DISCORDINATOR_PORT;
    process.env.DISCORDINATOR_PORT = '9123';
    try {
        assert.match(stepView(blank('domain'), 0).body.join(' '), /127\.0\.0\.1:9123/, 'the domain step names the local port');
    } finally {
        if (previous === undefined) delete process.env.DISCORDINATOR_PORT;
        else process.env.DISCORDINATOR_PORT = previous;
    }
    const manual = stepView(blank('ai-review', { choice: 'manual-mcp', evidence: 'http://127.0.0.1:8787/mcp' }), 0).body;
    assert.deepEqual(manual, [
        assistants['manual-mcp'].name,
        'http://127.0.0.1:8787/mcp',
        'Your MCP app connects to Discordinator and answers by itself.',
    ]);
    assert.deepEqual(stepView(blank('ai-review'), 0).body, [assistants['claude-session'].name, '', 'It starts when you finish setup.']);
    assert.deepEqual(stepView(blank('verify'), 0).body, ['Checking that everything works…']);
    const checks = [{ label: 'Discordinator is running', ok: true, hint: '' }];
    assert.deepEqual(stepView(blank('verify', { checks }), 0).body, ['✓ Discordinator is running', 'Everything is connected and working.']);
    assert.match(stepView(blank('invite', { discovery: ready }), 0).body.join('\n'), /✓ The bot is in a server: Fixture Guild/);
}

function checkButtons(): void {
    const waiting = { ...ready, intents: { messageContent: false, members: true } };
    const pending = { label: 'x', ok: false, hint: 'do it' };
    const cases: [State, string[]][] = [
        [blank('welcome'), ['Begin']],
        [blank('invite', { discovery: ready }), ['Continue']],
        [blank('invite', { discovery: waiting }), ['Open invite', 'Check again']],
        [blank('invite'), ['Open invite', 'Check again']],
        [blank('discord-review'), ['Verify']],
        [blank('discord-review', { identity: { bot: '', owner: '', channel: '', guildId: '' } }), ['Save', 'Back']],
        [blank('ai-review'), ['Save', 'Back']],
        [blank('connect'), ['Continue']],
        [blank('connect', { error: 'Install failed.' }), ['Retry', 'Skip']],
        [blank('service'), ['Skip', 'Install', 'Back']],
        [blank('verify'), ['Check again']],
        [blank('verify', { checks: [] }), ['Finish']],
        [blank('verify', { checks: [pending] }), ['Check again']],
        [blank('token'), []],
        [blank('loading'), []],
    ];
    for (const [state, buttons] of cases) assert.deepEqual(buttonsFor(state), buttons, state.step);
    assert.equal(startable(undefined), false, 'nothing to start before the checks ran');
    assert.equal(
        startable([
            { ...pending, start: true },
            { ...pending, ok: true },
        ]),
        true,
    );
}

function checkOptions(): void {
    assert.deepEqual(
        stepView(blank('ai'), 0).options,
        choices.map((choice) => assistants[choice].name),
        'every responder is offered',
    );
    assert.equal(count(blank('ai')), choices.length);
    assert.deepEqual(stepView(blank('owner', { discovery: ready }), 0).options, ['Boss (@owner)', '@amy']);
    assert.deepEqual(stepView(blank('owner', { discovery: ready, input: 'bo' }), 0).options, ['Boss (@owner)'], 'typing filters people');
    assert.equal(count(blank('owner', { discovery: ready, input: fake.owner })), 0, 'a pasted ID needs no list');
    assert.equal(stepView(blank('owner'), 0).options, undefined, 'without members the owner is typed');
    const channels = stepView(blank('channel', { discovery: ready }), 0).options;
    assert.equal(channels?.length, 12, 'at most twelve channels are listed');
    assert.equal(channels?.[0], 'Fixture Guild / #room-0');
    assert.equal(stepView(blank('channel', { discovery: ready, input: '1' }), 0).options, undefined, 'a typed channel hides the list');
    assert.equal(count(blank('service')), 3, 'without options the buttons are counted');
    const view = stepView(blank('welcome', { notice: 'Saved.', error: 'Oops.', busy: 'Working…' }), 0);
    assert.deepEqual([view.notice, view.error, view.busy], ['Saved.', 'Oops.', 'Working…']);
    assert.equal('notice' in stepView(blank('welcome'), 0), false, 'empty messages are left out');
}

export function checkOnboardingCopy(): void {
    checkTitles();
    checkBodies();
    checkButtons();
    checkOptions();
}
