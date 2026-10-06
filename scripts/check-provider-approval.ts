import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DiscordApprovalDispatcher } from '../src/operator/approval-dispatcher.js';
import { providerQuestion } from '../src/operator/provider-question.js';
import { providerElicitation } from '../src/operator/provider-elicitation.js';
import { fixture, ids } from './fixtures.js';
import type { ApprovalDecision } from '../src/operator/provider-adapter.js';

export async function checkProviderApproval(directory: string): Promise<void> {
    const form = providerElicitation(
        { type: 'object', properties: { count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' } }, required: ['count'] },
        'form',
    );
    assert.deepEqual(form.answer({ form_0: '2', form_1: 'true' }), { count: 2, enabled: true });
    assert.throws(() => form.answer({ form_0: '0', form_1: 'true' }));
    assert.throws(() => providerElicitation({ type: 'object', properties: { password: { type: 'string' } } }, 'secret'));
    const question = providerQuestion(
        { questions: [{ id: 'q1', question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }] }] },
        'nonce',
    );
    assert.equal(question.prompt.mode, 'buttons');
    assert.deepEqual(question.answer('nonce_1', undefined), { q1: ['B'] });
    assert.throws(() => question.answer('nonce_20', undefined));
    assert.throws(() => providerQuestion({ questions: [{ question: 'Secret', isSecret: true }] }, 'nonce'));
    const claude = providerQuestion({ input: { questions: [{ question: 'Name?', header: 'Name' }] } }, 'n');
    assert.deepEqual(claude.answer(undefined, { n_0: 'Answer' }), { 'Name?': ['Answer'] });
    const f = fixture(join(directory, 'provider-approval.json'));
    f.policy.config.scopes.push('interactions.write');
    const decisions: ApprovalDecision[] = [];
    const dispatcher = new DiscordApprovalDispatcher(f.bridge, (_key, decision, origin) => {
        assert.equal(origin, f.event.id);
        decisions.push(decision);
        return Promise.resolve();
    });
    await dispatcher.request(
        { key: 'rpc-1', epoch: 'epoch', sessionId: 'session', turnId: 'turn', kind: 'command', title: 'Run test command', payload: {} },
        f.event.id,
    );
    const sent = (f.api.calls.at(-1)!.body as { body: { components: { components: { custom_id: string }[] }[] } }).body;
    const accepted = f.bridge.flows.accept({
        customId: sent.components[0]!.components[0]!.custom_id,
        actorId: ids.user,
        applicationId: ids.bot,
        channelId: ids.channel,
        guildId: ids.guild,
        messageId: ids.message,
        messageAuthorId: ids.bot,
        modal: false,
        componentType: 2,
    });
    const child = {
        ...f.event,
        id: 'child',
        kind: 'interaction' as const,
        name: 'discordinator.control',
        sourceEventId: f.event.id,
        text: accepted.text!,
    };
    assert.equal(await dispatcher.accept({ ...child, actorId: ids.denied }), true, 'foreign answers are consumed, never ingested as chat');
    assert.equal(decisions.length, 0);
    assert.equal(await dispatcher.accept(child), true);
    assert.deepEqual(decisions, [{ action: 'allow-once' }]);
    assert.equal(await dispatcher.accept(child), true, 'a stale click is answered, never ingested as a new turn');
    assert.equal(decisions.length, 1);
    assert.equal(await dispatcher.accept({ ...child, text: JSON.stringify({ choice: 'unrelated_choice' }) }), false);
    dispatcher.invalidateAll();
}
