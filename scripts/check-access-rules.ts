import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { policySchema } from '../src/core/config.js';
import { Policy } from '../src/core/policy.js';
import { acquireRuntime } from '../src/core/runtime.js';
import { rich } from '../src/discord/operations.js';
import { ids } from './fixtures.js';

const thread = '888888888888888888';

function policyWith(channels: { mode: 'allowlist' | 'blocklist'; allowed?: string[]; blocked?: string[] }): Policy {
    return new Policy(policySchema.parse({ allowedUserIds: [ids.user], servers: { mode: 'blocklist' }, channels }));
}

function checkThreads(): void {
    const allowlist = policyWith({ mode: 'allowlist', allowed: [ids.channel] });
    assert.equal(allowlist.channelAllowed(thread), false, 'an unknown thread is not approved');
    allowlist.noteThread(thread, ids.channel);
    assert.equal(allowlist.channelAllowed(thread), true, 'threads follow their approved parent channel');
    allowlist.noteThread(thread, ids.other);
    assert.equal(allowlist.channelAllowed(thread), false);
    const blocklist = policyWith({ mode: 'blocklist', blocked: [ids.channel] });
    blocklist.noteThread(thread, ids.channel);
    assert.equal(blocklist.channelAllowed(thread), false, 'threads under a blocked channel are blocked');
    const blockedThread = policyWith({ mode: 'allowlist', allowed: [ids.channel], blocked: [thread] });
    blockedThread.noteThread(thread, ids.channel);
    assert.equal(blockedThread.channelAllowed(thread), false, 'a thread can still be blocked on its own');
}

function checkEmbedTotal(): void {
    const big = { description: 'x'.repeat(4000) };
    assert.ok(rich.embeds.safeParse([big]).success);
    assert.match(
        JSON.stringify(rich.embeds.safeParse([big, big]).error?.issues),
        /6000 characters/,
        'embed totals are checked before sending',
    );
}

async function checkRuntimeLock(directory: string): Promise<void> {
    const previous = process.cwd();
    process.chdir(directory);
    try {
        await mkdir('.data', { recursive: true });
        await writeFile('.data/runtime.lock', '999999999');
        const release = await acquireRuntime();
        await release();
        await writeFile('.data/runtime.lock', String(process.ppid));
        await assert.rejects(acquireRuntime(), /already running/, 'a live instance keeps its lock');
        await writeFile('.data/runtime.lock', '');
        await assert.rejects(acquireRuntime(), /already running/, 'a lock being created right now is respected');
    } finally {
        process.chdir(previous);
    }
}

export async function checkAccessRules(directory: string): Promise<void> {
    checkThreads();
    checkEmbedTotal();
    await checkRuntimeLock(directory);
}
