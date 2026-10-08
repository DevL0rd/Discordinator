# Operator guide

`discordinator` opens the Discordinator setup app, a full-screen terminal app that works with keyboard and mouse. Before Discordinator is installed, run `npm run discordinator` from the folder you cloned. The first run is a guided wizard (see [Get started](getting-started.md)); after that it opens straight to the dashboard.

## Pages

| Page | What it is for |
| :-- | :-- |
| Home | Live pipeline (Discord → Discordinator → your AI), start or pause, things that need your attention and recent activity |
| Responder | Choose the primary responder and edit its settings |
| Discord | The bot, approved people, servers and channels (allowlist or blocklist, with a plain-English summary of where it works), abilities and triggers |
| Apps | Web connectors for claude.ai and ChatGPT, and your public address |
| Memory & media | Recent-message context and attachments |
| System | Background service, ChatGPT events, advanced settings and backups |

## Keys

| Key | Action |
| :-- | :-- |
| Arrows, `j` / `k` | Move |
| `←` / `→`, Tab | Switch between the menu and the page |
| Enter, Space | Open or toggle |
| `1`–`6` | Jump to a page |
| `s` | Review and save |
| `/` | Find any setting |
| `p` | Start or pause |
| `r` | Reload settings and status |
| `?` | Help |
| `q` | Quit |

## Saving

Every save shows a review of the exact before → after values, with secrets redacted. Settings are validated first, and a private backup is written to `.data/setup-backups`. If the files are written but a later step fails, such as connecting an app, the save is kept and the problem is shown as a warning.

When a settings file changes outside the setup app, the app reloads it and keeps your unsaved edits on top. Press `r` to reload by hand.

Saving a different responder makes it the primary one, starts it and connects its app if needed; the switch waits for any work in progress to finish. Saving other changes keeps a paused responder paused. Choosing ChatGPT - Dot also allows wake-up events. ChatGPT wake-ups are delivered only while ChatGPT is the selected responder, so connected apps never answer twice. The running Discordinator watches its settings files, so responder and policy settings take effect as soon as they are saved. `.env` changes apply without restarting too: keys and allowed hosts change in place, a new bot token or intent reconnects the bot to Discord, and port or sign-in changes restart only the MCP listener, so conversations and work in progress carry on.

Each request handed to a local assistant starts with a line naming its sender, such as `Discord · #channel · from "DevL0rd" @devl0rd (ID 1022779807186042890) · owner`, and the recent-history lines name their authors the same way. The `owner` tag comes from `ownerUserId` and the ID alone. The owner is also named in the assistant's instructions, along with your custom instructions, and changes to either reach the conversation with the next message; the per-request tag always reflects the current owner.

## Responders

Exactly one responder answers new Discord messages.

| Responder | Mode ID | How it works |
| :-- | :-- | :-- |
| Claude Code | `claude-session` | One ongoing Claude conversation. Prefers Claude Desktop; see below. |
| Codex | `codex-local` | One ongoing Codex conversation in the shared Codex app-server service on this computer; see below. |
| ChatGPT - Dot | `chatgpt-events` | The Discordinator app in ChatGPT is woken automatically. Needs a public HTTPS domain; see below. |
| Another MCP app | `manual-mcp` | Any compatible MCP client; you run it yourself. Its card shows the address to connect to and how to sign in. |

Older saved choices (`claude-local`, `claude-channel`) are migrated to `claude-session` automatically, and `chatgpt-poll` shows as ChatGPT - Dot.

### Claude Code

For each Discord message, in order:

1. **The conversation is open** in Claude Desktop or a terminal: the message is pushed into that live session, which wakes and answers in Discord. You can watch it work and chat with it.
2. **Claude Desktop is installed** but the conversation is not running: Discordinator opens it in Claude Desktop (starting the app if needed), waits until it is ready, then pushes the message. The first time, it creates the conversation in your working folder.
3. **Claude Desktop is not installed**, or **Always run in the background** is on: Discordinator answers with Claude Code in the background through the Claude Agent SDK, in one shared conversation. Questions and permission requests go to Discord as buttons.

If a step cannot complete, the message stays queued and the setup app shows why. Nothing else answers in its place.

Messages are pushed through Claude Code's own session inbox, the same mechanism Claude Code uses for messages between your sessions. Claude treats them as coming from outside, not from you, so they can never approve its permission prompts. The live session needs the Discord tools, which the local plugin provides (see [Local responders](#local-responders)). **Open in Claude Desktop** opens the conversation at any time.

### Codex

Discordinator connects to the shared Codex app-server service that the Codex command line manages (`codex app-server daemon`), starting it if needed, and keeps one ongoing Discordinator conversation there. Because the conversation lives in that shared service rather than inside Discordinator, other Codex clients attached to it can follow and continue it, for example `codex resume --remote unix://` from a terminal, or the ChatGPT app once the service's remote control is enabled with `codex app-server daemon enable-remote-control`.

If your Codex has no shared service, or **Always run in the background** is on, Discordinator runs a private Codex app-server instead. It is still one conversation for everyone, never split per person, channel or server. Questions and permission requests go to Discord as buttons in both cases.

### ChatGPT - Dot

Its card lists what it needs, each with a check mark: a public domain and a sign-in password (Apps page), the ChatGPT (web) connector, wake-up events allowed, and a ChatGPT chat that turned on wake-ups. **ChatGPT connector guide** walks you through the connector and wake-ups.

## Discordinator as the manager

A local responder is told to act as the manager of the work on your computer, not just a chat. It does quick things itself: questions, lookups, short Discord actions, small edits. Big or long work, such as multi-step coding, research, builds or debugging, it hands to a separate conversation in its own app, with a title and a full brief: who started it and for which Discord request, the goal, context and what done looks like. That conversation works on its own and reports back to the responder, not to Discord: milestones, questions and its result. The responder decides what the requester needs to hear and tells them in its own words, so Discord hears one voice. A new conversation posts in Discord itself only when someone explicitly asked for that. Before starting one it checks what is already running and sends a follow-up to a conversation already on that work instead. When you ask how something is going, it looks up the other conversations before answering.

| Responder | How it manages work |
| :-- | :-- |
| Claude Code in Claude Desktop | With Claude's own tools: Claude Desktop's session tools to start, list and message sessions, and `claude --bg` and `claude agents` for background agents. New chats are given the Discordinator conversation's session ID and report to it by message. **Model for new chats** and **Thinking for new chats** set how they run. The Discordinator conversation gets these instructions with its next message. |
| Claude Code in the background, or Codex | With its built-in `start_task`, `list_tasks`, `steer_task` and `cancel_task`: each worker is its own Claude Code conversation or Codex thread, up to two at a time, with permission requests in Discord as buttons. Its result arrives in the responder's conversation as a report, and its latest progress shows in `list_tasks`. A finished worker takes follow-up work and keeps what it knew. The model and thinking or reasoning **for new chats** or **for workers** set how they run. |

## Local responders

Choosing Claude Code or Codex as the responder connects it on this computer, with nothing to sign in to. Its **Discord tools** row on the Responder page shows the status and can repair or disconnect it.

| Responder | What connecting does |
| :-- | :-- |
| Claude Code | Installs a local plugin that gives every Claude Code session, including Claude Desktop, the Discord tools. |
| Codex | Adds a `discordinator` entry to the config of the Codex home your `codex` command uses, pointing at Discordinator on this computer with its local key. |

Connecting only touches the entry named `discordinator`, verifies it, and removes a legacy `dotbot` entry left over from before the rename.

## Web connectors

The Apps page holds the connectors that give Claude and ChatGPT on the web and phone the Discord tools through your public address. They are separate from the responders and are not woken by new messages. Choosing ChatGPT - Dot as the responder walks you through its connector, since its wake-ups need it.

| Connector | How to add it |
| :-- | :-- |
| Claude (web) | Add `https://YOUR-DOMAIN/mcp` as a custom connector in claude.ai and sign in with your Discordinator password. **Open claude.ai** fills it in for you. |
| ChatGPT (web) | Create a connector with `https://YOUR-DOMAIN/mcp` in ChatGPT's Apps & Connectors with Developer mode on, and sign in with your Discordinator password. |

## Domain and local access

Enter the **Public domain** as a bare domain such as `bot.example.com` (no `https://`, no path). Discordinator derives the HTTPS MCP and OAuth URLs from it. Clear it to go back to local-only access; the web connectors then stop working.

Another MCP app connects to `http://127.0.0.1:8787/mcp` (your port) with `Authorization: Bearer` and the key in `.data/local.key`, or, with a public domain, to `https://YOUR-DOMAIN/mcp` and signs in with your Discordinator password.

Local tools such as the setup app and the Claude plugin reach the runtime with a local key in `.data/local.key`. It is created automatically and kept private. It only works for requests with a `127.0.0.1` or `localhost` Host header, so traffic arriving through a tunnel can never use it.

<a id="install"></a>

## Install, update and uninstall

Installing from the wizard, the **System** page or `npm run discordinator -- install` gives Discordinator its own copy, like a normal program:

| | Linux | macOS | Windows |
| :-- | :-- | :-- | :-- |
| Installed copy and settings | `~/.local/share/discordinator` | `~/Library/Application Support/Discordinator` | `%LOCALAPPDATA%\Discordinator` |
| `discordinator` command | `~/.local/bin` | the first of `/opt/homebrew/bin`, `/usr/local/bin` or `~/.local/bin` on your PATH | `%LOCALAPPDATA%\Microsoft\WindowsApps` |
| Background service | systemd user service `discordinator.service` | launchd agent `com.github.devl0rd.discordinator` | hidden startup entry, no admin rights |
| Updates | every system update, plus the Overview page | the Overview page | the Overview page |

The installed copy is a git checkout of the branch you installed from, following GitHub. Nothing runs from the folder you cloned, so you can move or delete it. The first install copies your settings (`.env`, `policy.json`, `discord-app.json` and `.data`) into the installed copy, and the Claude Code plugin is moved there too. Only committed work is installed. Installing again, from any checkout, replaces the installed code and keeps your settings.

`discordinator` with no command opens the setup app on the installed copy, from any folder. It also takes:

| Command | What it does |
| :-- | :-- |
| `discordinator install` | Install or reinstall from the current folder. |
| `discordinator update` | Pull the latest commits from GitHub, rebuild and restart the service. |
| `discordinator uninstall` | Remove the service, the command, the update hook and the code. Your settings stay, so installing again picks them up. |
| `discordinator uninstall --purge` | Also delete your settings. |

**Updates.** The **Overview** page shows when GitHub has new commits; press <kbd>U</kbd> (or choose **Update and restart**) to pull them, rebuild and restart the service. On Linux, Discordinator also hooks into your package manager, like Konveyor: after every pacman, dnf, zypper or apt transaction, `/usr/lib/discordinator/discordinator-update` updates it as you and restarts the service. Adding that hook asks for your password once; installing from the setup app skips it and tells you to run `discordinator install` in a terminal. When Node.js itself is upgraded, the next update reinstalls dependencies for the new version. An installed copy with local changes or commits that are not on GitHub is never overwritten; the update says why it stopped.

The service runs `dist/src/main.js` from the installed copy. On macOS and Windows it logs to `.data/service.log` there. Installing never leaves two copies running: a service that is already running is stopped, moved and started again. **Restart Discordinator** on the **System** page restarts it.
