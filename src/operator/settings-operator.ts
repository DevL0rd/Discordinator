import { group } from './settings-types.js';

export const operatorSettings = [
    ...group('operator', 'responders', 'next-request', [
        {
            path: 'mode',
            label: 'Assistant',
            description:
                'The one assistant that answers new Discord messages. Saving switches to it once current work finishes and connects its app if needed.',
            kind: 'choice',
            choices: ['chatgpt-events', 'chatgpt-poll', 'codex-local', 'claude-session', 'manual-mcp'],
            defaultValue: 'chatgpt-poll',
        },
        {
            path: 'enabled',
            label: 'Responder enabled',
            description: 'Activation requires runtime ownership and active-request checks.',
            kind: 'boolean',
            defaultValue: false,
        },
        {
            path: 'workspace',
            label: 'Working directory',
            description: 'Directory used for local CLI execution. Validate filesystem access before applying.',
            kind: 'text',
            sensitive: true,
        },
        {
            path: 'exclusiveLocal',
            label: 'Exclusive local ownership',
            description:
                'Confirm every external polling consumer is stopped before local activation. A configured MCP client is not evidence of listening; no heartbeat is inferred.',
            kind: 'boolean',
            defaultValue: false,
        },
        {
            path: 'timeoutSeconds',
            label: 'Execution time limit',
            description: '0 means no time limit; otherwise 30–1800 seconds.',
            kind: 'integer',
            minimum: 0,
            maximum: 1800,
            defaultValue: 0,
        },
    ]),
    ...group('operator', 'models', 'next-request', [
        {
            path: 'codexModel',
            label: 'Codex model',
            description: 'Models offered by your Codex account. Default uses Codex’s own choice.',
            kind: 'text',
        },
        {
            path: 'codexEffort',
            label: 'Codex reasoning',
            description: 'Reasoning levels the selected Codex model offers. Default uses the model’s own setting.',
            kind: 'text',
        },
        {
            path: 'claudeModel',
            label: 'Claude model',
            description:
                'Models your installed Claude Code offers, read live. Applies when the Discordinator conversation is created; change it in Claude for an existing one.',
            kind: 'text',
        },
        {
            path: 'claudeEffort',
            label: 'Claude thinking effort',
            description: 'Thinking effort levels the selected Claude model offers. Default uses Claude’s own setting.',
            kind: 'text',
        },
    ]),
    ...group('operator', 'responders', 'next-request', [
        {
            path: 'instructions',
            label: 'Extra instructions',
            description: 'Additional local-runner instructions, maximum 8000 characters. Does not override Discord safeguards.',
            kind: 'text',
        },
        {
            path: 'progressSeconds',
            label: 'Progress interval',
            description: 'Local acknowledgment immediately; progress every 15–600 seconds while work continues.',
            kind: 'integer',
            minimum: 15,
            maximum: 600,
            defaultValue: 60,
        },
        {
            path: 'backgroundOnly',
            label: 'Always run in the background',
            description: 'Use the command-line app in the background even when the desktop app is installed.',
            kind: 'boolean',
            defaultValue: false,
        },
        {
            path: 'activityVisibility',
            label: 'Show tool activity in Discord',
            description:
                'Optional redacted tool activity, off by default. Genuine harness approvals and questions are always relayed independently.',
            kind: 'boolean',
            defaultValue: false,
        },
    ]),
    ...group('operator', 'connections', 'reference', [
        {
            path: 'publicEndpoint',
            label: 'MCP endpoint URL',
            description: 'Full URL including https:// and path, for apps that connect to a custom endpoint.',
            kind: 'text',
        },
    ]),
];
