# Voice calls

Discordinator can join voice calls, keep a transcript of everyone, and talk with you naturally through **Gemini 3.8 Live**. One Google key covers all of it.

## Turning it on

1. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. In the setup app (`discordinator`), open **Voice** (key 4), turn on **Use voice calls** and paste the **Google Gemini API key**. It is stored privately in `.env` and used right away.
3. On the **Discord** page, add `voice.listen` (join and transcribe) and `voice.speak` (talk) to **Allowed abilities**.
4. The bot needs **Connect** and **Speak** in the voice channels it uses, and permission to post in each call's text chat.

The Voice page shows **Ready** once everything is in place. Every setting except the key can also be changed with `discordinator_settings_update`.

## Joining

- **Automatically:** when an approved person (by user ID, including approved roles) is in a voice channel, Discordinator joins it, following the server and channel rules on the Discord page (allowlist or blocklist). One call per server; it never follows people out of a call.
- **By command:** `/join` joins the voice channel you are in; `/leave` leaves the call in that server.
- **From the assistant:** `voice_join` and `voice_leave`.

It leaves once no approved person has been in the call for **Leave after** seconds (60 by default). Being moved or disconnected ends the call. It does not post anything when it joins; telling people the call is transcribed is up to you.

## Listening: the transcript

While in a call, Discordinator transcribes everyone, other bots included (or only approved people and bots, under **Who is transcribed**). An approved bot can talk to it by name like an approved person. Discord delivers each person's audio separately, tagged with their user ID, so every line is attributed exactly. Each utterance goes to the **Transcript model** (`gemini-3.5-flash-lite` by default) with a little context to help with names and unclear words: the bot's names, the people in the call and the last five lines. Transcripts are saved privately in `.data/voice/` and deleted after **Keep transcripts** days (30 by default).

`voice_calls` lists calls; `voice_transcript` reads one, oldest first in pages of up to 1,500 lines (follow `page.nextStart`), so the assistant can summarize even a long call in full; `voice_transcript_delete` deletes a finished one.

## Talking: live conversation

Say the bot's Discord name, or one of its extra names (**Discord → Names it answers to**), anywhere in a sentence. Discordinator opens a Gemini 3.8 Live conversation that already knows who is in the call and what was said recently, and answers what you just said. From then on it is a natural, full-duplex conversation: no name needed, and you can interrupt it.

- **It goes back to listening on its own.** When you are clearly done with it, or are talking to each other, it ends the conversation itself. If no approved person talks to it for **Stop talking after** seconds (60 by default), it ends anyway. Saying its name brings it back.
- **It is the face of your responder.** For anything beyond conversation (actions, Discord changes, messages, files, code, looking things up), it hands the task, with your own words, to your responder (Claude Code, Codex or ChatGPT) and says it is on it, while the conversation carries on. Each reply the responder sends for that task is delivered back on the task itself and told at the next natural pause (or right away, with **Tell results**), as its own work; status updates stay quiet. If the conversation had ended, it comes back to say so. It never mentions another assistant.
- **One memory.** Everything it says is typed in the call chat and saved in the transcript as the bot's own words, so the responder sees it in its call context and the voice remembers it the next time it talks.
- **Only approved people are heard live.** Other people's words reach it only as transcript notes, which it treats as context and never as instructions, so someone else in the call cannot make it act. Sensitive actions still need the usual typed approval.
- **Muted, it only types.** `/mute` (or a server mute) ends any conversation and makes no audio; saying its name then sends the request straight to your responder, which answers in the call chat. `/unmute` lets it talk again.

`voice_speak` lets the assistant have the voice say something in a call at any time, with no request to reply to: for example telling you a build finished while you are in a call.

## Cost

| Part | Cost |
| :-- | :-- |
| Transcript (Gemini Flash-Lite) | A few cents per hour of speech, always on while in a call |
| Live conversation (Gemini 3.8 Live) | About $0.005 per minute in and $0.018 per minute out, only while it is talking with you |

## Settings

| Setting | Default | Meaning |
| :-- | :-- | :-- |
| `GEMINI_API_KEY` (`.env`) | Unset | Google key for transcripts and live conversation |
| `voice.enabled` | `true` | Use voice calls at all |
| `voice.autoJoin` | `true` | Join when an approved person is in an allowed voice channel |
| `voice.leaveAfterSeconds` | `60` | Stay this long after the last approved person leaves (5–3600) |
| `voice.transcribe` | `everyone` | `everyone` or `approved` |
| `voice.retentionDays` | `30` | Keep transcripts this many days (1–365) |
| `voice.contextMinutes` | `10` | Recent call minutes given to the voice and the responder (1–120) |
| `voice.transcribeModel` | `gemini-3.5-flash-lite` | Gemini model for the transcript |
| `voice.language` | Empty | Two-letter language code, or empty to detect; set it when everyone speaks one language |
| `voice.liveModel` | `gemini-3.8-live` | Gemini Live model for conversation |
| `voice.liveVoice` | Empty | Gemini voice name such as Puck, Kore, Charon, Aoede or Zephyr; empty for the default |
| `voice.idleSeconds` | `60` | End a conversation after this long without an approved person talking to it (10–600) |
| `voice.resultTiming` | `pause` | When task results are told: `pause` at the next natural pause, or `immediately`, cutting in |
| `voice.pauseMs` | `0` | Silence (ms) before your turn counts as finished; also when results are told. 0 uses Gemini's default (0–3000) |

## Timing

Saying its name starts a conversation in about 4–5 seconds: the clip is transcribed (about 2.5 s), the live session connects (about 0.7 s) and starts speaking (about 1 s). After that, replies come with natural timing, about a second after you stop talking.

## Limits and caveats

- Discord does not officially support bots receiving voice audio; it works through `@discordjs/voice` and could break with Discord changes. Calls use Discord's end-to-end encryption (DAVE) through `@snazzah/davey`; after a burst of decryption failures Discordinator rejoins the same call automatically.
- Live sessions run on Google's servers over a persistent connection; if it drops, Discordinator resumes it once and otherwise goes back to listening.
- At most 16 utterances wait for transcription per call (two at a time); older ones are dropped under overload and counted in status.
- Transcripts are speech-to-text and can be wrong. Like any Discord text they are untrusted content and never authorize anything.
