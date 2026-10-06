import { uniqueMembers } from '../servers.js';
import { settingValue, type SettingDefinition } from '../settings-registry.js';
import type { UiState } from './state.js';

export interface Picker {
    field: SettingDefinition;
    labels: Record<string, string>;
    chosen: string[];
}

const sources: Record<string, (state: UiState) => { id: string; name: string }[]> = {
    'policy.allowedUserIds': (state) => uniqueMembers(state.extras.servers?.servers ?? []),
    'policy.allowedRoleIds': (state) =>
        (state.extras.servers?.servers ?? []).flatMap((server) =>
            server.roles.map((role) => ({ id: role.id, name: `@${role.name} · ${server.name}` })),
        ),
};

export function pickerFor(field: SettingDefinition, state: UiState): Picker | undefined {
    const source = sources[field.id];
    if (!source || !state.extras.servers) return undefined;
    const known = source(state);
    const chosen = (settingValue(state.drafts[field.source], field) as string[] | undefined) ?? [];
    const labels = Object.fromEntries(known.map((item) => [item.id, item.name]));
    for (const id of chosen) labels[id] ??= `Not in your servers (${id})`;
    return { field: { ...field, choices: [...new Set([...known.map((item) => item.id), ...chosen])] }, labels, chosen: [...chosen] };
}
