<a id="top"></a>

<p align="center">
  <img alt="DotBot — your Discord bot, within reach of dot. Authenticated MCP through a policy gate." src="docs/media/banner.svg" width="100%">
</p>

<p align="center">
  <a href="https://github.com/DevL0rd/DotBot/actions/workflows/quality.yml"><img alt="Quality" src="https://img.shields.io/github/actions/workflow/status/DevL0rd/DotBot/quality.yml?branch=main&style=for-the-badge&label=quality"></a>
  <img alt="Node.js 22.16+" src="https://img.shields.io/badge/Node.js-22.16%2B-43853d?style=for-the-badge&logo=nodedotjs&logoColor=white">
  <img alt="Headless MCP server" src="https://img.shields.io/badge/MCP-headless-5865f2?style=for-the-badge">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-8a5cd6?style=for-the-badge"></a>
</p>

<h3 align="center">Your Discord bot, within reach of dot.</h3>

<p align="center">
  Bring your dot into Discord: answer requests, share files and help manage your server.<br>
  87 typed MCP tools, a private connection and a Discord whitelist you control.
</p>

## What dot can do

- **Talk where you are.** Reply to addressed requests, send files and images, and offer buttons, selections and forms.
- **Use the context you choose.** Read message history, search bounded context and retrieve attachments for client-side editing.
- **Help run your server.** Manage channels, threads, roles, moderation, polls, scheduled events and AutoMod through explicit capability grants.
- **Keep you in control.** Whitelisted people address the bot; sensitive changes wait for their explicit Discord approval.

DotBot runs headlessly on your computer. Your connected dot provides the reasoning; DotBot provides the Discord tools. Requests are handled while dot is actively polling, or through an explicitly configured supported subscription.

## Quick start

Use Node.js **22.16+** and npm. [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) is the recommended private connection; it uses your OpenAI access and needs no separate identity-provider account.

```sh
git clone https://github.com/DevL0rd/DotBot.git
cd DotBot
npm ci --ignore-scripts
npm run build
```

1. Create `.env` from [.env.example](.env.example) and set your Discord **bot token** locally.
2. Keep your existing `policy.json`, or create one from [policy.example.json](policy.example.json). Add your quoted Discord user ID and the destinations/capabilities you want; the public example allows none.
3. Follow [Connect your dot](docs/getting-started.md) to prepare the Discord bot, run DotBot, point `tunnel-client` at `http://127.0.0.1:8787/mcp`, and select **Connection → Tunnel** in Add Plugin.

The [end-to-end guide](docs/getting-started.md) includes the first request and troubleshooting. Keep the local endpoint private and use a trusted host.

## Reference

| Need | Read |
| :-- | :-- |
| Get connected from start to first reply | [Connect your dot](docs/getting-started.md) |
| Defaults and policy fields | [Configuration](docs/configuration.md) |
| Discord intents, installation and recovery | [Setup and permissions](docs/setup.md) |
| Whitelist, approvals and trust boundary | [Security](docs/security.md) |
| Bearer/OAuth options, MCP protocol and dot handoff | [Connection reference](docs/connection.md) |
| Every tool and its scope | [Capabilities](docs/capabilities.md) |
| Subscriptions and bounded context | [Events and context](docs/mcp-events.md) |
| Attachments and interactive controls | [Files and controls](docs/media-and-controls.md) |
| Internals and uncertain outcomes | [Architecture](docs/architecture.md) |
| Local checks and CI | [Validation](docs/validation.md) · [Quality](docs/quality.md) |

---

<a id="more"></a>

## 🧰 More from DevL0rd

Other Plasma projects made to sit on the same desktop. Click a banner to open it on GitHub.

<p align="center">
  <a href="https://github.com/DevL0rd/Konveyor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/banner-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/banner-light.svg">
      <img alt="Konveyor — scrolling tiling for KDE Plasma" src="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/banner-dark.svg" width="600">
    </picture>
  </a>
  <br>
  <a href="https://github.com/DevL0rd/Konveyor"><b>Konveyor</b></a> · Your windows, on a conveyor belt.
</p>

<p align="center">
  <a href="https://github.com/DevL0rd/RVC-Voice-Changer">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/rvc-voice-changer-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/rvc-voice-changer-light.svg">
      <img alt="RVC Voice Changer — Real-time AI voice changing for Plasma" src="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/rvc-voice-changer-dark.svg" width="600">
    </picture>
  </a>
  <br>
  <a href="https://github.com/DevL0rd/RVC-Voice-Changer"><b>RVC Voice Changer</b></a> · Sound like anyone, in every app.
</p>

<p align="center">
  <a href="https://github.com/DevL0rd/KBoard">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/kboard-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/kboard-light.svg">
      <img alt="KBoard — The on-screen keyboard for Plasma" src="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/kboard-dark.svg" width="600">
    </picture>
  </a>
  <br>
  <a href="https://github.com/DevL0rd/KBoard"><b>KBoard</b></a> · Type, glide and talk, right on your desktop.
</p>

<p align="center">
  <a href="https://github.com/DevL0rd/Android-Daemon">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/android-daemon-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/android-daemon-light.svg">
      <img alt="Android-Daemon — Your Android phone, part of your Plasma desktop" src="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/android-daemon-dark.svg" width="600">
    </picture>
  </a>
  <br>
  <a href="https://github.com/DevL0rd/Android-Daemon"><b>Android-Daemon</b></a> · Your phone, right on your desktop.
</p>

<p align="center">
  <a href="https://github.com/DevL0rd/Syncthing-Monitor">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/syncthing-monitor-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/syncthing-monitor-light.svg">
      <img alt="Syncthing Monitor — Syncthing, live in your Plasma panel" src="https://raw.githubusercontent.com/DevL0rd/Konveyor/main/docs/media/more/syncthing-monitor-dark.svg" width="600">
    </picture>
  </a>
  <br>
  <a href="https://github.com/DevL0rd/Syncthing-Monitor"><b>Syncthing Monitor</b></a> · Your sync, at a glance.
</p>




---

<p align="center">Released under the <a href="LICENSE">MIT license</a>.</p>
<p align="center"><a href="#top">Back to top ⬆</a></p>
