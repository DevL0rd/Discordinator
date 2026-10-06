import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { peopleRevision } from '../src/operator/people.js';
import { PolicyWatcher } from '../src/operator/policy-watcher.js';
import { restartOnEnvironmentChange } from '../src/operator/environment-watcher.js';
import { fixture, ids } from './fixtures.js';
import { ReplyOrigins } from '../src/core/reply-origins.js';

async function until(check: () => boolean): Promise<void> {
    for (let index = 0; index < 100 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(check(), 'policy change applied');
}

export async function checkPeople(directory: string): Promise<void> {
    assert.notEqual(peopleRevision([ids.user]), peopleRevision([ids.denied]));
    const f = fixture(join(directory, 'people-journal.json'));
    const path = join(directory, 'people-policy.json');
    await writeFile(path, JSON.stringify(f.policy.config));
    const origins = new ReplyOrigins(join(directory, 'people-origins.json'));
    await origins.capture(f.event);
    const watcher = new PolicyWatcher(path, f.policy, origins);
    watcher.start();
    try {
        const next = { ...f.policy.config, allowedUserIds: [], channels: { mode: 'blocklist', allowed: [], blocked: [ids.channel] } };
        await writeFile(path, JSON.stringify(next));
        await until(() => f.policy.config.allowedUserIds.length === 0);
        assert.equal(f.policy.channelAllowed(ids.channel), false, 'scope changes apply without a restart');
        assert.throws(() => origins.context(f.event.id), /revoked/, 'removed people lose reply authority');
        await writeFile(path, '{"servers": 5}');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(f.policy.channelAllowed(ids.channel), false, 'an invalid file keeps the previous policy');
    } finally {
        await watcher.stop();
    }
}

export async function checkEnvironmentRestart(directory: string): Promise<void> {
    const path = join(directory, 'restart.env');
    await writeFile(path, 'DISCORDINATOR_PORT=1\n');
    const previous = process.env.INVOCATION_ID;
    process.env.INVOCATION_ID = 'check';
    const steps: string[] = [];
    let release = () => undefined as void;
    const idle = new Promise<void>((resolve) => (release = resolve));
    const stop = restartOnEnvironmentChange(
        path,
        () => {
            steps.push('waiting');
            return idle;
        },
        () => {
            steps.push('restart');
            return Promise.resolve();
        },
    );
    try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await writeFile(path, 'DISCORDINATOR_PORT=1\n');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.deepEqual(steps, [], 'rewriting identical settings does not restart');
        await writeFile(path, 'DISCORDINATOR_PORT=2\n');
        await until(() => steps.length === 1);
        assert.deepEqual(steps, ['waiting'], 'changed settings wait for running work');
        release();
        await until(() => steps.length === 2);
        assert.deepEqual(steps, ['waiting', 'restart']);
    } finally {
        stop();
        if (previous === undefined) delete process.env.INVOCATION_ID;
        else process.env.INVOCATION_ID = previous;
    }
}
