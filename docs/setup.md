# Setup and permissions

Start with [the README](../README.md). Installation only downloads npm dependencies and builds the server. It does not acquire credentials, configure OAuth, install a Discord application or start a service.

## Runtime files

`.env`, `policy.json` and `.data/` are ignored. Keep them local. `.env.example` and `policy.example.json` are public placeholders; the whitelist and scopes in the public policy are empty. Do not force-add runtime files to git.

For a fresh checkout:

```sh
cp .env.example .env
cp policy.example.json policy.json
```

PowerShell:

```powershell
Copy-Item .env.example .env
Copy-Item policy.example.json policy.json
```

Skip the policy copy if you already have a configured local policy. This laptop’s ignored policy has been separately prepared; it is intentionally absent from the public repository. No credentials are supplied with the project.

Set a real **bot** credential locally when you later authorize connecting. Never use a user account token. Set a separate random MCP credential of at least 32 characters for bearer mode. Do not reuse the Discord credential. Placeholder values are rejected. No OpenAI API key or model account is required by DotBot itself.

The process reads configuration once. Stop it, edit local files and restart to change policy. Node’s `--env-file=.env` reads the environment file; existing process environment values take precedence. Always run from the project directory so relative policy and journal paths resolve there.

## Policy

| Field | Meaning |
| :-- | :-- |
| `allowedUserIds` | Up to 100 quoted Discord user IDs; empty silently rejects every Discord requester |
| `guildScope` | `listed` checks `guildIds`; `all` allows every guild accessible to the bot |
| `channelScope` | `listed` checks exact `channelIds`; `all` allows every accessible channel/thread |
| `guildIds`, `channelIds` | Quoted IDs used in listed mode; threads need their own ID, not only their parent |
| `scopes` | Capability names from [capabilities](capabilities.md); an absent capability is denied |
| `triggers.matchNames` | Enables alias matching; requires local Message Content intent flag |
| `triggers.replyToBot` | Allows same-channel replies only after fetching and verifying this bot authored the referenced message; defaults true |
| `context` | Opt-in bounded context index: addressed or all-message capture, retention and size bounds |
| `media` | Opt-in attachment index/capture, retention/count/file bounds; scopes remain mandatory |
| `mcpEvents` | Opt-in verified webhook subscriptions; unaddressed all-message delivery is a separate switch |
| `triggers.names` | Up to 10 literal names/aliases, 2–32 characters each; no regex syntax |
| `proactive` | Entries containing `channelId` and `scopes: ["message.send"]`; no wildcard, guild-wide or DM grant |

To avoid ID enumeration, set both scope modes to `all` in the full policy. This is explicit access to current and future joined resources. The whitelist stays exact and mandatory. Capability scopes stay explicit. Approved event provenance still constrains each mutation. The authenticated `discord_guilds_list` tool can discover guild IDs; `discord_channels_list` can discover channels. Discord permissions can make otherwise approved resources inaccessible.

DM origins bypass guild/channel lists because they have no guild, but still require a whitelisted author and an explicit trigger. Guild-only operations do not work on a DM. `discord_dm` targets only the originating author. A configured proactive destination must be a guild channel permitted by both scope modes and have its own grant.

In listed mode, a newly created channel/thread is **not** automatically added to policy. Add its returned ID locally before using it. All-channel mode includes it if Discord permits access.

## Gateway intents

The baseline is `Guilds`, `GuildMessages` and `DirectMessages`, with the channel partial needed for DMs. No presence, typing, reaction or member-event listener is registered.

For name/alias triggers, do all of these **later, before connecting**:

1. Open the [Developer Portal](https://discord.com/developers/applications) and select your application.
2. On **Bot**, find **Privileged Gateway Intents**. Turn on **Message Content Intent** and save.
3. If the portal requires a review/approval, complete it; a local flag cannot grant platform access.
4. Put `DOTBOT_MESSAGE_CONTENT=true` in `.env` and `triggers.matchNames=true` in `policy.json`; supply the names.
5. Restart DotBot. It requests `GatewayIntentBits.MessageContent` during identification.

Mention-only mode uses `triggers.matchNames=false` and can use `DOTBOT_MESSAGE_CONTENT=false`. The explicit mention must occur in message text; an inherited reply mention is not enough. A reply-to-bot trigger independently fetches and verifies the referenced author/message/channel/guild after whitelist checks; missing/deleted targets fail closed. Even DMs must address the bot through text or a verified reply. Message edits are not triggers. Name matching can match quoted/code text because it is literal text detection. [Discord’s Gateway reference](https://docs.discord.com/developers/events/gateway) explains intent filtering and privileged access.

If member listing is needed, additionally enable **Server Members Intent** on the same portal page and set `DOTBOT_GUILD_MEMBERS=true`; request approval when Discord requires it. Keep **Presence Intent** off. Administrator does not grant privileged intents.

## Administrator installation guidance

[discord-app.example.json](../discord-app.example.json) is a planning manifest, not a Discord import file or an invite generator. It records **Guild Install**, OAuth scopes `bot` and `applications.commands`, and permission integer string `"8"` for **Administrator**. No installation URL is provided or generated.

When you separately decide to install the bot, use the application’s **Installation** settings (or its OAuth2 URL Generator), choose guild installation, the two scopes above and Administrator, and review the destination guild before completing Discord’s authorization. You must have the authority to install applications there. Keeping the application’s **Public Bot** option disabled can limit installation to its owner; the GitHub repository being public does not require a public Discord application. See [Discord bot authorization](https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow).

Administrator gives broad Discord permissions and bypasses channel overwrites, but not bot role hierarchy, guild ownership, managed-role restrictions, timeout exemptions, user-install differences, privileged intents, endpoint restrictions, rate limits or platform policy. The bot role must outrank roles/members it is allowed to manage. The bot cannot transfer ownership, use user-only APIs or act as a selfbot. Elevated permissions can also depend on Discord’s server-wide 2FA requirements. [Permission hierarchy](https://docs.discord.com/developers/topics/permissions#permission-hierarchy) remains authoritative.

For a smaller installation, start with View Channel, Send Messages, Read Message History and Send Messages in Threads as needed. Add Pin Messages/Add Reactions/Create Threads for those operations; management/moderation/event/expression capabilities need the corresponding permissions. Administrator does not override DotBot’s whitelist, scopes or approval gate.

`discord_command_register` is an approved, confirmed operation, not startup behavior. It creates/updates this bot’s guild `/dot` command with default member permissions `"0"`, so it is admin-only until you explicitly configure a Discord command permission overwrite for a whitelisted user. Discord command permissions and DotBot’s whitelist are separate checks. See [application command permissions](https://docs.discord.com/developers/interactions/application-commands#permissions).

## Run, stop and recover

`npm start` runs one foreground instance. The MCP server only binds to IPv4 loopback. Ctrl+C or SIGTERM destroys the Gateway client, wakes pending polls, closes HTTP connections, aborts webhook work and drains dispatched operations before releasing `.data/runtime.lock`.

A runtime lock prevents a second instance from using the same journal. A crash can leave a stale lock. Confirm the previous process is gone before manually removing **only this project’s** `.data/runtime.lock`. Do not delete the journal to fix a connection problem. Never share one data directory across concurrent instances.

Gateway heartbeat/resume/reconnect and REST bucket/global rate-limit waits come from discord.js. REST network timeouts are 15 seconds; automatic 5xx retries are disabled to avoid blindly replaying mutations. A REST 401 blocks further bridge REST calls until restart. Failures return a sanitized status, not credential-bearing Discord error objects. Invalid intents or login credentials fail startup; no automatic restart service is installed.

`dotbot_status` reports Gateway readiness/reconnection state, scope modes and counts without credentials or whitelist IDs. For unknown mutation outcomes, follow [journal recovery](architecture.md#idempotency-and-recovery).

Optional context capture and official MCP Events are described in [Events and context](mcp-events.md). Context indexing can observe unlisted guild members without authorizing them. Full guild text capture needs the same two Message Content intent switches as name matching. Subscription secrets/outbox data live only in ignored `.data/`; keep those files private and preserve unresolved state during recovery.

[Files and controls](media-and-controls.md) documents the separate media opt-in, `media.read`/`media.write`/`interactions.write` grants, attachment visibility under Message Content, safe client editing handoff and ephemeral controls. Existing policies without the new fields remain media-disabled; merge fields explicitly instead of replacing your whitelist. No upgrade invokes the bot, creates credentials or starts a service.
