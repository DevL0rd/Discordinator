import { z } from 'zod';
import { snowflake } from '../core/config.js';
import { define, guild, shortName, sensitive } from './operations.js';

const rule = { ...guild, ruleId: snowflake };
export const automodOperations = [
    define('automod_rules_list', 'Read guild AutoMod rules.', { scope: 'automod.read', target: 'guild' }, guild, (a, c) =>
        c.api.get(`/guilds/${a.guildId}/auto-moderation/rules`),
    ),
    define(
        'automod_keyword_create',
        'Create an enabled keyword-block AutoMod rule, with confirmation.',
        { scope: 'automod.write', target: 'guild' },
        {
            ...guild,
            name: shortName,
            keywords: z.array(z.string().min(1).max(60)).min(1).max(100),
            exemptRoles: z.array(snowflake).max(20).default([]),
            exemptChannels: z.array(snowflake).max(50).default([]),
        },
        async (a, c) => {
            for (const id of a.exemptChannels) {
                const destination = await c.api.channel(id);
                if (destination.guild_id !== a.guildId) throw new Error('Exemption channel is in another guild');
            }
            return c.api.post(`/guilds/${a.guildId}/auto-moderation/rules`, {
                name: a.name,
                event_type: 1,
                trigger_type: 1,
                trigger_metadata: { keyword_filter: a.keywords },
                actions: [{ type: 1 }],
                enabled: true,
                exempt_roles: a.exemptRoles,
                exempt_channels: a.exemptChannels,
            });
        },
        sensitive,
    ),
    define(
        'automod_rule_toggle',
        'Enable or disable an AutoMod rule, with confirmation.',
        { scope: 'automod.write', target: 'guild' },
        { ...rule, enabled: z.boolean() },
        (a, c) => c.api.patch(`/guilds/${a.guildId}/auto-moderation/rules/${a.ruleId}`, { enabled: a.enabled }),
        sensitive,
    ),
    define(
        'automod_rule_delete',
        'Delete an AutoMod rule, with confirmation.',
        { scope: 'automod.write', target: 'guild' },
        rule,
        (a, c) => c.api.delete(`/guilds/${a.guildId}/auto-moderation/rules/${a.ruleId}`),
        sensitive,
    ),
];
