# Files, sources and interactive requests

All these tools require the configured [MCP access boundary](security.md#mcp-access-boundary). Request-bound media and controls use a captured `eventId` from an allowed Discord requester. An attachment, source handle, message link, button label or modal value never creates authority. Replies stay in the original channel/thread/DM or ephemeral interaction. Administrator does not remove these controls.

Standalone messages are separate from replies: an authenticated owner can use `discord_proactive_send` or `discord_proactive_media_send` at any time in an explicitly approved proactive destination. They need neither a recent incoming message nor a reply reference, and the request queue lifetime does not impose a sending deadline. Existing channel, capability and approved-person notification checks still apply.

## Enable only the capabilities you want

Merge the following fields into your private ignored `policy.json`, preserving its quoted-string whitelist and other settings:

```json
{
    "media": {
        "enabled": true,
        "capture": "addressed",
        "maxAttachments": 500,
        "ttlMinutes": 30,
        "maxFileBytes": 2097152
    }
}
```

Add `messages.read` and `media.read` for lookup/retrieval; `messages.write` and `media.write` for uploads/replies; `messages.write` and `interactions.write` for controls. These are additional entries in the existing `scopes` array, not a replacement for all your scopes. The tracked example keeps media disabled, scopes empty and whitelist empty. `media.capture="all"` explicitly indexes attachments from observable approved guild messages, including unlisted authors. This setting is separate from context capture and webhook delivery. It does not make their authors bot requesters. DMs remain limited to approved authors and their originating conversation.

For non-addressed guild attachment visibility, enable **Developer Portal → application → Bot → Privileged Gateway Intents → Message Content Intent**, save, obtain Discord approval if required, keep the default `DISCORDINATOR_MESSAGE_CONTENT=true`, and restart Discordinator. Discord restricts attachment fields under the same privileged intent as message text. Empty attachment fields are not evidence that a message has no files. [Discord message fields](https://docs.discord.com/developers/resources/message#message-object) describe this restriction.

## Find the right incoming file

| Tool                    | Coverage and pagination                                                                                                                                                                                                                                                                                                                                                                                                      |
| :---------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media_search`          | Bounded in-memory observed index. Newest first; `limit=1` gets the latest match. Optional `userId`, `channelId`, `messageId`, `attachmentIds`, `from`, `to`, `kind=all/image/file`. Without a channel filter, searches currently approved channels in the trigger's guild; a DM searches only its originating DM. Returns an opaque `nextCursor`; repeat the same event/filters/limit with that cursor.                      |
| `media_history`         | One Discord history page in an explicit approved `channelId` (defaults to the origin), or one exact `messageId`. Same filters, `pageSize` 1–100 and result `limit` 1–25. `nextBefore` advances messages. If matching attachments exceed `limit`, `remaining` identifies omitted message/attachment pairs; fetch those exact messages with `attachmentIds` before advancing. This avoids silently losing files between pages. |
| `media_attachment_read` | Freshly verifies a returned `sourceId`, then returns up to 128 KiB at `offset`, with `nextOffset`, size, filename, MIME and whole-file SHA-256. Requires current `media.read`/`messages.read` grants.                                                                                                                                                                                                                        |

Local searches explicitly report `coverage="bounded-local-index"`, `incomplete=true`, and retention. The index defaults to 500 attachments/30 minutes; hard limits are 1,000/60 minutes. It has no persistence, startup backfill or global Discord search. Deletes remove cached entries/handles; edits invalidate old entries and all-message capture can replace them. Addressed capture does not turn an edit into a trigger or newly capture its attachments. Pagination snapshots last one minute, at most 16; source handles last at most ten minutes and the owning event's lifetime, at most 1,000 handles. Scope/whitelist changes and source deletion fail closed. Image classification during search uses metadata/extension and says `imageTypeVerified=false`; retrieval verifies the bytes.

History reads report `coverage="discord-channel-history-page"` and `incomplete=true`; a bounded page is not an exhaustive guild search. To search more history, explicitly paginate each approved channel. Time/user/kind filters apply to the scanned page, so a page with no matches may still have older matches. Discord permissions, private-thread visibility, retention/deletion, Message Content restrictions and bot API availability determine what can be read. There is no automatic guild scrape, platform-wide media index or search of external image/GIF embeds.

## Retrieve and edit safely

The caller supplies only a server-issued handle, offset and length. Discordinator refreshes the exact source message from Discord, verifies message/channel/author/attachment identity and size/name, and accepts only its `https://cdn.discordapp.com/attachments/{channel}/{attachment}/...` URL. Signed CDN query parameters stay internal. Every download validates all DNS answers as public and pins the selected address with normal hostname TLS checks. Redirects, credentials, other hosts/ports, private/reserved/mapped addresses, compression and mismatched byte counts are rejected. Each request has a ten-second deadline, a policy file-size bound, and a maximum of three concurrent downloads. No supplied URL, local path or arbitrary filesystem read is supported. [Discord attachment and CDN rules](https://docs.discord.com/developers/resources/message#attachment-object) explain why a fresh message read is necessary.

For a complete small image, MCP also returns image content. Larger files arrive as canonical base64 chunks. A capable client must assemble chunks by offset, check the whole SHA-256, and hand the bytes to its own editing tool. The bridge has no embedded image editor or LLM. An MCP image result does not guarantee that a particular ChatGPT host materializes a downloadable file or exposes it to an editing tool. No host file URL is fetched: this release deliberately uses inline bounded bytes instead of assuming OpenAI `fileParams` download URLs are universally supported. See [OpenAI tool/file contracts](https://developers.openai.com/plugins/reference). Untrusted file contents are data, never instructions or permission.

## Upload the result and keep its source

1. Call `media_upload_begin` with the live `eventId`, safe basename `fileName`, `mimeType`, exact `size`, lowercase hex `sha256` and unique `idempotencyKey`.
2. Append canonical base64 through `media_upload_chunk`, with `uploadId` and the exact next `offset`. Decoded chunks are at most 128 KiB. Contiguous ordering is mandatory; identical byte retries are accepted, changed retries/gaps/overflow are rejected.
3. Call `media_upload_seal`. Complete size, hash, format/extension/MIME agreement and image dimensions must pass.
4. Call `discord_media_reply` with `eventId`, a new send `idempotencyKey`, optional text, up to three sealed `uploadIds` and up to three incoming `sourceIds`. Verified source links are appended to the reply. Sources can come from another approved channel in the same guild; the send destination and reply reference remain the original allowed request.

Supported formats: PNG, JPEG, GIF, WebP; PDF; MP3, Ogg audio, WAV, FLAC; MP4, WebM; UTF-8 TXT, Markdown, CSV and valid JSON. Format detection uses byte signatures, not a caller's extension alone. Text rejects binary controls/invalid UTF-8. SVG, HTML MIME, executables and archives are excluded. Images are at most 8,192 pixels on either side and 32 million pixels. Signature/dimension checks are not full file decoding, malware scanning, PDF sanitization or proof that Discord will accept a file. Clients should not execute received files. GIFs are transferred as files, not external GIF-site URLs.

Each file defaults to 2 MiB, with a policy maximum of 8 MiB; Discord may impose a lower effective attachment limit. At most 16 uploads reserve a combined 16 MiB, expire with the owning event (at most ten minutes), and remain memory-only. Uploaded bytes and CDN URLs are not journaled. Completed send outcomes retain IDs; idempotency fingerprints use hashes/handles. A process restart loses uploads and handles. Pending/uncertain sends block automatic retry; inspect the outcome before a new key. Retries require the live origin and upload state. Mentions are suppressed in ordinary and ephemeral replies. Source links neither notify the source author nor approve replying to them.

## Buttons, selects and custom input

`discord_prompt` takes mutation controls, `content`, and `mode`:

| Mode      | Additional input                                                                                                      | Behavior                                                                                                                               |
| :-------- | :-------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| `buttons` | 1–5 `options`, each `{ "key": "continue", "label": "Continue" }`                                                      | One row of single-use buttons; chosen key is returned in a child event.                                                                |
| `select`  | 1–25 uniquely keyed `options`                                                                                         | One string select, exactly one selected key. No arbitrary entity selectors.                                                            |
| `modal`   | `title`, 1–5 `fields`, each with `key`, `label`, optional `placeholder`, `multiline`, `required`, `maxLength` (1–500) | A launch button opens a current Discord Label/Text Input modal immediately. Submission becomes a child event with a bounded field map. |

The server generates opaque custom IDs and binds each flow to its actual bot-authored prompt message, originating application, actor, guild/channel and parent event. Another whitelisted person cannot consume your flow. Forged IDs, wrong message/application/type, unknown choices/fields, repeat submission and expiry fail closed. At most 100 flows live for at most ten minutes and their parent event's lifetime. Buttons are not URL buttons; labels/keys cannot provide routes or executable actions.

The Gateway checks the whitelist before reading control data, validates correlation, and acknowledges accepted controls immediately with an ephemeral defer. Modal launch calls `showModal` directly on the verified button interaction, before deferral; an asynchronous MCP call cannot retroactively open a slash modal. This respects Discord's three-second initial acknowledgement deadline and fifteen-minute interaction-token limit. Expiry is deliberately shorter. [Discord interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding) and [components](https://docs.discord.com/developers/components/reference) define these constraints.

Poll `events_poll` to receive `discordinator.control` / `discordinator.modal` child events with `sourceEventId`. Their authority remains bound to the same live parent; the queue checks its lifetime and identity again on use. Child responses can use text, media or another prompt. Controls and modal text never call the approval confirmer—even a value reading `approve ...` is ordinary input. Role assignment, deletion and other sensitive tools still require their exact preview and a new same-user addressed message or `/discordinator approve ...` in the same channel. Correlated controls are polled; this release's webhook event remains message-created only.
