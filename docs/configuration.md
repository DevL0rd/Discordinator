# Configuration reference

Start with [Connect your dot](getting-started.md). The recommended path needs only `DISCORD_BOT_TOKEN` in `.env` plus your existing local `policy.json`. OpenAI tunnel credentials/configuration belong to `tunnel-client` and are separate from DotBot.

## Environment defaults

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `DISCORD_BOT_TOKEN` | Required | Discord bot credential; no placeholder or user-account token |
| `DOTBOT_POLICY_FILE` | `policy.json` | Local JSON policy path relative to the project directory |
| `DOTBOT_AUTH_MODE` | `tunnel` | Private local tunnel boundary; advanced `bearer` or `oauth` are explicit |
| `DOTBOT_BIND_HOST` | `127.0.0.1` | Only this literal is accepted; the listener always binds IPv4 loopback |
| `DOTBOT_PORT` | `8787` | Integer from 1024–65535 |
| `DOTBOT_RESOURCE_URL` | `http://127.0.0.1:PORT/mcp` | Derived in tunnel/bearer mode; OAuth requires an explicit canonical HTTPS audience |
| `DOTBOT_MESSAGE_CONTENT` | `true` | Requests Message Content intent; enable it in the Discord portal too |
| `DOTBOT_GUILD_MEMBERS` | `false` | Optional member-listing intent; also needs portal enablement/approval |
| `DOTBOT_MCP_TOKEN` | Unset | Bearer mode only: independent secret of at least 32 characters |
| `DOTBOT_ALLOWED_HOSTS` | Empty | Additional exact Host headers for authenticated advanced ingress |
| `DOTBOT_ALLOWED_ORIGINS` | Empty | Exact supplied Origin allowlist for authenticated advanced clients |
| `DOTBOT_OAUTH_ISSUER` | Unset | OAuth issuer HTTPS URL |
| `DOTBOT_OAUTH_JWKS_URL` | Unset | Operator-chosen HTTPS signing-key endpoint |
| `DOTBOT_OAUTH_SUBJECTS` | Empty | Comma-separated allowed OAuth operator subjects; mandatory in OAuth mode |

Tunnel mode rejects host/origin overrides, credential settings and resource URLs different from its derived loopback URL. It requires loopback peers and denies browser/proxy markers. In bearer/OAuth mode, a missing Origin is allowed; a supplied Origin must be explicitly listed. Default accepted Host headers are `127.0.0.1:PORT` and `localhost:PORT`. See [security](security.md) and the [advanced connection reference](connection.md).

An existing `.env` with `DOTBOT_AUTH_MODE=bearer` or `oauth` retains that mode. No migration rewrites your local files. To use tunnel mode, remove MCP/OAuth credentials and host/origin overrides from the DotBot environment; keep the Discord token and policy. Empty optional URL values are treated as unset. Unsupported auth modes, non-loopback bind values and invalid ports fail startup.

Node's `--env-file=.env` loads the file; existing process environment takes precedence. Run from the project root. DotBot reads configuration once, so restart after editing. Files containing credentials and personal IDs are ignored by git.

## Policy defaults

The full [public policy example](../policy.example.json) grants no users, scopes or destinations. It explicitly enables `DotBot`/`dot` alias matching for the guide. The schema defaults below apply to omitted fields; they never infer identities or grants.

| Field | Default | Purpose |
| :-- | :-- | :-- |
| `allowedUserIds` | `[]` | Up to 100 quoted 17–20 digit Discord IDs; empty rejects every requester |
| `guildScope`, `channelScope` | `listed` | Check exact listed IDs; explicit `all` includes future accessible resources |
| `guildIds`, `channelIds` | `[]` | Up to 100 guilds / 1000 channels; threads require their own IDs |
| `scopes` | `[]` | Explicit capabilities from [the tool reference](capabilities.md) |
| `triggers.replyToBot` | `true` | Fetch and verify a same-channel reply target authored by this bot |
| `triggers.matchNames` | `false` | Literal alias matching; requires Message Content intent locally and in Discord |
| `triggers.names` | `[]` | Up to ten aliases of 2–32 characters |
| `context.enabled`, `media.enabled`, `mcpEvents.enabled` | `false` | Independent opt-ins for context, attachments and subscriptions |
| `context.capture`, `media.capture` | `addressed` | Explicit `all` enables observation beyond triggers |
| `context.maxMessages`, `context.perChannel` | `500`, `50` | At most 2000 retained messages / 100 per channel |
| `context.ttlMinutes`, `context.contentLimit` | `30`, `1000` | Hard maxima 60 minutes / 2000 characters |
| `context.includeBots` | `false` | Bot content observation only; never a trigger |
| `media.maxAttachments`, `media.ttlMinutes` | `500`, `30` | Hard maxima 1000 attachments / 60 minutes |
| `media.maxFileBytes` | `2097152` | Hard maximum 8388608 bytes |
| `mcpEvents.allowAllMessages` | `false` | Separate opt-in for all-message delivery |
| `proactive` | `[]` | Exact channel grants with `scopes: ["message.send"]`; no wildcard or arbitrary DM |

Policy objects reject unknown fields. Observation never authorizes a response. `all` resource modes do not grant capabilities, change the whitelist or enable proactive sends. DM origins still need a whitelisted author and explicit trigger. See [Discord setup](setup.md#policy), [events/context](mcp-events.md), [media](media-and-controls.md) and [authorization](security.md#discord-authorization) for detailed behavior.
