import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, resumed } from '../src/operator/onboarding.js';
import type { State } from '../src/operator/onboarding-copy.js';
import { onboardingPhase } from '../src/operator/onboarding-store.js';
import { readOperatorConfig } from '../src/operator/config.js';
import { presenceFile } from '../src/operator/presence.js';
import { discordRoutes, fake, inScratch, withDiscord, withLocal, type LiveFake } from './onboarding-fakes.js';

const start: State = { step: 'welcome', input: '', selected: 0, draft: { token: '', ownerId: '', channelId: '' } };
const press = (state: State, selected = 0, input = state.input) => advance({ ...state, selected, input }, () => undefined);
const phase = async () => onboardingPhase({ DISCORD_BOT_TOKEN: 'fixture-token' });

async function invite(): Promise<State> {
    const welcome = await press(start);
    assert.equal(welcome.step, 'token', 'Begin asks for the token');
    const token = await withDiscord(discordRoutes(0), () => press(welcome, 0, '  fixture-token  '));
    assert.equal(token.step, 'invite');
    assert.equal(token.draft.token, 'fixture-token', 'the token is trimmed');
    assert.deepEqual(token.discovery?.intents, { messageContent: false, members: false });
    const missing = await withDiscord(discordRoutes(0), () => press(token, 1));
    assert.equal(missing.step, 'invite', 'Check again stays until the bot is ready');
    assert.match(missing.error ?? '', /Not done yet/);
    const fixed = await withDiscord(discordRoutes(), () => press(missing, 1));
    assert.equal(fixed.error, undefined, 'a passing check clears the error');
    assert.deepEqual(fixed.discovery?.servers, ['Fixture Guild', fake.quiet]);
    return fixed;
}

async function discord(): Promise<State> {
    const ready = await invite();
    const owner = await press(ready);
    assert.equal(owner.step, 'owner', 'Continue moves on once the bot is invited');
    await assert.rejects(press(owner, 0, 'nobody-here'), /Pick yourself/);
    const channel = await press(owner, 1);
    assert.equal(channel.draft.ownerId, fake.owner, 'the highlighted member becomes the owner');
    assert.equal(channel.step, 'channel');
    await assert.rejects(press({ ...channel, discovery: undefined }), /Pick a channel/);
    const typed = await press(channel, 0, ` ${fake.announcements} `);
    assert.equal(typed.draft.channelId, fake.announcements, 'a typed channel ID wins');
    const review = await press(channel, 0);
    assert.equal(review.step, 'discord-review');
    assert.equal(review.draft.channelId, fake.channel, 'the highlighted channel is used');
    return review;
}

async function saveDiscordStep(review: State): Promise<State> {
    const checked = await withDiscord(discordRoutes(), () => press(review));
    assert.deepEqual(checked.identity, {
        bot: `Fixture Bot (${fake.bot})`,
        owner: `owner (${fake.owner})`,
        channel: `general (${fake.channel})`,
        guildId: fake.guild,
    });
    assert.equal(checked.notice, 'Everything checks out. Save to continue.');
    assert.equal((await press(checked, 1)).step, 'channel', 'Back returns to the channel');
    const ai = await press(checked, 0);
    assert.equal(ai.step, 'ai');
    assert.equal(ai.notice, 'Discord saved.');
    assert.match(await readFile('.env', 'utf8'), /DISCORD_BOT_TOKEN="fixture-token"/);
    assert.deepEqual((JSON.parse(await readFile('policy.json', 'utf8')) as { allowedUserIds: string[] }).allowedUserIds, [fake.owner]);
    assert.equal(await phase(), 'ai', 'a restart resumes at the responder');
    return ai;
}

async function manualResponder(ai: State, live: LiveFake): Promise<void> {
    const review = await press(ai, 3);
    assert.equal(review.step, 'ai-review', 'another MCP app needs no password');
    assert.equal(review.choice, 'manual-mcp');
    assert.match(review.evidence ?? '', /http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.equal((await press(review, 1)).step, 'ai', 'Back returns to the responder list');
    const service = await press(review);
    assert.equal(service.step, 'service', 'MCP apps skip the connect step');
    assert.equal((await readOperatorConfig()).mode, 'manual-mcp');
    assert.equal((await press(service, 2)).step, 'ai-review', 'Back returns to the review');
    const verify = await press(service);
    assert.equal(verify.step, 'verify', 'Skip goes straight to verifying');
    assert.equal(await phase(), 'verify');
    assert.deepEqual(
        verify.checks?.map((check) => check.ok),
        [false],
    );
    let completed = 0;
    const waiting = await advance(verify, () => completed++);
    assert.match(waiting.error ?? '', /Not everything is connected yet/);
    assert.equal(completed, 0);
    live.online = true;
    const done = await advance({ ...waiting, error: undefined }, () => completed++);
    assert.equal(completed, 1, 'finishing calls back once');
    assert.equal(done.error, undefined);
    assert.equal(await phase(), 'complete');
}

async function chatgptPassword(ai: State): Promise<State> {
    const domain = await press(ai, 2);
    assert.equal(domain.step, 'domain');
    assert.equal(domain.choice, 'chatgpt-events');
    await assert.rejects(press(domain, 0, 'https://bot.example.com'), /just the domain/);
    const password = await press(domain, 0, ' bot.example.com ');
    assert.equal(password.step, 'password');
    assert.equal(password.domain, 'bot.example.com');
    await assert.rejects(press(password, 0, 'short'), /at least 12/);
    const confirm = await press(password, 0, 'fixture-password-long');
    assert.equal(confirm.step, 'password-confirm');
    assert.equal(confirm.input, '', 'the confirmation starts empty');
    await assert.rejects(press(confirm, 0, 'fixture-password-wrong'), /do not match/);
    const review = await press(confirm, 0, 'fixture-password-long');
    assert.equal(review.step, 'ai-review');
    assert.equal(review.password, undefined, 'the password is not kept in memory');
    assert.equal(review.notice, 'Password saved.');
    assert.match(review.evidence ?? '', /sign-in is still required/);
    assert.equal((await press(review, 1)).step, 'domain', 'Back returns to the domain');
    return review;
}

async function chatgptResponder(ai: State, live: LiveFake): Promise<void> {
    const review = await chatgptPassword(ai);
    const service = await press(review);
    assert.equal(service.step, 'service');
    assert.match(await readFile('.env', 'utf8'), /DISCORDINATOR_RESOURCE_URL="https:\/\/bot\.example\.com\/mcp"/);
    const verify = await press(service);
    assert.equal(verify.checks?.find((check) => check.start)?.ok, false, 'not answering before Finish');
    await writeFile(presenceFile, JSON.stringify({ remoteAt: '2026-01-01T00:00:00.000Z', subscriptions: 1 }));
    live.subscriptions = 1;
    let completed = 0;
    const done = await advance(verify, () => completed++);
    assert.equal(completed, 1, 'Finish starts ChatGPT and completes');
    assert.ok(done.checks?.every((check) => check.ok));
    assert.equal((await readOperatorConfig()).enabled, true);
    const connectors = JSON.parse(await readFile(join('.data', 'web-connectors.json'), 'utf8')) as { chatgpt?: string };
    assert.equal(connectors.chatgpt, 'https://bot.example.com/mcp', 'the ChatGPT connector is remembered');
}

async function localResponder(): Promise<void> {
    await writeFile('.env', 'DISCORDINATOR_RESOURCE_URL="https://bot.example.com/mcp"\n');
    const password = await press({ ...start, step: 'ai' }, 0);
    assert.equal(password.step, 'password', 'a public domain asks local responders for a password too');
    assert.equal(password.choice, 'claude-session');
    const connect = await press({ ...start, step: 'ai-review', choice: 'codex-local' });
    assert.equal(connect.step, 'connect', 'local responders connect next');
    assert.equal((await readOperatorConfig()).mode, 'codex-local');
    assert.equal((await press(connect)).step, 'service', 'Continue after connecting');
    const failed = { ...connect, error: 'Install failed.' };
    const retry = await press(failed, 0);
    assert.equal(retry.step, 'connect', 'Retry stays to connect again');
    assert.equal(retry.error, undefined);
    assert.equal((await press(failed, 1)).step, 'service', 'Skip moves on without connecting');
}

function checkResume(): void {
    assert.deepEqual(resumed('discord', 'claude-session'), { step: 'welcome' });
    assert.deepEqual(resumed('complete', 'claude-session'), { step: 'welcome' });
    assert.deepEqual(resumed('ai', 'manual-mcp'), { step: 'ai' });
    assert.deepEqual(resumed('service', 'codex-local'), { step: 'service', choice: 'codex-local' });
    assert.deepEqual(resumed('verify', 'chatgpt-poll'), { step: 'verify', choice: 'chatgpt-events' });
}

export async function checkOnboardingFlow(directory: string): Promise<void> {
    checkResume();
    assert.deepEqual(await press({ ...start, step: 'loading' }), { ...start, step: 'loading' }, 'loading has no action');
    await inScratch(directory, async () => {
        const live: LiveFake = { subscriptions: 0, online: false, probes: [] };
        await withLocal(live, async () => {
            const ai = await saveDiscordStep(await discord());
            await manualResponder(ai, live);
            await chatgptResponder(ai, live);
        });
        assert.deepEqual(live.probes, ['https://bot.example.com/mcp'], 'the domain is probed once during review');
    });
    await inScratch(directory, () => withLocal({ subscriptions: 0, online: false, probes: [] }, localResponder));
}
