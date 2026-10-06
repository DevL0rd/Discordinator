# Get started

This guide takes you from a fresh checkout to your AI answering its first Discord message. The setup app does most of the work.

## What you need

- Node.js 22.16 or newer, with npm.
- A Discord application with a bot (see below).
- A public HTTPS domain only if you want an app that connects from the cloud, such as ChatGPT or Claude on the web. Claude Code and Codex work locally without one.

## 1. Prepare the Discord bot

In the [Discord Developer Portal](https://discord.com/developers/applications), create or select your application. On **Bot**, copy its token and turn on **Message Content Intent** (needed for name triggers and readable message text). Complete Discord's approval if it asks. Leave the Server Members and Presence intents off unless you need member features.

Install the bot in your server through **Installation → Guild Install** with the `bot` and `applications.commands` scopes. For a first conversation, View Channel, Send Messages and Read Message History are enough; add Send Messages in Threads if you use threads. [Setup and permissions](setup.md#administrator-installation-guidance) covers Administrator, role hierarchy and extra features.

Turn on **Settings → Advanced → Developer Mode** in Discord so you can copy your own user ID.

## 2. Install and run setup

```sh
git clone https://github.com/DevL0rd/Discordinator.git discordinator
cd discordinator
npm ci --ignore-scripts
npm run setup
```

`npm run setup` opens a full-screen terminal setup app that works with keyboard and mouse. On first run it is a short wizard:

| Step               | What happens                                                                                                                                                                                |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discord            | Paste the bot token (hidden as you type), enter your owner user ID, and pick a first channel from the channels the bot can see. Everything is checked read-only before anything is written. |
| Who answers        | Choose the responder that answers new Discord messages. See [Operator](operator.md#responders).                                                                                             |
| Connect            | Connect your AI. For **Claude Code**, Discordinator installs a local plugin with nothing to sign in to.                                                                                     |
| Background service | Optionally install the background user service so Discordinator starts when you log in.                                                                                                     |

If you quit part-way, setup resumes where you left off. After the wizard you land on the dashboard; [Operator](operator.md) explains every page.

## 3. Run Discordinator

Either run it yourself:

```sh
npm run build
npm start
```

or install the background service from the setup app's **System** page. On Linux this is a systemd user service named `discordinator.service`. Installing it never stops a Discordinator you started by hand.

The responder you pick starts when you save it. Press **p** on the setup app's **Home** page (or use Pause and Start) to pause and resume it.

## 4. Try one request

In your approved channel, mention the bot: `@Discordinator say hello`. You can also use a name trigger such as `disco, say hello` if name triggers are on. Your AI should reply in the same channel.

Requests from Discord are always answered in the channel, thread or DM they came from. If work takes a while, the AI acknowledges first and posts short progress updates there.

If you use **Another MCP app** or a client that polls, give it the [instructions for your AI](connection.md#instructions-for-your-ai).

## Editing files by hand

You normally never need to. If you do, copy the examples once and edit locally:

```sh
cp -n .env.example .env
cp -n policy.example.json policy.json
```

Keep any existing `.env` and `policy.json`. A minimal policy for a first conversation:

```json
{
    "allowedUserIds": ["YOUR_DISCORD_USER_ID"],
    "servers": { "mode": "allowlist", "allowed": ["YOUR_SERVER_ID"], "blocked": [] },
    "channels": { "mode": "allowlist", "allowed": ["YOUR_CHANNEL_ID"], "blocked": [] },
    "scopes": ["messages.write"],
    "triggers": {
        "matchNames": true,
        "names": ["Discordinator", "disco"],
        "replyToBot": true
    }
}
```

Replace the placeholders with real quoted IDs. An empty allowlist allows nothing; switch a mode to `blocklist` to allow everything the bot can access except the blocked IDs. Extra tools need explicit [capability scopes](capabilities.md). See [Configuration](configuration.md) for every field.

## Troubleshooting

| Symptom                            | Check                                                                                                                                                |
| :--------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discordinator will not start       | Real bot token, valid policy, Message Content intent enabled in the portal, free port, complete auth settings. Process environment overrides `.env`. |
| The bot ignores a message          | Your user ID is allowed, the server and channel are allowed, and the message mentions the bot, uses a trigger name or replies to the bot.            |
| No reply arrives                   | The responder is started on **Home**, and the bot has Send Messages in that channel.                                                                 |
| A cloud app cannot connect         | Public domain, HTTPS proxy, allowed Host and OAuth settings. See [Connection](connection.md).                                                        |
| Sensitive action returns a preview | Approve it in Discord with `@Discordinator approve APPROVAL_UUID` from the same person in the same channel.                                          |
| Unknown outcome after a timeout    | Check Discord before retrying; follow [recovery](architecture.md#idempotency-and-recovery).                                                          |
