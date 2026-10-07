# MCP Events and context

Discordinator implements the webhook contract from the **full [official OpenAI MCP Events page](https://developers.openai.com/plugins/build/mcp-events)**, reviewed October 1, 2026. The implementation uses the official MCP TypeScript server/node SDK v2 and protocol **2026-07-28**, rather than relabeling an older transport. The same authenticated `/mcp` endpoint serves tools and Events. Older stateless clients can still use tools through the SDK's legacy fallback; Events require modern requests and their protocol metadata envelope. `events_poll` is an independent application tool, not the draft Events polling protocol.

## Opt in

Defaults turn on context capture (every message, server-wide) and subscriptions (including all messages), cover every server and channel, and grant every API scope; only approved people (`allowedUserIds`) start empty. Narrow any of these by merging fields such as:

```json
{
  "context": {
    "enabled": true,
    "capture": "all",
    "reach": "channel",
    "perChannel": 50,
    "includeBots": true
  },
  "mcpEvents": {
    "enabled": true,
    "allowAllMessages": false
  }
}
```

`capture: "all"` indexes observed messages within approved readable scope, including messages from unlisted guild members. `capture: "addressed"` retains only authorized addressed messages. This setting controls local context ingestion, independently of subscriptions and the action queue. Enable `mcpEvents.allowAllMessages` explicitly only when the operator wants subscribers to receive unaddressed messages too. Use `allowlist` mode to narrow observations to listed servers and channels, or `blocklist` mode to cover everything the bot can access (including servers and channels it joins later) except blocked IDs. These modes never expand the requester whitelist.

Full guild message text needs **both** Message Content switches: Developer Portal → application → **Bot → Privileged Gateway Intents → Message Content Intent → enable/save**, plus the default `DISCORDINATOR_MESSAGE_CONTENT=true` (no environment entry is needed). Name/alias detection additionally needs `triggers.matchNames=true`; startup rejects that combination without the local intent flag. Approval from Discord may be required for the application. Without privileged text access, observations can contain metadata and empty/unavailable content; they are never evidence that the underlying message had no text. `contentAvailable` is best-effort (intent enabled, DM, or nonempty text actually supplied). Discordinator does not fetch historical messages to fill the cache automatically.

## Discovery and subscription

Authenticated `server/discover` advertises `supportedVersions: ["2026-07-28"]`, `resultType: "complete"`, `tools`, and `events` when the principal/policy can use Events. `events/list` returns the single stable event `discord.message.created`, delivery `webhook`, and JSON input/payload schemas. A single-page catalog has no `nextCursor`. Disabled/revoked principals see no event definitions.

`events/subscribe` accepts:

```json
{
  "name": "discord.message.created",
  "arguments": {
    "delivery": "addressed",
    "channel_id": "555555555555555555"
  },
  "delivery": {
    "mode": "webhook",
    "url": "https://receiver.example/mcp-events/callback",
    "secret": "whsec_<base64-encoded-24-to-64-byte-signing-key>"
  },
  "cursor": null,
  "ttlMs": 3600000
}
```

These are method parameters, not a credential to paste into a public file. The placeholder is intentionally invalid. The authenticated host supplies the actual callback and signing secret during a later authorized connection. Discord IDs are strings. Optional `guild_id`, `channel_id`, and `user_id` filters use exact equality; unknown arguments, event names and delivery modes are rejected. Omitted delivery defaults to `addressed`. Omit all ID filters to monitor the entire approved readable scope; `blocklist` mode needs no ID enumeration. Filters are checked against resource policy; an addressed `user_id` must be whitelisted. Actual observed scope and Discord permissions are checked again before delivery; filter IDs alone do not establish that a resource exists or is accessible.

| Mode | Delivered observations | Can authorize a write? |
| :-- | :-- | :-- |
| `addressed` | Allowed person explicitly mentions/names the bot, or replies to a verified message by this bot | Only its live server-owned `trigger_event_id` can be used |
| `all` | New human messages in approved readable scope, including unlisted people; requires separate opt-in | Unaddressed or denied users have `trigger_event_id: null`; payload IDs/text cannot mint an action origin |

Slash interactions remain in `events_poll`; the webhook event represents message creation only. Own-bot and webhook messages never produce webhook events, avoiding output feedback loops. Edits, reactions, joins and other Discord notifications do not mint triggers or webhook events. A delivered event may have outlived its trigger's ten-minute action retention or a process restart; stale IDs must be rejected even if the host still has the payload.

The response contains a deterministic `sub_…` ID, finite ISO `refreshBefore`, `cursor: null`, and `truncated: false`. Identity hashes the transport owner, exact callback URL, event name and canonical validated arguments; key order does not create another subscription. Bearer owners are tied to a hash of the configured credential; OAuth owners are tied to issuer/subject. No caller-supplied owner is accepted. Refresh replaces the same record.

Default lifetime is one hour; requested lifetimes have a one-minute minimum and a one-day maximum. `ttlMs: null` requests indefinite life, but Discordinator grants a finite hour. OAuth expiration also caps the grant; refresh needs another valid token. Owner, filters, callback, verified time, secret and expiration survive restarts in private `.data/subscriptions.json`. Account/resource policy is rechecked before enqueue and each delivery, and during pruning. Bearer rotation or removing an OAuth subject/resource/scope stops delivery. Policy changes apply as soon as they are saved, including operator revocation. Offline JWT validation cannot observe provider-side revocation of an individual otherwise-valid token; expiry and the configured subject list are the available controls.

`events/unsubscribe` takes the original `name`, `arguments`, and `delivery: {mode: "webhook", url: "…"}` **without** the secret. It idempotently deletes only the authenticated owner's matching identity and queued deliveries, aborts in-flight work and pending verification, and returns an empty method result (plus normal MCP 2.0 result metadata). Another owner's identical filters/URL do not remove this subscription. Packets already transmitted cannot be recalled.

## Callback verification and delivery

Before activation, Discordinator POSTs `{type: "verification", challenge: "…"}` with a random, single-use challenge, ten-second deadline, unique verification `webhook-id`, signing timestamp/signature, and `X-MCP-Subscription-Id`. It requires a 2xx response echoing the challenge and uses constant-time comparison. Verification failures return JSON-RPC `-32015` (`CallbackEndpointError`) and a categorized `data.reason`, without callback credentials or bodies. Successful verification is cached for five minutes by owner/URL/signing key, capped at 100 entries. A new signing key requires fresh verification. Cancellation cannot activate a late verification result.

Every verification and delivery uses HTTPS on port 443 only, with no URL credentials/fragments. At **each new connection**, all returned DNS addresses must be public; private, loopback, link-local, shared, mapped and reserved addresses are rejected. IPv6 is additionally restricted to public global unicast. DNS resolution and response receipt share the ten-second deadline. The connection pins a validated IP through Node's lookup callback while retaining the original hostname for TLS identity checking; there is no second unchecked lookup, pooled connection or redirect following. Responses are capped at 8 KiB. No private-network callback exception exists, including for verification.

Application bodies have exactly `eventId`, `name`, occurrence `timestamp` with timezone, `data`, and `cursor: null`. Payloads contain bounded text (1,000 characters, with `<@id>` mentions shown as `@name`), the author's and mentioned people's username, display name and nickname next to their IDs, resource/author/reply/thread metadata, content availability, `addressed`, and nullable `trigger_event_id`. They carry user text as data without model instructions. Bodies are serialized once and capped at 262,144 bytes. Standard Webhooks HMAC headers use the **same event ID as the body**, fresh Unix signing time, and the exact stored bytes; `X-MCP-Subscription-Id` identifies the subscription.

A replacement secret is stored on refresh. For five minutes, signatures contain both current and previous keys separated by spaces; the old key is then removed. A 2xx response acknowledges receipt only, not completed ChatGPT work. Network failures, 429 and 5xx retry up to six attempts with exponential delays capped at a minute. IDs and bytes stay stable, signatures/times are renewed. 410/413 and other permanent errors are never retried. Terminal failure suspends the subscription until an authenticated, verified refresh. Delivery order is not guaranteed, and writes still need idempotency keys.

The private outbox survives restart: at most 500 pending deliveries, ten-minute lifetime (also capped by subscription expiration), four attempts per pump, 32 pending ingress writes, and an 8 MiB storage cap. Subscription count is at most 100; state writes are serialized with a 64-operation backlog cap and atomic private-file replacement. New deliveries dropped on overload are counted. Gateway capture also caps simultaneous message handlers at 32 and dedupes 2,000 creation IDs for ten minutes. There is no replay cursor/history protocol: events missed while offline or dropped cannot be recovered through Events. The outbox improves retry recovery, not global exactly-once delivery. Preserve runtime state during recovery; it contains callback secrets and message data and must never enter git.

## Bounded context reads

The context index is memory-only, separate from action origins, subscriptions and the durable outbox. All queries require `messages.read` and a live allowed `eventId`; supplying a message ID, author ID or webhook observation does not authorize a query or response.

| Tool | Bounds and selection |
| :-- | :-- |
| `context_recent` | Up to 50 retained messages in the trigger channel/thread; `includeParent` can include its observed thread parent, subject to policy |
| `context_user` | Up to 50 retained messages by the **same triggering user** across approved guild channels; no arbitrary-user argument |
| `context_search` | Up to 50 case-insensitive literal-substring matches in the retained trigger channel/thread (optional observed parent) |

A DM origin reads only that same user's retained DM context; guild queries do not disclose DMs. Each result includes message/author/guild/channel/thread parent/reply IDs, the author's names (`author`, `authorName`), mentioned people, `fromOwner` (decided by ID), creation/observation timestamps, content availability and eviction metadata. The newest messages are kept with no time limit: 50 per channel by default (DMs included), at most 100, each message in full. After a restart a channel's recent history is fetched from Discord the first time a responder needs it. Bot messages are included as context by default (turn off with `includeBots`); this never changes webhook/trigger bot rejection. Creates dedupe in Gateway; updates refresh retained text and deletes remove entries, without creating triggers. Missed updates/deletes can leave stale data.

This is an incomplete recent-message cache and literal text index. It has no full Discord search, semantic/vector search, attachment download, OCR, embeddings or embedded model. Empty results do not establish that no message exists. It starts empty on restart, does not backfill history, and only sees events/intents/resources Discord actually delivers. Use scoped bounded Discord history/read tools when authorized and additional history is needed.

## Later ChatGPT handoff

After the owner separately connects an authenticated reachable MCP endpoint through a supported plugin, rescan tools/events, start a new chat and explicitly request an addressed (or opted-in all-message) subscription with a task and filters. Confirm discovery, verified subscription, matching/nonmatching delivery, duplicates/restart/expiration and unsubscribe in that host. This build validates those paths with local mocks only; it does not configure a plugin, provider, token, DNS, HTTPS ingress or Discord connection.

The [official Events integration](https://developers.openai.com/plugins/build/mcp-events) can deliver to an **explicitly subscribed, supported chat**. It does not mean arbitrary Discord events automatically wake this existing ChatGPT conversation or every chat. Host availability, task batching, permissions and connection support remain external. Draft streaming/polling Events delivery and `gap`/`terminated` control notifications are not implemented for this integration.
