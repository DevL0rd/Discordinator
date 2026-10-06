# Configuration reference

Start with [Get started](getting-started.md). The setup app (`npm run setup`) edits all of these for you. Authentication is mandatory: use your public HTTPS URL and an OAuth provider, or an independent bearer credential for a local client. No hosting or identity provider is built in.

## Environment defaults

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `DISCORD_BOT_TOKEN` | Required | Discord bot credential; no placeholder or user-account token |
| `DISCORDINATOR_POLICY_FILE` | `policy.json` | Local JSON policy path relative to the project directory |
| `DISCORDINATOR_AUTH_MODE` | `bearer` | Independent credential required; select `oauth` for a public OAuth connection |
| `DISCORDINATOR_BIND_HOST` | `127.0.0.1` | Only this literal is accepted; the listener always binds IPv4 loopback |
| `DISCORDINATOR_PORT` | `8787` | Integer from 1024–65535 |
| `DISCORDINATOR_RESOURCE_URL` | `http://127.0.0.1:PORT/mcp` | Derived only in bearer mode; OAuth requires an explicit canonical HTTPS identifier |
| `DISCORDINATOR_MESSAGE_CONTENT` | `true` | Requests Message Content intent; enable it in the Discord portal too |
| `DISCORDINATOR_GUILD_MEMBERS` | `true` | Lets the bot see server members; also enable Server Members Intent in the portal |
| `DISCORDINATOR_MCP_TOKEN` | Unset | Bearer mode only: independent secret of at least 32 characters |
| `DISCORDINATOR_ALLOWED_HOSTS` | Empty | Extra exact Host headers; the public domain is always allowed automatically |
| `DISCORDINATOR_ALLOWED_ORIGINS` | Empty | Extra exact Origins; the public domain is always allowed automatically |
| `DISCORDINATOR_OAUTH_ISSUER` | Derived | External providers only; the built-in sign-in uses the public domain |
| `DISCORDINATOR_OAUTH_JWKS_URL` | Derived | External providers only; the built-in sign-in uses `/oauth/jwks` |
| `DISCORDINATOR_OAUTH_SUBJECTS` | Empty | External providers only: allowed operator subjects |

A missing Origin is allowed; a supplied Origin must be explicitly listed. Default accepted Host headers are `127.0.0.1:PORT` and `localhost:PORT`; add your exact public Host when using HTTPS ingress. The listener always remains on IPv4 loopback. Forwarding or identity headers alone do not establish authentication. See [security](security.md).

An existing `.env` with `DISCORDINATOR_AUTH_MODE=bearer` or `oauth` retains that mode. Empty optional OAuth URLs are treated as unset. Missing bearer/OAuth credentials, unsupported auth modes, non-loopback binds and invalid ports fail startup. Preserve existing bot credentials and policy; configure authentication as described in [connection](connection.md).

Node's `--env-file=.env` loads the file; existing process environment takes precedence. Run from the project root. When Discordinator runs as the background service, it restarts itself once idle after `.env` changes; otherwise restart it after editing `.env`. Files containing credentials and personal IDs are ignored by git.

Older `DOTBOT_*` keys in `.env` are renamed to `DISCORDINATOR_*` automatically, one time, with a private backup in `.data/setup-backups`, the next time Discordinator or the setup app starts.

## Policy defaults

The full [public policy example](../policy.example.json) grants no users, scopes or destinations. It explicitly enables `Discordinator`/`disco` alias matching for the guide. The schema defaults below apply to omitted fields; they never infer identities or grants.

| Field | Default | Purpose |
| :-- | :-- | :-- |
| `allowedUserIds` | `[]` | Up to 100 quoted 17–20 digit Discord IDs; empty rejects every requester |
| `servers.mode`, `channels.mode` | `allowlist` | `allowlist`: only IDs in `allowed`. `blocklist`: everything the bot can access except IDs in `blocked` |
| `servers.allowed`, `channels.allowed` | `[]` | Up to 100 servers / 1000 channels; an empty allowlist allows nothing; threads need their own IDs in allowlist mode |
| `servers.blocked`, `channels.blocked` | `[]` | Always excluded, in both modes; an empty blocklist excludes nothing |
| `scopes` | `[]` | Explicit capabilities from [the tool reference](capabilities.md) |
| `triggers.replyToBot` | `true` | Fetch and verify a same-channel reply target authored by this bot |
| `triggers.matchNames` | `false` | Literal alias matching; requires Message Content intent locally and in Discord |
| `triggers.names` | `[]` | Up to ten aliases of 2–32 characters |
| `context.enabled`, `media.enabled`, `mcpEvents.enabled` | `false` | Independent opt-ins for context, attachments and subscriptions |
| `context.capture`, `media.capture` | `addressed` | Explicit `all` enables observation beyond triggers |
| `context.reach`, `context.perChannel` | `channel`, `50` | Whether a responder sees history from only the channel it was messaged from or the whole server (grouped by channel); at most 100 messages per channel, DMs included |
| `context.includeBots` | `true` | Bot messages are visible as context only; bots never trigger a response |
| `media.maxAttachments`, `media.ttlMinutes` | `500`, `30` | Hard maxima 1000 attachments / 60 minutes |
| `media.maxFileBytes` | `2097152` | Hard maximum 8388608 bytes |
| `mcpEvents.allowAllMessages` | `false` | Separate opt-in for all-message delivery |
| `proactive` | `[]` | Exact channel grants with `scopes: ["message.send"]`; no wildcard or arbitrary DM |

Server and channel modes are independent, blocked IDs always win, and Discord's own permissions still apply. Older policy files are migrated automatically when loaded: `guildScope: "all"` becomes `servers` in `blocklist` mode (old `guildIds` kept as `allowed`, nothing blocked), `"listed"` becomes `allowlist` mode with the old `guildIds` as `allowed`; channels migrate the same way.

Policy objects reject unknown fields. Observation never authorizes a response. `blocklist` mode does not grant capabilities, change the whitelist or enable proactive sends. DM origins still need a whitelisted author and explicit trigger. See [Discord setup](setup.md#policy), [events/context](mcp-events.md), [media](media-and-controls.md) and [authorization](security.md#discord-authorization) for detailed behavior.
