import { Behavior, FunctionResponseScheduling, GoogleGenAI, Modality, Type, type LiveServerMessage, type Session } from '@google/genai';

export interface LiveTool {
    name: string;
    description: string;
    parameters?: Record<string, string>;
}

export interface LiveOptions {
    model: string;
    voice: string;
    pauseMs?: number;
    system: string;
    tools: LiveTool[];
    resume?: string;
}

export interface LiveEvents {
    audio(pcm: Int16Array): void;
    said(text: string): void;
    interrupted(): void;
    turnComplete(): void;
    tool(id: string, name: string, args: Record<string, unknown>): void;
    resumable(handle: string): void;
    closed(): void;
}

/** One open Gemini Live conversation. Audio in is 16 kHz mono PCM; audio out is 24 kHz mono PCM. */
export type ToolDelivery = { scheduling: 'silent' | 'idle' | 'interrupt'; more: boolean };

export interface LiveSession {
    audio(pcm: Int16Array): void;
    text(text: string, respond: boolean): void;
    /** Answers a tool call. Results can arrive later and more than once (more: true), told when the conversation pauses (idle). */
    toolResult(id: string, name: string, response: Record<string, unknown>, delivery?: ToolDelivery): void;
    close(): void;
}

export interface VoiceProviders {
    readonly configured: boolean;
    transcribe(audio: Buffer, model: string, language: string, context?: string): Promise<string>;
    live(options: LiveOptions, events: LiveEvents): Promise<LiveSession>;
}

type Fetch = typeof fetch;
const api = 'https://generativelanguage.googleapis.com/v1beta';
const schedules = {
    silent: FunctionResponseScheduling.SILENT,
    idle: FunctionResponseScheduling.WHEN_IDLE,
    interrupt: FunctionResponseScheduling.INTERRUPT,
};
const noSpeech = /^\W*(?:\[?\(?\s*(?:no speech|silence|inaudible|nothing|no audio|empty)\s*\)?\]?)?\W*$/i;

export function transcribePrompt(language: string, context = ''): string {
    return [
        `Transcribe this speech exactly as spoken${language ? ` (language: ${language})` : ''}.`,
        'Reply with only the spoken words, no labels, notes or quotes. If there is no clear speech, reply with nothing.',
        context
            ? `For recognizing names and unclear words only (never transcribe or repeat it), this is the conversation so far:\n${context}`
            : '',
    ]
        .filter(Boolean)
        .join(' ');
}

function decode(base64: string): Int16Array {
    const bytes = Buffer.from(base64, 'base64');
    return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

function playParts(parts: { inlineData?: { data?: string } }[] | undefined, events: LiveEvents): void {
    for (const part of parts ?? []) if (part.inlineData?.data) events.audio(decode(part.inlineData.data));
}

function routeContent(content: LiveServerMessage['serverContent'], events: LiveEvents): void {
    if (!content) return;
    playParts(content.modelTurn?.parts, events);
    if (content.outputTranscription?.text) events.said(content.outputTranscription.text);
    if (content.interrupted) events.interrupted();
    if (content.turnComplete) events.turnComplete();
}

function route(message: LiveServerMessage, events: LiveEvents): void {
    routeContent(message.serverContent, events);
    for (const call of message.toolCall?.functionCalls ?? []) events.tool(call.id ?? '', call.name ?? '', call.args ?? {});
    const update = message.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) events.resumable(update.newHandle);
}

export class Gemini implements VoiceProviders {
    constructor(
        private readonly key: () => string | undefined,
        private readonly fetcher: Fetch = fetch,
    ) {}

    get configured(): boolean {
        return Boolean(this.key());
    }

    private required(): string {
        const key = this.key();
        if (!key) throw new Error('Add a Google Gemini API key in the setup app to use voice');
        return key;
    }

    async transcribe(audio: Buffer, model: string, language: string, context = ''): Promise<string> {
        const response = await this.fetcher(`${api}/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            signal: AbortSignal.timeout(30_000),
            headers: { 'x-goog-api-key': this.required(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: transcribePrompt(language, context) },
                            { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } },
                        ],
                    },
                ],
                generationConfig: { temperature: 0, maxOutputTokens: 1024 },
            }),
        });
        if (!response.ok) throw new Error(`Gemini request failed (${response.status})`);
        const result = (await response.json()) as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] };
        const text = (result.candidates?.[0]?.content?.parts ?? [])
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
            .join('')
            .trim();
        return noSpeech.test(text) ? '' : text;
    }

    async live(options: LiveOptions, events: LiveEvents): Promise<LiveSession> {
        const ai = new GoogleGenAI({ apiKey: this.required() });
        const session: Session = await ai.live.connect({
            model: options.model,
            config: {
                responseModalities: [Modality.AUDIO],
                systemInstruction: options.system,
                ...(options.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } } } : {}),
                outputAudioTranscription: {},
                ...(options.pauseMs ? { realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: options.pauseMs } } } : {}),
                contextWindowCompression: { slidingWindow: {} },
                sessionResumption: options.resume ? { handle: options.resume } : {},
                tools: [
                    {
                        functionDeclarations: options.tools.map((tool) => ({
                            name: tool.name,
                            description: tool.description,
                            behavior: Behavior.NON_BLOCKING,
                            ...(tool.parameters
                                ? {
                                      parameters: {
                                          type: Type.OBJECT,
                                          properties: Object.fromEntries(
                                              Object.entries(tool.parameters).map(([key, description]) => [
                                                  key,
                                                  { type: Type.STRING, description },
                                              ]),
                                          ),
                                          required: Object.keys(tool.parameters),
                                      },
                                  }
                                : {}),
                        })),
                    },
                ],
            },
            callbacks: {
                onmessage: (message) => route(message, events),
                onerror: () => undefined,
                onclose: () => events.closed(),
            },
        });
        return {
            audio: (pcm) =>
                session.sendRealtimeInput({
                    audio: {
                        data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
                        mimeType: 'audio/pcm;rate=16000',
                    },
                }),
            text: (text, respond) => session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: respond }),
            toolResult: (id, name, response, delivery = { scheduling: 'silent', more: false }) =>
                session.sendToolResponse({
                    functionResponses: [{ id, name, response, scheduling: schedules[delivery.scheduling], willContinue: delivery.more }],
                }),
            close: () => session.close(),
        };
    }
}
