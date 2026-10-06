import { createHash, randomBytes } from 'node:crypto';
import { approvalText } from './approval-card.js';
import type { Bridge } from '../core/bridge.js';
import type { BotEvent } from '../core/queue.js';
import type { ApprovalDecision, ProviderApproval } from './provider-adapter.js';
import { providerQuestion } from './provider-question.js';
import { providerElicitation } from './provider-elicitation.js';

interface Pending {
    request: ProviderApproval;
    origin: BotEvent;
    nonce: string;
    hash: string;
    consumed: boolean;
    question?: ReturnType<typeof providerQuestion>;
    form?: ReturnType<typeof providerElicitation>;
}
export class DiscordApprovalDispatcher {
    private pending = new Map<string, Pending>();
    constructor(
        readonly bridge: Bridge,
        readonly resolve: (key: string, decision: ApprovalDecision, originEventId: string) => Promise<void>,
    ) {}
    invalidate(key: string): void {
        this.pending.delete(key);
    }
    invalidateAll(): void {
        this.pending.clear();
    }
    async request(request: ProviderApproval, originEventId: string): Promise<void> {
        const origin = this.bridge.flows.authorize(originEventId).event;
        if (origin.kind === 'owner') throw new Error('Harness approval requires an active conversational provider origin');
        if (request.secret) throw new Error('Secret provider input requires a secure local handoff, not a public Discord form');
        const nonce = this.pending.get(request.key)?.nonce ?? randomBytes(8).toString('hex');
        const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
        const pending: Pending = { request: structuredClone(request), origin, nonce, hash, consumed: false };
        if (request.kind === 'question') pending.question = providerQuestion(request.payload, nonce);
        if (request.kind === 'elicitation') {
            if (!request.schema) throw new Error('URL or unsupported elicitation needs a secure provider handoff');
            pending.form = providerElicitation(request.schema, nonce);
        }
        const detail = requestDetail(request);
        this.pending.set(request.key, pending);
        await this.bridge.prompt({
            ...pendingPrompt(pending, detail),
            eventId: originEventId,
            idempotencyKey: `provider-approval-${hash}`,
        });
    }
    async accept(event: BotEvent): Promise<boolean> {
        const answer = controlAnswer(event);
        if (!answer) return false;
        const { identifier, choice, fields } = answer;
        const pending = [...this.pending.values()].find((item) => identifier.startsWith(`${item.nonce}_`));
        if (!pending) return false;
        try {
            assertPendingOrigin(pending, event);
            this.bridge.policy.assertOrigin(event);
        } catch {
            return true;
        }
        try {
            await this.settle(pending, pendingDecision(pending, identifier, choice, fields));
        } catch (error) {
            await this.bridge
                .respond({
                    eventId: event.id,
                    content: `That answer could not be used (${error instanceof Error ? error.message : 'invalid answer'}). The request is still waiting; please answer it again.`,
                    idempotencyKey: `provider-approval-invalid-${event.id}`,
                })
                .catch(() => undefined);
        }
        return true;
    }
    private async settle(pending: Pending, decision: ApprovalDecision): Promise<void> {
        pending.consumed = true;
        this.pending.delete(pending.request.key);
        try {
            await this.resolve(pending.request.key, decision, pending.origin.id);
        } catch (error) {
            pending.consumed = false;
            this.pending.set(pending.request.key, pending);
            throw error;
        }
    }
}
function controlAnswer(event: BotEvent): { identifier: string; choice: unknown; fields?: Record<string, string> } | undefined {
    if (
        event.kind !== 'interaction' ||
        !['discordinator.control', 'discordinator.modal'].includes(event.name ?? '') ||
        !event.sourceEventId
    )
        return;
    try {
        const parsed = JSON.parse(event.text) as { choice?: unknown; fields?: Record<string, string> };
        const identifier = typeof parsed.choice === 'string' ? parsed.choice : parsed.fields ? Object.keys(parsed.fields)[0] : undefined;
        return identifier ? { identifier, choice: parsed.choice, ...(parsed.fields ? { fields: parsed.fields } : {}) } : undefined;
    } catch {
        return undefined;
    }
}
function pendingPrompt(pending: Pending, detail: string) {
    const { request, nonce } = pending;
    return (
        pending.question?.prompt ??
        pending.form?.prompt ?? {
            content: approvalText(request, detail),
            mode: 'buttons' as const,
            title: '⚠️ Approval needed',
            tone: 'warning' as const,
            fields: [],
            options: [
                { key: `${nonce}_allow`, label: 'Allow once', style: 'success' as const },
                { key: `${nonce}_deny`, label: 'Deny', style: 'danger' as const },
                { key: `${nonce}_cancel`, label: 'Cancel task', style: 'secondary' as const },
            ],
        }
    );
}
function requestDetail(request: ProviderApproval): string {
    if (request.kind !== 'permissions') return request.title.slice(0, 1400);
    const permissions = (request.payload as { permissions?: unknown })?.permissions;
    if (!permissions || typeof permissions !== 'object') throw new Error('Permission request has no exact bounded payload');
    const text = JSON.stringify(permissions);
    if (text.length > 1200 || /password|secret|token|credential/i.test(text))
        throw new Error('Permission details require secure provider handoff');
    return `Requested turn-scoped permissions: ${text}. Approval grants only this exact requested subset for this turn.`;
}
function assertPendingOrigin(pending: Pending, event: BotEvent): void {
    if (
        pending.consumed ||
        pending.origin.id !== event.sourceEventId ||
        pending.origin.actorId !== event.actorId ||
        pending.origin.channelId !== event.channelId ||
        pending.origin.guildId !== event.guildId
    )
        throw new Error('Provider approval control origin mismatch');
}
function pendingDecision(pending: Pending, identifier: string, choice: unknown, fields?: Record<string, string>): ApprovalDecision {
    if (pending.form) return { action: 'allow-once', content: pending.form.answer(fields) };
    if (pending.question)
        return { action: 'allow-once', answers: pending.question.answer(typeof choice === 'string' ? choice : undefined, fields) };
    const action = identifier.slice(pending.nonce.length + 1);
    if (action === 'allow')
        return {
            action: 'allow-once',
            ...(pending.request.kind === 'permissions'
                ? { permissions: (pending.request.payload as { permissions: unknown }).permissions }
                : {}),
        };
    if (action === 'deny' || action === 'cancel') return { action };
    throw new Error('Unknown approval decision');
}
