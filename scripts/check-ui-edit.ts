import assert from 'node:assert/strict';
import { editHint, initialInput, stage } from '../src/operator/ui/edit.js';
import { setting } from '../src/operator/ui/items.js';
import {
    assignSetting,
    editSetting,
    fieldError,
    previewChanges,
    settingValue,
    type SettingDefinition,
} from '../src/operator/settings-registry.js';
import { publicDomain } from '../src/operator/connection-domain.js';
import { snapshot } from './ui-fixtures.js';

const drafts = () => structuredClone(snapshot.documents);
const policyOf = (id: string, input: string | string[]) => stage(drafts(), setting(id), input).policy;

function checkInitialInput(): void {
    const documents = drafts();
    documents.policy.triggers = { ...(documents.policy.triggers as object), names: ['dot', 'bot'] };
    assert.equal(initialInput(setting('environment.DISCORD_BOT_TOKEN'), documents), '', 'credentials start empty');
    assert.equal(initialInput(setting('environment.DISCORDINATOR_RESOURCE_URL'), documents), 'bot.example.com');
    assert.equal(initialInput(setting('policy.triggers.names'), documents), 'dot, bot', 'lists are comma separated');
    assert.equal(initialInput(setting('policy.context.perChannel'), documents), '50', 'numbers are shown as text');
}

function checkHints(): void {
    assert.match(editHint(setting('environment.DISCORDINATOR_RESOURCE_URL')), /Just the domain/);
    assert.match(editHint(setting('environment.DISCORD_BOT_TOKEN')), /hidden as you type/);
    assert.equal(editHint(setting('policy.context.perChannel')), 'A whole number from 1 to 100.');
    const open: SettingDefinition = { ...setting('policy.context.perChannel'), minimum: undefined, maximum: undefined };
    assert.equal(editHint(open), 'A whole number.', 'unbounded numbers do not mention limits');
    assert.equal(editHint(setting('policy.triggers.names')), 'Separate entries with commas.');
    assert.equal(editHint(setting('operator.instructions')), '');
}

function checkParsing(): void {
    assert.deepEqual((policyOf('policy.triggers.names', ' dot , ,bot ').triggers as { names: string[] }).names, ['dot', 'bot']);
    assert.equal((policyOf('policy.context.perChannel', ' 42 ').context as { perChannel: number }).perChannel, 42, 'numbers are trimmed');
    assert.throws(() => policyOf('policy.context.perChannel', '12.5'), /whole number/);
    assert.throws(() => policyOf('policy.context.perChannel', '500'), /Maximum: 100/);
    assert.equal((policyOf('policy.media.enabled', 'true').media as { enabled: boolean }).enabled, true);
    assert.equal((policyOf('policy.media.enabled', 'yes').media as { enabled: boolean }).enabled, false, 'anything else is off');
    assert.deepEqual(policyOf('policy.scopes', ['messages.read']).scopes, ['messages.read'], 'checklists stage their array as is');
}

function checkStaging(): void {
    const token = setting('environment.DISCORD_BOT_TOKEN');
    assert.throws(() => stage(drafts(), token, ''), /Paste a new value/, 'a credential cannot be emptied');
    assert.equal(stage(drafts(), token, 'new-secret').environment.DISCORD_BOT_TOKEN, 'new-secret');
    const cleared = stage(drafts(), setting('environment.DISCORDINATOR_RESOURCE_URL'), '  ');
    assert.deepEqual(
        [cleared.environment.DISCORDINATOR_RESOURCE_URL, cleared.environment.DISCORDINATOR_AUTH_MODE],
        ['', 'bearer'],
        'an empty domain stops the web connectors',
    );
    const withModel = drafts();
    withModel.operator.codexModel = 'fast';
    const reset = stage(withModel, setting('operator.codexModel'), '');
    assert.equal(Object.hasOwn(reset.operator, 'codexModel'), false, 'clearing an optional model goes back to the default');
    const blank = stage(drafts(), setting('operator.workspace'), '');
    assert.equal(blank.operator.workspace, '', 'other text settings keep an empty value');
    const policyBlank = stage(drafts(), setting('policy.triggers.names'), '');
    assert.deepEqual((policyBlank.policy.triggers as { names: string[] }).names, []);
}

function checkValidation(): void {
    const names = setting('policy.triggers.names');
    const scopes = setting('policy.scopes');
    const cases: [SettingDefinition, unknown, string | undefined][] = [
        [setting('environment.DISCORDINATOR_BIND_HOST'), '0.0.0.0', 'This setting is enforced and cannot be edited'],
        [setting('policy.media.enabled'), 'true', 'Choose on or off'],
        [setting('policy.context.perChannel'), 1.5, 'Enter a whole number'],
        [setting('policy.context.perChannel'), 0, 'Minimum: 1'],
        [setting('policy.context.perChannel'), 101, 'Maximum: 100'],
        [setting('operator.instructions'), 3, 'Enter text'],
        [setting('policy.context.reach'), 'world', 'Choose a supported value'],
        [names, 'dot', 'Enter a list'],
        [names, Array.from({ length: 11 }, (_, index) => `n${index}`), 'Maximum entries: 10'],
        [names, ['ok', 3], 'List entries must be text'],
        [scopes, ['not-a-scope'], 'List contains an unsupported value'],
        [scopes, ['messages.read'], undefined],
        [{ ...names, kind: 'unknown' } as unknown as SettingDefinition, 'anything', undefined],
    ];
    for (const [definition, value, expected] of cases)
        assert.equal(fieldError(definition, value), expected, `${definition.id} ${JSON.stringify(value)}`);
    assert.throws(() => editSetting({}, names, 'dot'), /Enter a list/, 'editing refuses invalid values');
}

function checkPaths(): void {
    const field = (path: string): SettingDefinition => ({ ...setting('policy.context.reach'), path });
    assert.throws(() => settingValue({}, field('__proto__.polluted')), /Invalid setting path/);
    assert.throws(() => settingValue({}, field('context..reach')), /Invalid setting path/);
    assert.equal(settingValue({ context: 'flat' }, field('context.reach')), 'channel', 'a non-object parent reads as the default');
    assert.equal(settingValue({}, { ...field('missing'), defaultValue: undefined }), undefined);
    assert.throws(() => assignSetting({ context: 'flat' }, field('context.reach'), 'server'), /parent is not an object/);
    assert.throws(() => assignSetting({ context: [] }, field('context.reach'), 'server'), /parent is not an object/);
    assert.throws(() => assignSetting({ context: null }, field('context.reach'), 'server'), /parent is not an object/);
    assert.deepEqual(assignSetting({}, field('a.b.c'), 1), { a: { b: { c: 1 } } }, 'missing parents are created');
    const original = { context: { reach: 'channel' } };
    assert.deepEqual(assignSetting(original, field('context.reach'), 'server'), { context: { reach: 'server' } });
    assert.equal(original.context.reach, 'channel', 'the original document is untouched');
}

function checkPreview(): void {
    const token = previewChanges('environment', {}, { DISCORD_BOT_TOKEN: 'new' });
    assert.deepEqual(
        token.map((change) => [change.id, change.before, change.after]),
        [['environment.DISCORD_BOT_TOKEN', 'Not configured', '[redacted]']],
        'secrets are never shown',
    );
    const removed = previewChanges('environment', { DISCORDINATOR_RESOURCE_URL: 'https://a.example/mcp' }, {});
    assert.deepEqual([removed[0]?.before, removed[0]?.after], ['"https://a.example/mcp"', 'Not configured']);
    assert.equal(publicDomain('not a url'), 'not a url', 'text that is not a URL is shown as typed');
    assert.equal(publicDomain(undefined), '');
}

export function checkUiEdit(): void {
    checkInitialInput();
    checkHints();
    checkParsing();
    checkStaging();
    checkValidation();
    checkPaths();
    checkPreview();
}
