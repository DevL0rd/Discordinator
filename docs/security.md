# Security and authorization

## Local tunnel boundary

The recommended `tunnel` mode binds only to `127.0.0.1`. It accepts only IPv4 loopback peers arriving on a loopback-bound listener, exact `127.0.0.1:PORT` or `localhost:PORT` Host headers, no Origin header, and no Forwarded, X-Forwarded-*, X-Real-IP, Via or CF-Connecting-IP headers. Host/origin overrides, non-loopback bind values, nonlocal resource URLs and MCP/OAuth credential settings fail configuration validation in this mode. There is no public unauthenticated control mode.

This mode relies on Secure MCP Tunnel's OpenAI runtime credential and organization/workspace controls, plus access to the local host. The runtime credential belongs to `tunnel-client`, not DotBot. Official documentation does not establish injection of DotBot's static bearer credential, and this design does not depend on it. See [OpenAI's tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

Any process with access to this host's loopback network can use the local MCP endpoint. DotBot cannot distinguish such a process from `tunnel-client`, or detect a proxy that strips every forwarding marker and rewrites Host. Keep the host trusted. Never attach public ingress, port forwarding, a header-rewriting reverse proxy or a shared container network to tunnel mode. Run DotBot and `tunnel-client` directly on the same trusted host/network namespace. Use [external OAuth](connection.md#advanced-public-https-and-external-oauth) before adding public HTTPS ingress.

All tunnel callers share the local transport owner `tunnel:local` for optional webhook subscriptions. This is not an OpenAI user identity, and DotBot does not independently verify OpenAI membership or the runtime key. Restrict tunnel access to operators you trust with the policy's read capabilities and proactive grants. Switching authentication modes revokes existing subscription owners during pruning; reconcile local subscription state when changing modes. The tunnel cannot grant a Discord user access or confirm a sensitive action.

## Discord authorization

**Whitelist first, trigger second.** Unlisted users are rejected before trigger text, command options or reply references are examined. An allowed user must mention the bot directly in message text, use a configured name/alias, or reply to a fetched message verified to be authored by this bot in the same channel. Missing, deleted or mismatched references fail closed. `triggers.replyToBot` controls that last option. `DOT, help` matches `dot`; `anecdotal`, `dotnet`, `dot2` and `_dot_` do not. Boundaries account for Unicode letters/numbers and underscores. Literal occurrences inside quotes/code count; this is text matching, not intent inference. Unaddressed DMs and ordinary conversation stay quiet. Bots, webhooks, reactions, edits and unrelated commands never create requests. Optional all-message observations may index non-whitelisted guild users or deliver their data to an opted-in subscriber; they never receive an actionable trigger ID or authorize a response.

An explicit invocation of this bot’s `/dot` command also counts as addressing it. Only allowed users in approved origins get an ephemeral deferred response. Every user-driven write needs an unexpired captured `eventId`; MCP callers cannot supply an actor ID or forge an origin. The same checks cover replies, DMs, interactions, threads, message edits, reactions and indirect actions. Outbound mentions are disabled, and DMs can only target the originating whitelisted person.

Verified controls from the bot's own prompt can produce a correlated child request only for the originating allowed user. The actual prompt message, application, channel and live parent must match. Modal input and button selections never approve sensitive actions. [Files and controls](media-and-controls.md) explains the bounds, client editing handoff and source checks.

Content-producing channel tools stay in the originating channel/thread. Guild administration stays in the originating guild. Destructive and permission-changing tools return an exact preview and a two-minute approval ID; the same user must explicitly approve it through a new addressed Discord message or `/dot` invocation in the same channel. The MCP client then repeats the original operation with that approval ID. Model-supplied confirmation cannot replace this step.

Proactive sends use a separate tool and explicit per-channel grants; `all` scope never enables them automatically. They cannot DM arbitrary people. A channel reply remains visible to other members who can see that channel: the requester whitelist is not an audience privacy boundary. Moderation may target unlisted members after confirmation, but sends them no automatic notification.

## Credentials and local state

Keep `.env`, `policy.json` and `.data/` private and ignored. Never put tokens in URLs, chat, committed client configuration or logs. Discord credentials are used only for Discord; MCP bearer/OAuth credentials are never forwarded there. Protected-resource metadata is read-only discovery in OAuth mode. Outputs and errors are bounded and sanitized, but permitted reads can contain private messages and invite codes.

Policy, intent and credential changes require a restart. Use [configuration](configuration.md) for defaults, [setup](setup.md) for Discord permissions and [architecture](architecture.md#idempotency-and-recovery) for uncertain mutations and journal recovery.
