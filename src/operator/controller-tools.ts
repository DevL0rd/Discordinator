import { z } from 'zod';
import type { ConversationController } from './controller.js';
import type { ControllerStore } from './controller-state.js';
import type { ProviderTool } from './provider-adapter.js';

export function controllerTools(controller: ConversationController, store: ControllerStore): ProviderTool[] {
    const owner = (sessionId: string) => {
        const conversation = store.snapshot().conversations.find((item) => item.sessionId === sessionId);
        if (!conversation) throw new Error('Only a verified conversational controller can dispatch work');
        return conversation;
    };
    const assertTask = (sessionId: string, id: string) => {
        if (controller.getTaskStatus(id).conversationKey !== owner(sessionId).key) throw new Error('Task belongs to another conversation');
    };
    const tool = ownedTool(owner);
    return [
        tool(
            'start_task',
            'Start an independent worker for this conversation. Keep the controller responsive for follow-up chat.',
            { prompt: z.string().min(1).max(32000) },
            async (args, sessionId) => ({ taskId: await controller.startTask(owner(sessionId).key, args.prompt) }),
        ),
        tool('get_task_status', 'Read a task owned by this conversation.', { taskId: z.uuid() }, (args, sessionId) => {
            assertTask(sessionId, args.taskId);
            return Promise.resolve(controller.getTaskStatus(args.taskId));
        }),
        tool(
            'steer_task',
            'Send a correction to an active task owned by this conversation.',
            { taskId: z.uuid(), text: z.string().min(1).max(8000) },
            async (args, sessionId) => {
                assertTask(sessionId, args.taskId);
                await controller.steerTask(args.taskId, args.text);
                return { steered: true };
            },
        ),
        tool(
            'cancel_task',
            'Cancel only the selected task; keep the conversational controller and other tasks alive.',
            { taskId: z.uuid() },
            async (args, sessionId) => {
                assertTask(sessionId, args.taskId);
                await controller.cancelTask(args.taskId);
                return { cancelled: true };
            },
        ),
    ];
}
function ownedTool(owner: (sessionId: string) => unknown) {
    return <S extends z.ZodRawShape>(
        name: string,
        description: string,
        shape: S,
        execute: (args: z.infer<z.ZodObject<S>>, sessionId: string) => Promise<unknown>,
    ): ProviderTool => {
        const schema = z.object(shape).strict();
        return {
            name,
            description,
            inputShape: shape,
            inputSchema: z.toJSONSchema(schema),
            async call(args, sessionId) {
                try {
                    owner(sessionId);
                    return { success: true, text: JSON.stringify(await execute(schema.parse(args), sessionId)) };
                } catch {
                    return { success: false, text: 'Controller tool failed validation or ownership checks; no fallback action was taken.' };
                }
            },
        };
    };
}
