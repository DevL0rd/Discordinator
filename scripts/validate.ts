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

await mkdir('.data', { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join('.data', 'validation-'));
try {
  await checkPolicy(directory);
  await checkBridge(directory);
  await checkHttp(directory);
  await checkAuth();
  await checkContext(directory);
  await checkEvents(directory);
  await checkCancellation(directory);
  console.log(`Local validation passed: policy/triggers, Gateway mocks, approvals, idempotency, queue and authenticated MCP (${operations.length + 9} tools), bounded context and MCP Events lifecycle. No Discord connection.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
