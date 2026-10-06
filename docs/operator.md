# Operator guide

`npm run setup` opens the Discordinator setup app, a full-screen terminal app that works with keyboard and mouse. The first run is a guided wizard (see [Get started](getting-started.md)); after that it opens straight to the dashboard. `npm run tui` is an alias.

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
| `r` | Refresh |
| `?` | Help |
| `q` | Quit |

## Saving

Every save shows a review of the exact before → after values, with secrets redacted. Settings are validated first, and a private backup is written to `.data/setup-backups`.

Saving a responder makes it the primary one and connects its app if needed; the switch waits for any work in progress to finish. ChatGPT wake-ups are delivered only while ChatGPT is the selected responder, so connected apps never answer twice. The running Discordinator watches its settings files, so responder and policy settings take effect as soon as they are saved. When it runs as the background service, `.env` changes make it restart itself once any work in progress has finished.

## Responders

Exactly one responder answers new Discord messages.

| Responder | Mode ID | How it works |
| :-- | :-- | :-- |
| Claude Code | `claude-session` | One ongoing Claude conversation. Prefers Claude Desktop; see below. |
| Codex | `codex-local` | One ongoing Codex conversation in the shared Codex app-server service on this computer; see below. |
| ChatGPT - Dot | `chatgpt-events` | The Discordinator app in ChatGPT is woken automatically. Needs a public HTTPS domain. |
| ChatGPT · scheduled checks | `chatgpt-poll` | ChatGPT checks for new messages on a schedule you set up in ChatGPT. |
| Another MCP app | `manual-mcp` | Any compatible MCP client; you run it yourself. |

Older saved choices (`claude-local`, `claude-channel`) are migrated to `claude-session` automatically.

### Claude Code

For each Discord message, in order:

1. **The conversation is open** in Claude Desktop or a terminal: the message is pushed into that live session, which wakes and answers in Discord. You can watch it work and chat with it.
2. **Claude Desktop is installed** but the conversation is not running: Discordinator opens it in Claude Desktop (starting the app if needed), waits until it is ready, then pushes the message. The first time, it creates the conversation in your working folder.
3. **Claude Desktop is not installed**, or **Always run in the background** is on: Discordinator answers with Claude Code in the background through the Claude Agent SDK, in one shared conversation. Questions and permission requests go to Discord as buttons.

If a step cannot complete, the message stays queued and the setup app shows why. Nothing else answers in its place.

Messages are pushed through Claude Code's own session inbox, the same mechanism Claude Code uses for messages between your sessions. Claude treats them as coming from outside, not from you, so they can never approve its permission prompts. The live session needs the Discord tools, which the claude.ai connector or the local plugin provides (see Connected apps). **Open in Claude Desktop** opens the conversation at any time.

### Codex

Discordinator connects to the shared Codex app-server service that the Codex command line manages (`codex app-server daemon`), starting it if needed, and keeps one ongoing Discordinator conversation there. Because the conversation lives in that shared service rather than inside Discordinator, other Codex clients attached to it can follow and continue it, for example `codex resume --remote unix://` from a terminal, or the ChatGPT app once the service's remote control is enabled with `codex app-server daemon enable-remote-control`.

If your Codex has no shared service, or **Always run in the background** is on, Discordinator runs a private Codex app-server instead, with one conversation per person and channel. Questions and permission requests go to Discord as buttons in both cases.

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

Enter the **Public domain** as a bare domain such as `bot.example.com` (no `https://`, no path). Discordinator derives the HTTPS MCP and OAuth URLs from it. The separate **MCP endpoint URL** setting for Another MCP app takes a full `https://` URL with path.

Local tools such as the setup app and the Claude plugin reach the runtime with a local key in `.data/local.key`. It is created automatically and kept private. It only works for requests with a `127.0.0.1` or `localhost` Host header, so traffic arriving through a tunnel can never use it.

## Background service

The **System** page installs, starts and removes the background service. On Linux it is a systemd user service named `discordinator.service`. On Windows it starts hidden when you sign in, through your account's startup entries, with no admin rights needed, and logs to `.data/service.log`. It never stops a Discordinator you started by hand.
