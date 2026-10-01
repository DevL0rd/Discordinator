import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { checkPolicy } from './check-policy.js';
import { checkBridge } from './check-bridge.js';
import { checkHttp } from './check-http.js';
import { operations } from '../src/discord/catalog.js';
import { checkContext } from './check-context.js';
import { checkEvents, checkCancellation } from './check-events.js';
import { checkAuth } from './check-auth.js';
import { checkMedia } from './check-media.js';
import { checkControls } from './check-controls.js';
import { checkTunnel } from './check-tunnel.js';

await mkdir('.data', { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join('.data', 'validation-'));
try {
    await checkHttp(directory);
    await checkAuth();
    await checkTunnel(directory);
    if (process.argv.includes('--connection')) {
        console.log(
            'Connection validation passed: bearer HTTP, offline OAuth JWTs and loopback-only tunnel mode. No external connections.',
        );
    } else {
        await checkPolicy(directory);
        await checkBridge(directory);
        await checkContext(directory);
        await checkEvents(directory);
        await checkCancellation(directory);
        await checkMedia(directory);
        await checkControls(directory);
        console.log(
            `Local validation passed: policy/triggers, Gateway mocks, approvals, idempotency, queue and bearer/OAuth/local-tunnel MCP (${operations.length + 17} tools), context, MCP Events, safe media/retrieval and correlated controls. No Discord connection.`,
        );
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
