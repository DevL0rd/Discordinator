import type { ProviderApproval } from './provider-adapter.js';
import { fence } from './activity-format.js';

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields => (value && typeof value === 'object' ? (value as Fields) : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : Array.isArray(value) ? value.map(String).join(' ') : '');

function command(payload: Fields): string {
    const input = record(payload.input);
    return text(payload.command) || (payload.toolName === 'Bash' ? text(input.command) : '');
}

function files(payload: Fields): string[] {
    const input = record(payload.input);
    const changes = Array.isArray(payload.changes) ? payload.changes.map((change) => text(record(change).path)) : [];
    return [...changes, text(input.file_path), text(input.notebook_path)].filter(Boolean).slice(0, 10);
}

export function approvalText(request: ProviderApproval, detail: string): string {
    const payload = record(request.payload);
    const run = command(payload);
    const paths = files(payload);
    const body = run ? fence(run) : paths.length ? paths.map((path) => `\`${path}\``).join('\n') : detail === request.title ? '' : detail;
    return [
        `**${request.title.slice(0, 300)}**`,
        body,
        '-# Allow once applies only to this action. Deny skips it. Cancel stops the whole task.',
    ]
        .filter(Boolean)
        .join('\n');
}
