import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { Onboarding } from '../src/operator/onboarding.js';
import { onboardingPhase } from '../src/operator/onboarding-store.js';
import { readOperatorConfig, writeOperatorConfig } from '../src/operator/config.js';
import { discordRoutes, inScratch, withDiscord, withLocal, type LiveFake, liveFake } from './onboarding-fakes.js';

class Keyboard extends PassThrough {
    isTTY = true;
    setRawMode() {
        return this;
    }
    ref() {
        return this;
    }
    unref() {
        return this;
    }
}

class Screen extends Writable {
    columns = 100;
    rows = 40;
    frame = '';
    override _write(chunk: Buffer, _encoding: string, done: () => void) {
        this.frame = String(chunk);
        done();
    }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

async function until(screen: Screen, text: string): Promise<void> {
    for (let attempt = 0; attempt < 1000 && !screen.frame.includes(text); attempt++) await pause();
    assert.ok(screen.frame.includes(text), `expected the wizard to show “${text}”:\n${screen.frame}`);
}

type Keys = (text: string) => Promise<void>;

async function wizard(run: (keys: Keys, screen: Screen) => Promise<void>): Promise<number> {
    let completed = 0;
    const keyboard = new Keyboard();
    const screen = new Screen();
    const terminal = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const app = render(createElement(Onboarding, { onComplete: () => completed++ }), {
        stdin: keyboard as unknown as NodeJS.ReadStream,
        stdout: screen as unknown as NodeJS.WriteStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
    });
    try {
        await run(async (text) => {
            keyboard.write(text);
            await pause();
        }, screen);
    } finally {
        app.unmount();
        app.cleanup();
        if (terminal) Object.defineProperty(process.stdin, 'isTTY', terminal);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    return completed;
}

async function withToken<T>(token: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.DISCORD_BOT_TOKEN;
    process.env.DISCORD_BOT_TOKEN = token;
    try {
        return await run();
    } finally {
        if (previous === undefined) delete process.env.DISCORD_BOT_TOKEN;
        else process.env.DISCORD_BOT_TOKEN = previous;
    }
}

async function firstSteps(keys: Keys, screen: Screen): Promise<void> {
    await until(screen, 'Welcome to Discordinator');
    await keys('\x1b[B');
    await keys('\r');
    await until(screen, 'Your bot token');
    await keys('\x1b');
    await until(screen, 'Welcome to Discordinator');
    await keys('\r');
    await until(screen, 'Your bot token');
    await keys('fixture-token');
    await keys('\r');
    await until(screen, 'Add the bot to your server');
    await keys('\r');
    await until(screen, 'Who is the owner?');
    await keys('nobody');
    await keys('\r');
    await until(screen, 'Pick yourself from the list');
    await keys('\x03');
}

async function finishVerify(live: LiveFake): Promise<number> {
    await writeOperatorConfig({ ...(await readOperatorConfig()), mode: 'manual-mcp' });
    await writeFile(join('.data', 'onboarding.json'), JSON.stringify({ phase: 'verify' }));
    return withToken('fixture-token', () =>
        wizard(async (keys, screen) => {
            await until(screen, '○ Discordinator is running');
            live.online = true;
            await keys('\r');
            await until(screen, '✓ Discordinator is running');
        }),
    );
}

export async function checkOnboardingUi(directory: string): Promise<void> {
    await inScratch(directory, async () => {
        const live = liveFake();
        await withLocal(live, async () => {
            await withDiscord(discordRoutes(), () => withToken('', () => wizard(firstSteps)));
            assert.equal(await finishVerify(live), 1, 'Check again finishes setup once everything works');
            assert.equal(await onboardingPhase({ DISCORD_BOT_TOKEN: 'fixture-token' }), 'complete');
        });
    });
}
