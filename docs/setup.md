# Setup and permissions

Start with [Get started](getting-started.md); the setup app (`discordinator`) handles the files below for you. Installing dependencies alone does not acquire credentials, configure OAuth, install a Discord application or start a service.

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

Skip either copy if that local file already exists. Preserve your configured policy and whitelist. No credentials are supplied with the project.

Set a real **bot** credential locally. Never use a user account token. Configure your public HTTPS resource and OAuth provider, or an independent credential for a local bearer client, as described in [connection](connection.md). Placeholder bot credentials are rejected.

Responder and policy settings saved from the setup app are picked up live. When Discordinator runs as the background service, `.env` changes make it restart itself once idle. Node’s `--env-file=.env` reads the environment file; existing process environment values take precedence. Always run from the project directory so relative policy and journal paths resolve there.

## Policy

See [configuration](configuration.md#policy-defaults) for every policy field and default. Keep the whitelist exact and capability grants deliberate.

To avoid listing IDs, set `servers.mode` and `channels.mode` to `blocklist`. This allows every current and future server and channel the bot can access, except IDs in `blocked`. Blocked IDs always win, and an empty allowlist allows nothing. The whitelist stays exact and mandatory. Capability scopes stay explicit. Approved event provenance still constrains each mutation. The authenticated `discord_guilds_list` tool can discover guild IDs; `discord_channels_list` can discover channels. Discord permissions can make otherwise approved resources inaccessible.

DM origins bypass server/channel rules because they have no guild, but still require a whitelisted author and an explicit trigger. Guild-only operations do not work on a DM. Owner messages sent with `discord_send` can go to any guild channel permitted by the server and channel rules, or to an approved person's DM; there is no separate list.

In allowlist mode, a newly created channel or thread is **not** automatically added. Add its ID before using it. Blocklist mode includes it if Discord permits access.

## Gateway intents

The baseline is `Guilds`, `GuildMessages` and `DirectMessages`, with the channel partial needed for DMs. No presence, typing, reaction or member-event listener is registered.

For the default Message Content intent and name/alias triggers:

1. Open the [Developer Portal](https://discord.com/developers/applications) and select your application.
2. On **Bot**, find **Privileged Gateway Intents**. Turn on **Message Content Intent** and save.
3. If the portal requires a review/approval, complete it; a local flag cannot grant platform access.
4. Keep the default `DISCORDINATOR_MESSAGE_CONTENT=true` (no environment entry is needed) and keep the default `triggers.matchNames=true`; supply the names. The public policy already enables `Discordinator`/`disco` aliases.
5. Restart Discordinator after changing intents in the Developer Portal. It requests `GatewayIntentBits.MessageContent` during identification.

Mention-only mode uses `triggers.matchNames=false` and can use `DISCORDINATOR_MESSAGE_CONTENT=false`. The explicit mention must occur in message text; an inherited reply mention is not enough. A reply-to-bot trigger independently fetches and verifies the referenced author/message/channel/guild after whitelist checks; missing/deleted targets fail closed. Even DMs must address the bot through text or a verified reply. Message edits are not triggers. Name matching can match quoted/code text because it is literal text detection. [Discord’s Gateway reference](https://docs.discord.com/developers/events/gateway) explains intent filtering and privileged access.

Also enable **Server Members Intent** on the same portal page: Discordinator sees server members by default (`DISCORDINATOR_GUILD_MEMBERS=true`). Set it to `false` if you leave that intent off; request approval when Discord requires it. Keep **Presence Intent** off. Administrator does not grant privileged intents. Discordinator also requests the non-privileged Guild Voice States intent so it can follow who is in voice calls; nothing needs enabling in the portal for it.

## Administrator installation guidance

[discord-app.example.json](../discord-app.example.json) is a planning manifest, not a Discord import file or an invite generator. It records **Guild Install**, OAuth scopes `bot` and `applications.commands`, and permission integer string `"8"` for **Administrator**. No installation URL is provided or generated.

When you separately decide to install the bot, use the application’s **Installation** settings (or its OAuth2 URL Generator), choose guild installation, the two scopes above and Administrator, and review the destination guild before completing Discord’s authorization. You must have the authority to install applications there. Keeping the application’s **Public Bot** option disabled can limit installation to its owner; the GitHub repository being public does not require a public Discord application. See [Discord bot authorization](https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow).

Administrator gives broad Discord permissions and bypasses channel overwrites, but not bot role hierarchy, guild ownership, managed-role restrictions, timeout exemptions, user-install differences, privileged intents, endpoint restrictions, rate limits or platform policy. The bot role must outrank roles/members it is allowed to manage. The bot cannot transfer ownership, use user-only APIs or act as a selfbot. Elevated permissions can also depend on Discord’s server-wide 2FA requirements. [Permission hierarchy](https://docs.discord.com/developers/topics/permissions#permission-hierarchy) remains authoritative.

For a smaller installation, start with View Channel, Send Messages, Read Message History and Send Messages in Threads as needed. Add Pin Messages/Add Reactions/Create Threads for those operations, and Connect/Speak for [voice calls](voice.md); management/moderation/event/expression capabilities need the corresponding permissions. Administrator does not override Discordinator’s whitelist, scopes or approval gate.

`discord_command_register` is an explicit operation, not startup behavior. It creates/updates this bot’s guild `/discordinator` command with default member permissions `"0"`, so it is admin-only until you explicitly configure a Discord command permission overwrite for a whitelisted user. Discord command permissions and Discordinator’s whitelist are separate checks. See [application command permissions](https://docs.discord.com/developers/interactions/application-commands#permissions).

## Run, stop and recover

`npm start` runs one foreground instance. The MCP server only binds to IPv4 loopback. Ctrl+C or SIGTERM destroys the Gateway client, wakes pending polls, closes HTTP connections, aborts webhook work and drains dispatched operations before releasing `.data/runtime.lock`.

A runtime lock prevents a second instance from using the same journal. A crash can leave a stale lock. Confirm the previous process is gone before manually removing **only this project’s** `.data/runtime.lock`. Do not delete the journal to fix a connection problem. Never share one data directory across concurrent instances.

Gateway heartbeat/resume/reconnect and REST bucket/global rate-limit waits come from discord.js. REST network timeouts are 15 seconds; automatic 5xx retries are disabled to avoid blindly replaying mutations. A REST 401 blocks further bridge REST calls until the bot token is replaced, which applies without a restart. Failures return a sanitized status, not credential-bearing Discord error objects. Invalid intents or login credentials fail startup; the background service is optional and installed only from the setup app's **System** page.

`discordinator_status` reports Gateway readiness/reconnection state, scope modes and counts without credentials or whitelist IDs. For unknown mutation outcomes, follow [journal recovery](architecture.md#idempotency-and-recovery).

Optional context capture and official MCP Events are described in [Events and context](mcp-events.md). Context indexing can observe unlisted guild members without authorizing them. Full guild text capture needs the Message Content intent in both the runtime and Discord portal as name matching. Subscription secrets/outbox data live only in ignored `.data/`; keep those files private and preserve unresolved state during recovery.

[Files and controls](media-and-controls.md) documents the media settings (on by default), `media.read`/`media.write`/`interactions.write` grants, attachment visibility under Message Content, safe client editing handoff and ephemeral controls. Policies without the media fields get media on; merge fields explicitly instead of replacing your whitelist. No upgrade invokes the bot, creates credentials or starts a service.
