import { group } from './settings-types.js';

export const voiceSettings = [
    ...group('environment', 'voice', 'live', [
        {
            path: 'GEMINI_API_KEY',
            label: 'Google Gemini API key',
            description:
                'Key from aistudio.google.com/apikey. Voice uses it for the always-on call transcript (Gemini Flash-Lite) and live conversations (Gemini 3.8 Live); nothing else is sent to Google. Saved privately in .env and never shown again; a new key is used right away.',
            credential: true,
            kind: 'text',
            sensitive: true,
        },
    ]),
    ...group('policy', 'voice', 'live', [
        {
            path: 'voice.enabled',
            label: 'Voice calls',
            description:
                'Lets Discordinator join voice calls, transcribe them and talk. Also needs the voice.listen ability (and voice.speak to talk), a Google Gemini key, and Connect/Speak permission in the channel.',
            kind: 'boolean',
            defaultValue: true,
        },
        {
            path: 'voice.autoJoin',
            label: 'Join calls automatically',
            description:
                'Joins a voice channel as soon as an approved person is in it, in servers and channels allowed by the Discord page rules (allowlist or blocklist, whichever you chose there). One call per server; it never follows people out of a call.',
            kind: 'boolean',
            defaultValue: true,
        },
        {
            path: 'voice.leaveAfterSeconds',
            label: 'Leave after (seconds)',
            description: 'How long to stay once no approved person is left in the call. Coming back before then cancels leaving.',
            kind: 'integer',
            minimum: 5,
            maximum: 3600,
            defaultValue: 60,
        },
        {
            path: 'voice.transcribe',
            label: 'Who is transcribed',
            description:
                'everyone: every person in the call (so the assistant follows the whole conversation). approved: only approved people. Bots are never transcribed. A notice is posted in the call chat whenever Discordinator joins.',
            kind: 'choice',
            choices: ['everyone', 'approved'],
            defaultValue: 'everyone',
        },
        {
            path: 'voice.retentionDays',
            label: 'Keep transcripts (days)',
            description: 'Call transcripts are saved privately in .data/voice and deleted this many days after the call started.',
            kind: 'integer',
            minimum: 1,
            maximum: 365,
            defaultValue: 30,
        },
        {
            path: 'voice.contextMinutes',
            label: 'Call context (minutes)',
            description:
                'While Discordinator is in a call, each request the assistant gets (spoken or typed) starts with who is in the call and what was said in this many recent minutes, since it last saw the call.',
            kind: 'integer',
            minimum: 1,
            maximum: 120,
            defaultValue: 10,
        },
        {
            path: 'voice.transcribeModel',
            label: 'Transcript model',
            description:
                'Gemini model that writes the always-on call transcript, one clip per person. gemini-3.5-flash-lite costs a few cents per hour of speech.',
            kind: 'text',
            defaultValue: 'gemini-3.5-flash-lite',
        },
        {
            path: 'voice.language',
            label: 'Spoken language',
            description:
                'Two-letter language code like en. Recommended when everyone speaks one language: left empty, the language is guessed for every short clip and quick phrases can come out in the wrong language.',
            kind: 'text',
            defaultValue: '',
        },
        {
            path: 'voice.liveModel',
            label: 'Live voice model',
            description:
                'Gemini Live model that talks with you. When an approved person says one of the names of the bot, it joins the conversation with natural, interruptible timing; it hands real work to your responder and tells you the results as its own. About $0.023 per minute while talking; nothing while just listening.',
            kind: 'text',
            defaultValue: 'gemini-3.8-live',
        },
        {
            path: 'voice.liveVoice',
            label: 'Voice',
            description: 'Gemini voice name, such as Puck, Kore, Charon, Aoede or Zephyr. Leave empty for the default voice of the model.',
            kind: 'text',
            defaultValue: '',
        },
        {
            path: 'voice.idleSeconds',
            label: 'Stop talking after (seconds)',
            description:
                'It also ends a conversation by itself when you are clearly done; this is the backstop when no approved person has spoken to it for this long.',
            kind: 'integer',
            minimum: 10,
            maximum: 600,
            defaultValue: 60,
        },
        {
            path: 'voice.resultTiming',
            label: 'Tell results',
            description:
                'When a task finishes during a conversation. pause: at the next natural pause, once nobody is talking to it (usually within a second). immediately: right away, cutting in even mid-sentence.',
            kind: 'choice',
            choices: ['pause', 'immediately'],
            defaultValue: 'pause',
        },
        {
            path: 'voice.pauseMs',
            label: 'End-of-speech pause (ms)',
            description:
                'How long you must be quiet before your turn counts as finished. Shorter replies faster but may cut you off mid-thought; longer waits through pauses. Also decides when results are told. 0 uses the Gemini default.',
            kind: 'integer',
            minimum: 0,
            maximum: 3000,
            defaultValue: 0,
        },
    ]),
];
