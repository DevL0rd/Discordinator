# Security and authorization

## MCP access boundary

Every MCP operation requires authentication, even on loopback. The default bearer mode requires an independent secret of at least 32 characters and compares credential hashes in constant time. Public OAuth connections validate access JWT signatures with operator-configured HTTPS keys, exact issuer and resource audience, expiration, issued-at and subject claims, an allowed operator subject and `discordinator:control` scope. Only RS256 and ES256 are accepted; a supplied `nbf` is enforced. Discordinator is a resource server, not an authorization server. See [the OAuth contract](connection.md#oauth-resource-contract).

Host/Origin checks apply in both modes. A missing Origin is allowed; an unlisted Origin is denied. Forwarding and identity headers do not grant access. Missing authentication settings fail startup. Keep Discordinator on IPv4 loopback behind your HTTPS proxy, preserve Authorization, and avoid logging credentials.

Bearer webhook subscription owners bind a hash of the configured credential; OAuth owners bind the issuer and immutable subject. Rotating the bearer credential or removing an OAuth subject revokes the corresponding owners during pruning, and OAuth token expiration caps subscription lifetime. Offline JWT verification cannot observe provider-side revocation of an otherwise-valid token before expiry. No MCP identity grants a Discord requester access or confirms a sensitive action.

`discord_send` reads a local file by `{ path }` only for the local client key on this computer, never for bearer or OAuth connections, and only regular files inside the temp folder after symlinks are resolved. Remote clients send files through the upload tools.

## Discord authorization

**Whitelist first, trigger second.** Unlisted users are rejected before trigger text, command options or reply references are examined. An allowed user must mention the bot directly in message text, use a configured name/alias, or reply to a fetched message verified to be authored by this bot in the same channel. Missing, deleted or mismatched references fail closed. `triggers.replyToBot` controls that last option. `Disco, help` matches `disco`; `discord`, `discovery`, `disco2` and `_disco_` do not. Boundaries account for Unicode letters/numbers and underscores. Literal occurrences inside quotes/code count; this is text matching, not intent inference. Unaddressed DMs and ordinary conversation stay quiet. Bots, webhooks, reactions, edits and unrelated commands never create requests. Optional all-message observations may index non-whitelisted guild users or deliver their data to an opted-in subscriber; they never receive an actionable trigger ID or authorize a response.

An explicit invocation of this bot’s `/discordinator` command also counts as addressing it. Only allowed users in approved origins get a deferred response. Writes accept a genuine captured request or an owner-authenticated context from `discordinator_authorize_context`; the latter needs a server channel Discordinator may respond in and an approved requester, not a Discord message. The legacy `eventId` input also accepts that context ID without creating a queue event. Every use rechecks current permissions and owner authentication for direct contexts. Genuine message origins are source-verified before writes; edits, deletions and requester revocation invalidate them. Exact-action approvals and ordinary controls have no elapsed-time deadline but remain bound and single-use; harness approvals additionally require the actual still-pending provider request. Outbound mentions remain restricted, and DMs can only target the approved context's requester.

Verified controls from the bot's own prompt can produce a correlated child request only for the originating allowed user. The actual prompt message, application, channel and live parent must match. Modal input and button selections only produce a correlated child request. [Files and controls](media-and-controls.md) explains the bounds, client editing handoff and source checks.

Content-producing channel tools stay in the originating channel/thread. Guild administration stays in the originating guild. Destructive and permission-changing tools run as soon as they are called, after the same origin, scope, allow/block list and Discord permission checks as every other write.

Proactive sends use a separate tool and explicit per-channel grants; `all` scope never enables them automatically. They cannot DM arbitrary people. A channel reply remains visible to other members who can see that channel: the requester whitelist is not an audience privacy boundary. Moderation may target unlisted members after confirmation, but sends them no automatic notification.

## Names and the owner

Every message, context record, polled event, webhook payload and request handed to a local assistant carries its author's username, global display name and server nickname next to the numeric ID, and `<@id>` mentions are shown as `@name` with the IDs listed alongside. Names are display data only. The whitelist, owner status, approvals, reply origins and every authorization check compare numeric IDs; nothing reads a name to decide what is allowed. Names are quoted and stripped of quotes, line breaks and control characters before an assistant sees them, so a nickname cannot pose as the ID or owner tag Discordinator adds.

`ownerUserId` marks one approved person as the owner. The MCP server instructions, the Claude plugin instructions, the Claude Code conversation and background assistant prompts name the owner by name and ID, and requests from that ID are tagged `owner`. A member whose nickname copies the owner's name keeps their own ID: they are not approved, get no owner tag, and the copied name makes name lookups ambiguous rather than resolving to them.

## Voice calls

Voice requests follow the same rules as text: only approved user IDs can start a conversation by name, in approved servers and channels, and the speaker's ID comes from Discord's per-user audio stream, not from anything said. The live voice only hears approved people; others reach it as transcript notes that never count as instructions, and tasks it hands to the responder run as the approved person who started the conversation. Speech never confirms a sensitive action. Transcripts include everyone in the call by default and are stored privately for the retention period; Discordinator does not announce itself, so tell people the call is transcribed. See [Voice calls](voice.md).

## Credentials and local state

Keep `.env`, `policy.json` and `.data/` private and ignored. Never put tokens in URLs, chat, committed client configuration or logs. Discord credentials are used only for Discord; MCP bearer/OAuth credentials are never forwarded there. Protected-resource metadata is read-only discovery in OAuth mode. Outputs and errors are bounded and sanitized, but permitted reads can contain private messages and invite codes.

Policy changes, including approved people, are picked up live. Intent and credential changes in `.env` are applied by the running process too, by reconnecting only the affected part; nothing needs a restart. Use [configuration](configuration.md) for defaults, [setup](setup.md) for Discord permissions and [architecture](architecture.md#idempotency-and-recovery) for uncertain mutations and journal recovery.
