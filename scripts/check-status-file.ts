import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { StatusWriter, statusFile } from '../src/operator/status-file.js';
import { liveSetupStatus, waitForLiveStatus } from '../src/operator/setup-model.js';

const status = (appliedConfigAt: string) => ({ operator: { appliedConfigAt }, events: { subscriptions: 0 } });

export async function checkStatusFile(directory: string): Promise<void> {
    const previous = process.cwd();
    process.chdir(directory);
    try {
        await mkdir('.data', { recursive: true });
        let reads = 0;
        let current = status('one');
        const writer = new StatusWriter(() => {
            reads++;
            return current;
        });
        writer.touch();
        writer.touch();
        writer.touch();
        await new Promise((resolve) => setImmediate(resolve));
        await writer.flushed();
        assert.equal(reads, 1, 'several changes in one tick are written once');
        assert.deepEqual(JSON.parse(await readFile(statusFile, 'utf8')), status('one'));
        assert.equal(await liveSetupStatus(), null, 'no status is reported without a running Discordinator');
        await writeFile('.data/runtime.lock', String(process.pid));
        assert.deepEqual(await liveSetupStatus(), status('one'));
        const applied = waitForLiveStatus((live) => live.operator.appliedConfigAt === 'two', 5000);
        current = status('two');
        writer.touch();
        assert.equal(await applied, true, 'waiting readers wake when the status file changes');
        assert.equal(await waitForLiveStatus((live) => live.operator.appliedConfigAt === 'three', 100), false);
    } finally {
        process.chdir(previous);
    }
}
