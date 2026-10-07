import { note, section, settingItem, statusItem } from '../items.js';
import type { Item, View } from '../model.js';

function readiness(view: View): { text: string; state: 'good' | 'warn' | 'idle' } {
    const policy = view.drafts.policy as { voice?: { enabled?: boolean }; scopes?: string[] };
    if (!policy.voice?.enabled) return { text: 'Off', state: 'idle' };
    if (!view.drafts.environment.GEMINI_API_KEY) return { text: 'Needs a Google Gemini key', state: 'warn' };
    if (!policy.scopes?.includes('voice.listen')) return { text: 'Needs the voice.listen ability (Discord page)', state: 'warn' };
    if (!policy.scopes.includes('voice.speak')) return { text: 'Transcribing only; grant voice.speak to talk', state: 'warn' };
    return { text: 'Ready', state: 'good' };
}

export function voiceItems(view: View): Item[] {
    const ready = readiness(view);
    return [
        ...section('voice-calls', 'Voice calls', 'Join calls, transcribe everyone and talk', [
            statusItem('voice-ready', 'Voice', ready.text, ready.state),
            settingItem('policy.voice.enabled', 'Use voice calls'),
            settingItem('environment.GEMINI_API_KEY', 'Google Gemini API key'),
            settingItem('policy.voice.autoJoin', 'Join when an approved person joins'),
            settingItem('policy.voice.leaveAfterSeconds', 'Leave after (seconds)'),
            note(
                'voice-where',
                'Get a key at aistudio.google.com/apikey. Auto-join follows the server and channel rules on the Discord page. /join, /leave, /mute and /unmute work in Discord. Grant voice.listen and voice.speak under Allowed abilities.',
            ),
        ]),
        ...section('voice-transcripts', 'Transcripts', 'Always on while it is in a call', [
            settingItem('policy.voice.transcribe', 'Who is transcribed'),
            settingItem('policy.voice.retentionDays', 'Keep transcripts (days)'),
            settingItem('policy.voice.contextMinutes', 'Call context (minutes)'),
            settingItem('policy.voice.transcribeModel', 'Transcript model'),
            settingItem('policy.voice.language', 'Spoken language'),
        ]),
        ...section('voice-talk', 'Talking', 'Say its name to start a conversation', [
            settingItem('policy.voice.liveModel', 'Live voice model'),
            settingItem('policy.voice.liveVoice', 'Voice'),
            settingItem('policy.voice.idleSeconds', 'Stop talking after (seconds)'),
            settingItem('policy.voice.pauseMs', 'End-of-speech pause (ms)'),
            settingItem('policy.voice.resultTiming', 'Tell results'),
            note(
                'voice-names',
                'Say one of its names (Discord page, Names it answers to) anywhere in a sentence and it answers live, then drifts back to listening when you are done. What it says is also typed in the call chat. Muted, it only types.',
            ),
        ]),
    ];
}
