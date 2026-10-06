import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BotEvent } from '../src/core/queue.js';
import { defaultOperatorConfig } from '../src/operator/config.js';
import { ConversationController } from '../src/operator/controller.js';
import { ControllerStore, conversationKey } from '../src/operator/controller-state.js';
import type { ApprovalDecision, ProviderAdapter, ProviderHooks } from '../src/operator/provider-adapter.js';

class FakeProvider implements ProviderAdapter {
    hooks!: ProviderHooks;
    sessions: string[] = [];
    resumed: string[] = [];
    turns: { sessionId: string; text: string; turnId: string }[] = [];
    decisions: { key: string; decision: ApprovalDecision }[] = [];
    interrupted: string[] = [];
    async connect(_config: unknown, hooks: ProviderHooks) {
        this.hooks = hooks;
        await hooks.onEvent({ type: 'connected', epoch: 'test-epoch' });
    }
    openSession(input: { sessionId?: string }) {
        if (input.sessionId) {
            this.resumed.push(input.sessionId);
            return Promise.resolve({ id: input.sessionId });
        }
        const id = `session-${this.sessions.length + 1}`;
        this.sessions.push(id);
        return Promise.resolve({ id });
    }
    startTurn(sessionId: string, input: { text: string }) {
        const turnId = `turn-${this.turns.length + 1}`;
        this.turns.push({ sessionId, text: input.text, turnId });
        return Promise.resolve({ turnId });
    }
    async steer() {}
    interrupt(_sessionId: string, turnId: string) {
        this.interrupted.push(turnId);
        return Promise.resolve();
    }
    resolveApproval(key: string, decision: ApprovalDecision) {
        this.decisions.push({ key, decision });
        return Promise.resolve();
    }
    async close() {}
}
const controllerEvent = (id: string, text = 'request'): BotEvent => ({
    id,
    text,
    actorId: 'owner',
    channelId: 'tank',
    guildId: 'guild',
    kind: 'message',
    cursor: 1,
    receivedAt: new Date().toISOString(),
});
async function settle(predicate: () => boolean) {
    for (let index = 0; index < 100; index++) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(predicate(), 'Controller did not settle');
}
async function checkLifecycle(directory: string): Promise<void> {
    const event = controllerEvent;
    const store = new ControllerStore(join(directory, 'controller.json'));
    const adapter = new FakeProvider();
    const deliveries: { id: string; key: string; content: string }[] = [];
    const prompts: string[] = [];
    const controller = new ConversationController(
        adapter,
        defaultOperatorConfig(),
        store,
        (id, content, key) => {
            deliveries.push({ id, key, content });
            return Promise.resolve();
        },
        (_request, origin) => {
            prompts.push(origin);
            return Promise.resolve();
        },
    );
    await controller.start();
    assert.equal(await controller.ingest(event('first')), true);
    assert.equal(await controller.ingest(event('first')), false);
    await settle(() => adapter.turns.length === 1);
    const tools = adapter.hooks.tools!;
    assert.equal(tools.length, 4);
    assert.equal((await tools[0]!.call({ prompt: 'Denied recursive worker' }, 'worker-session')).success, false);
    await controller.ingest(event('second', 'follow-up while busy'));
    assert.equal(adapter.turns.length, 1);
    assert.equal(controller.status().queued, 1);
    const taskId = await controller.startTask(conversationKey(event('first')), 'independent worker');
    await settle(() => adapter.turns.length === 2);
    await settle(() => Boolean(controller.getTaskStatus(taskId).turnId));
    assert.equal(adapter.sessions.length, 2);
    assert.equal((await tools[1]!.call({ taskId }, 'session-1')).success, true);
    assert.equal((await tools[1]!.call({ taskId }, 'unrelated-session')).success, false);
    assert.equal(controller.getTaskStatus(taskId).state, 'running');
    await checkApproval(controller, adapter, prompts);
    await adapter.hooks.onEvent({ type: 'progress', sessionId: 'session-1', turnId: 'turn-1', text: 'optional activity', activity: true });
    assert.ok(!deliveries.some((item) => item.content === 'optional activity'));
    await controller.cancelTask(taskId);
    assert.equal(adapter.interrupted.length, 1);
    assert.equal(controller.getTaskStatus(taskId).state, 'cancelled');
    await adapter.hooks.onEvent({ type: 'final', sessionId: 'session-1', turnId: 'turn-1', text: 'complete' });
    await settle(() => adapter.turns.length === 3);
    assert.equal(adapter.turns[2]!.sessionId, 'session-1');
    assert.equal(adapter.sessions.length, 2);
    await checkRecovery(controller, store);
}
async function checkApproval(controller: ConversationController, adapter: FakeProvider, prompts: string[]): Promise<void> {
    await adapter.hooks.onEvent({
        type: 'approval.requested',
        request: {
            key: 'approval-1',
            epoch: 'test-epoch',
            sessionId: 'session-1',
            turnId: 'turn-1',
            kind: 'command',
            title: 'Run command',
            payload: {},
        },
    });
    assert.deepEqual(prompts, ['first']);
    await assert.rejects(controller.resolveApproval('approval-1', { action: 'allow-once' }, 'second'));
    await controller.resolveApproval('approval-1', { action: 'deny' }, 'first');
    assert.equal(adapter.decisions[0]!.decision.action, 'deny');
    await assert.rejects(controller.resolveApproval('approval-1', { action: 'allow-once' }, 'first'));
}
async function checkResumeAfterRestart(directory: string): Promise<void> {
    const file = join(directory, 'resume.json');
    const first = new FakeProvider();
    const sent: string[] = [];
    const deliver = (_id: string, content: string) => {
        sent.push(content);
        return Promise.resolve();
    };
    const before = new ConversationController(first, defaultOperatorConfig(), new ControllerStore(file), deliver, async () => {});
    await before.start();
    await before.ingest(controllerEvent('resume-1'));
    await settle(() => first.turns.length === 1 && before.status().busy === 1);
    await first.hooks.onEvent({ type: 'final', sessionId: 'session-1', turnId: 'turn-1', text: 'done' });
    await settle(() => before.status().busy === 0 && sent.length === 1);
    await before.stop();
    const second = new FakeProvider();
    const after = new ConversationController(second, defaultOperatorConfig(), new ControllerStore(file), deliver, async () => {});
    await after.start();
    await after.ingest(controllerEvent('resume-2'));
    await settle(() => second.turns.length === 1);
    assert.deepEqual(second.resumed, ['session-1'], 'persisted session is resumed on the new provider connection');
    assert.equal(second.turns[0]!.sessionId, 'session-1');
    await after.stop();
}
async function checkOutboxIsolation(directory: string): Promise<void> {
    const provider = new FakeProvider();
    const sent: string[] = [];
    const controller = new ConversationController(
        provider,
        defaultOperatorConfig(),
        new ControllerStore(join(directory, 'outbox.json')),
        (id, content) => {
            if (id === 'gone') return Promise.reject(new Error('Discord message deleted'));
            sent.push(`${id}:${content}`);
            return Promise.resolve();
        },
        async () => {},
    );
    await controller.start();
    await controller.ingest({ ...controllerEvent('gone'), actorId: 'other' });
    await controller.ingest(controllerEvent('alive'));
    await settle(() => provider.turns.length === 2);
    for (const turn of provider.turns)
        await provider.hooks.onEvent({ type: 'final', sessionId: turn.sessionId, turnId: turn.turnId, text: 'done' });
    await settle(() => sent.some((item) => item.startsWith('alive:')));
    assert.ok(
        sent.some((item) => item.startsWith('alive:')),
        'a failing reply does not block other conversations',
    );
    assert.equal(controller.status().pendingDelivery, 1);
    await controller.stop();
}
async function checkRecovery(controller: ConversationController, store: ControllerStore): Promise<void> {
    const generation = store.snapshot().generation;
    await controller.stop();
    const recovered = new ControllerStore(store.file);
    await recovered.load();
    await recovered.acquire();
    assert.equal(recovered.snapshot().conversations[0]!.state, 'recovering');
    await assert.rejects(
        recovered.update(() => {}, generation),
        /generation/,
    );
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    assert.ok((JSON.parse(await readFile(store.file, 'utf8')) as { seen: string[] }).seen.includes('first'));
}
async function checkHistory(directory: string): Promise<void> {
    const provider = new FakeProvider();
    const controller = new ConversationController(
        provider,
        defaultOperatorConfig(),
        new ControllerStore(join(directory, 'history.json')),
        () => Promise.resolve(),
        async () => {},
        {
            history: (_event, seen) =>
                Promise.resolve({ text: seen.channel ? 'NEW\n' : 'HISTORY\n', key: 'channel', latest: '2026-10-07T00:00:00.000Z' }),
            sharedConversation: 'discordinator',
        },
    );
    await controller.start();
    await controller.ingest(controllerEvent('history-1'));
    await settle(() => provider.turns.length === 1);
    assert.match(provider.turns[0]!.text, /^HISTORY\n/, 'a new conversation receives the recent channel history');
    await provider.hooks.onEvent({
        type: 'final',
        sessionId: provider.turns[0]!.sessionId,
        turnId: provider.turns[0]!.turnId,
        text: 'done',
    });
    await settle(() => controller.status().busy === 0);
    await controller.ingest(controllerEvent('history-2'));
    await settle(() => provider.turns.length === 2);
    assert.match(provider.turns[1]!.text, /^NEW\n/, 'later messages receive only what is new since the last update');
    await controller.stop();
}
export async function checkController(directory: string): Promise<void> {
    await checkHistory(directory);
    await checkLifecycle(directory);
    await checkResumeAfterRestart(directory);
    await checkOutboxIsolation(directory);
}
if (process.argv[1]?.endsWith('check-controller.ts')) {
    const directory = await mkdtemp(join(tmpdir(), 'discordinator-controller-test-'));
    try {
        await checkController(directory);
        console.log('Controller lifecycle mock regressions passed');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
