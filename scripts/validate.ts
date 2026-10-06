import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { checkPolicy } from './check-policy.js';
import { checkBridge } from './check-bridge.js';
import { checkHttp } from './check-http.js';
import { checkHttpBudgets } from './check-http-budgets.js';
import { operations } from '../src/discord/catalog.js';
import { checkContext, checkHistory } from './check-context.js';
import { checkEvents, checkCancellation } from './check-events.js';
import { checkEventsPump } from './check-events-pump.js';
import { checkAuth } from './check-auth.js';
import { checkMedia } from './check-media.js';
import { checkMediaLimits } from './check-media-limits.js';
import { checkControls } from './check-controls.js';
import { checkConnection } from './check-connection.js';
import { checkOAuth } from './check-oauth.js';
import { checkOperator } from './check-operator.js';
import { checkReplyOrigins } from './check-reply-origins.js';
import { checkProactive } from './check-proactive.js';
import { checkEnvironmentRestart, checkPeople } from './check-people.js';
import { checkPanel } from './check-panel.js';
import { checkController } from './check-controller.js';
import { checkProviderApproval } from './check-provider-approval.js';
import { checkCodexAdapter } from './check-codex-adapter.js';
import { checkClaudeAdapter } from './check-claude-adapter.js';
import { checkInteractionEvents } from './check-interaction-events.js';
import { checkOwnerContext } from './check-owner-context.js';
import { checkEnvironmentRename, checkOnboarding } from './check-onboarding.js';
import { checkBridgeProcess, checkChannel } from './check-channel.js';
import { checkApps } from './check-apps.js';
import { checkSlashCommands } from './check-commands.js';
import { checkSessionActivity, checkSessions } from './check-sessions.js';
import { checkCodexDaemon } from './check-codex-daemon.js';
import { checkUi } from './check-ui.js';
import { checkWindows } from './check-windows.js';

await mkdir('.data', { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join('.data', 'validation-'));
try {
    await checkOAuth(directory);
    if (process.argv.includes('--oauth')) process.exitCode = 0;
    else {
        await checkHttp(directory);
        await checkHttpBudgets(directory);
        await checkAuth();
        await checkConnection(directory);
        if (process.argv.includes('--connection')) {
            console.log(
                'Connection validation passed: bearer HTTP, offline OAuth JWTs and hosting-independent configuration. No external connections.',
            );
        } else {
            await checkPolicy(directory);
            await checkBridge(directory);
            await checkContext(directory);
            await checkHistory(directory);
            await checkEvents(directory);
            await checkCancellation(directory);
            await checkEventsPump(directory);
            await checkMedia(directory);
            await checkMediaLimits(directory);
            await checkControls(directory);
            await checkOperator();
            await checkReplyOrigins(directory);
            await checkProactive(directory);
            await checkPeople(directory);
            await checkEnvironmentRestart(directory);
            await checkPanel();
            await checkOnboarding();
            await checkEnvironmentRename(directory);
            await checkChannel(directory);
            await checkBridgeProcess(directory);
            await checkApps();
            await checkSlashCommands();
            await checkSessions();
            await checkSessionActivity(directory);
            await checkCodexDaemon();
            await checkWindows(directory);
            checkUi();
            await checkController(directory);
            await checkProviderApproval(directory);
            await checkCodexAdapter();
            await checkClaudeAdapter();
            await checkInteractionEvents(directory);
            await checkOwnerContext(directory);
            console.log(
                `Local validation passed: policy/triggers, Gateway mocks, approvals, idempotency, queue and bearer/OAuth MCP (${operations.length + 22} tools), context, MCP Events, safe media/retrieval and correlated controls. No Discord connection.`,
            );
        }
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
