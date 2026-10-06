import assert from 'node:assert/strict';
import { policySchema } from '../src/core/config.js';
import { editSetting, fieldError, previewChanges, searchSettings, settings, settingValue } from '../src/operator/settings-registry.js';

const field = (id: string) => {
    const definition = settings.find((item) => item.id === id);
    assert.ok(definition, `Missing setting ${id}`);
    return definition;
};
assert.equal(new Set(settings.map((item) => item.id)).size, settings.length, 'Stable IDs are unique');
const defaults = policySchema.parse({});
for (const definition of settings.filter((item) => item.source === 'policy')) {
    assert.deepEqual(
        settingValue(defaults, definition),
        definition.defaultValue,
        `${definition.id} matches the real policy schema default`,
    );
}
assert.equal(searchSettings('messages per channel')[0]?.id, 'policy.context.perChannel');
assert.equal(searchSettings('does-not-exist').length, 0);
assert.equal(searchSettings('   ').length, settings.length);
const contextLimit = field('policy.context.perChannel');
assert.ok(fieldError(contextLimit, 101));
assert.ok(fieldError(contextLimit, 1.5));
assert.equal(fieldError(contextLimit, 80), undefined);
const changed = editSetting(defaults, contextLimit, 80);
assert.equal(defaults.context.perChannel, 50, 'Editing preserves the original document');
assert.equal((changed.context as Record<string, unknown>).perChannel, 80);
assert.equal(policySchema.parse(changed).context.perChannel, 80, 'The result passes the authoritative schema');
assert.throws(() => editSetting(defaults, field('policy.servers.mode'), 'anything'));
assert.throws(() => editSetting({}, field('environment.DISCORDINATOR_BIND_HOST'), '0.0.0.0'));
const malicious = { ...contextLimit, path: '__proto__.polluted' };
assert.throws(() => editSetting({}, malicious, 100));
assert.equal(({} as Record<string, unknown>).polluted, undefined);
const missingDefault = settingValue({}, field('policy.allowedUserIds')) as string[];
missingDefault.push('12345678901234567');
assert.deepEqual(settingValue({}, field('policy.allowedUserIds')), [], 'Default arrays do not leak across drafts');
assert.ok(fieldError(field('policy.scopes'), ['not-a-scope']));
const preview = previewChanges('policy', defaults, changed);
assert.equal(preview.length, 1);
assert.equal(preview[0]?.apply, 'restart');
assert.equal(preview[0]?.before, '500');
const secretPreview = previewChanges('environment', { DISCORD_BOT_TOKEN: 'old-secret' }, { DISCORD_BOT_TOKEN: 'new-secret' });
assert.equal(secretPreview.length, 1);
assert.equal(secretPreview[0]?.before, '[redacted]');
assert.equal(secretPreview[0]?.after, '[redacted]');
assert.ok(!JSON.stringify(secretPreview).includes('secret'));
assert.deepEqual(previewChanges('policy', {}, defaults), [], 'Omitted values resolve to real defaults without fake diffs');
console.log(
    `Settings registry: ${settings.length} existing settings verified; defaults, edits, search, redaction, immutable drafts, and path guards pass.`,
);
