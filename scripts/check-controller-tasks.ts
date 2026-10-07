import assert from 'node:assert/strict';
import { join } from 'node:path';
import { defaultOperatorConfig } from '../src/operator/config.js';
import { ConversationController } from '../src/operator/controller.js';
import { ControllerStore, conversationKey } from '../src/operator/controller-state.js';
import { desktopGuide, roleInstructions, workerBrief } from '../src/operator/manager-guide.js';
import { controllerEvent, FakeProvider, settle } from './check-controller.js';

type Tasks = { tasks: { id: string; title: string; state: string; progress?: string; result?: string }[] };

function checkGuides(): void {
    assert.match(
        roleInstructions('controller', 'Owner note.'),
        /manager of the work you start[\s\S]*start_task[\s\S]*list_tasks[\s\S]*Owner note\.$/,
    );
    assert.match(
        roleInstructions('worker', 'Owner note.'),
        /^You are a Discordinator worker[\s\S]*posted to Discord automatically[\s\S]*Owner note\.$/,
    );
    assert.doesNotMatch(roleInstructions('worker', undefined), /start_task/, 'workers are not told to start more workers');
    assert.match(
        desktopGuide,
        /session tools[\s\S]*claude --bg[\s\S]*claude agents --json/,
        'Claude Desktop manages chats with its own tools',
    );
    assert.doesNotMatch(desktopGuide, /assistant_/);
    assert.equal(
        workerBrief('Ship it', 'Do the thing', 'event-1', 'Discord · #dev · from Owner'),
        'Task: Ship it\nRequested in: Discord · #dev · from Owner\nDiscord eventId for this work: "event-1"\n\nDo the thing',
    );
}

export async function checkControllerTasks(directory: string): Promise<void> {
    checkGuides();
    const adapter = new FakeProvider();
    const sent: string[] = [];
    const controller = new ConversationController(
        adapter,
        defaultOperatorConfig(),
        new ControllerStore(join(directory, 'controller-tasks.json')),
        (_id, content) => {
            sent.push(content);
            return Promise.resolve();
        },
        () => Promise.resolve(),
        { brief: (eventId, title, prompt) => `${title} | ${eventId} | ${prompt}` },
    );
    await controller.start();
    await controller.ingest(controllerEvent('first'));
    await settle(() => adapter.turns.length === 1);
    const tool = (name: string) => adapter.hooks.tools!.find((item) => item.name === name)!;
    const call = async (name: string, args: Record<string, unknown>) =>
        JSON.parse((await tool(name).call(args, 'session-1')).text) as unknown;

    const { taskId } = (await call('start_task', { title: 'Build it', prompt: 'Run the build' })) as { taskId: string };
    await settle(() => adapter.turns.length === 2);
    assert.equal(adapter.turns[1]!.text, 'Build it | first | Run the build', 'a worker gets the full brief with who asked');
    const worker = adapter.turns[1]!.sessionId;
    await settle(() => Boolean(controller.tasks.get(taskId).turnId));
    const listed = (await call('list_tasks', {})) as Tasks;
    assert.deepEqual([listed.tasks[0]!.title, listed.tasks[0]!.state], ['Build it', 'running'], 'workers are listed by title');

    await adapter.hooks.onEvent({ type: 'progress', sessionId: worker, turnId: adapter.turns[1]!.turnId, text: 'Halfway there' });
    assert.equal(controller.tasks.get(taskId).progress, 'Halfway there', 'the latest progress is kept for status questions');
    await adapter.hooks.onEvent({ type: 'final', sessionId: worker, turnId: adapter.turns[1]!.turnId, text: 'Built and green' });
    await settle(() => controller.tasks.get(taskId).state === 'completed');
    assert.ok(sent.includes('Built and green'), 'the result is posted to the request');

    assert.equal(await controller.tasks.message(taskId, 'Now run the tests too', 'first'), 'queued');
    await settle(() => adapter.turns.length === 3);
    assert.deepEqual(
        [adapter.turns[2]!.sessionId, adapter.turns[2]!.text],
        [worker, 'Now run the tests too'],
        'follow-up work resumes the same worker',
    );
    assert.ok(adapter.resumed.includes(worker));

    const other = await controller.tasks.start({
        conversationKey: conversationKey(controllerEvent('first')),
        originEventId: 'first',
        title: 'Research',
        prompt: 'Look into it',
    });
    await settle(() => adapter.turns.length === 4);
    assert.deepEqual(
        adapter.keys.filter((key) => key.startsWith('task:')),
        [`task:${taskId}`, `task:${taskId}`, `task:${other}`],
        'every worker has its own session',
    );
    const visible = (await call('list_tasks', {})) as Tasks;
    assert.ok(
        visible.tasks.some((item) => item.id === other),
        'every worker of the conversation is listed',
    );
    await settle(() => Boolean(controller.tasks.get(other).turnId));
    assert.deepEqual(await call('steer_task', { taskId: other, text: 'Focus on X' }), { sent: 'steered' }, 'a running worker is steered');
    await controller.stop();
}
