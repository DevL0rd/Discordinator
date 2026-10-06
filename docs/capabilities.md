# Capability reference

The server exposes 87 tools: six bridge/discovery tools, three context tools, seven media tools, one correlated control tool and 70 fixed Discord operations. This is the implemented surface, not a claim of complete Discord API coverage. Tool discovery returns the exact Zod-derived JSON schemas, defaults and bounds. All unknown input fields are rejected.

## Bridge and discovery tools

| Tool                     | Contract                                                                                                                                            |
| :----------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discordinator_status`   | Connection state, queue epoch, scope modes and counts; no credentials or whitelist IDs                                                              |
| `events_poll`            | Cursor page of up to 25 accepted triggers; bounded 0–20-second wait; epoch/gap/drop reporting                                                       |
| `discord_guilds_list`    | Bounded joined/approved guild discovery; requires `guild.read`; optional snowflake `before`                                                         |
| `discord_respond`        | Original channel/thread/DM reply or ephemeral interaction response; needs live eventId, content and idempotencyKey                                  |
| `discord_dm`             | DM only the captured event author; same controls, no recipient field                                                                                |
| `discord_proactive_send` | Text to an individually granted guild channel; channelId, content, idempotencyKey; requires `messages.write` and a `message.send` destination grant |

All tools must pass the configured MCP access boundary: bearer/OAuth credentials. See [security](security.md). Discord REST reads require their configured scope/resource grants but do not require a Discord trigger. Context reads additionally require a live allowed trigger ID. Writes require a live whitelisted triggering event (except the separately granted proactive send). Every listed mutation additionally requires `eventId` and `idempotencyKey`. Tools marked **Confirm** return a preview when `approvalId` is absent; only a fresh same-user Discord confirmation permits execution. `approvalId` is not a credential or a way to set confirmation from MCP.

Snowflakes and permission bitfields are strings. Message text is bounded to 2,000 characters; read arrays are projected to at most 100 entries. Message history/member/bans/voter pages use bounded limits; `before` on member/voter tools is translated to the endpoint's `after` cursor. Pins use the current timestamp-based API and a maximum of 50 entries. Archived-thread cursors are timestamps. No automatic whole-server scrape or unbounded pagination is provided.

## Messages, reactions and polls

| Tool                          | Scope             | Inputs beyond mutation controls                         | Guard       | Behavior                                                               |
| :---------------------------- | :---------------- | :------------------------------------------------------ | :---------- | :--------------------------------------------------------------------- |
| `discord_messages_list`       | `messages.read`   | `channelId`, `limit`, `before`                          | Read        | Read a bounded page of channel history.                                |
| `discord_message_get`         | `messages.read`   | `channelId`, `messageId`                                | Read        | Read one message.                                                      |
| `discord_pins_list`           | `messages.read`   | `channelId`, `limit`, `before`                          | Read        | Read a bounded page of pinned messages.                                |
| `discord_message_edit`        | `messages.write`  | `channelId`, `messageId`, `content`                     | Trigger     | Edit a message authored by this bot. Mentions stay disabled.           |
| `discord_message_pin`         | `messages.write`  | `channelId`, `messageId`                                | Trigger     | Pin a whitelisted user or bot message.                                 |
| `discord_message_unpin`       | `messages.write`  | `channelId`, `messageId`                                | **Confirm** | Unpin a message with confirmation.                                     |
| `discord_reaction_add`        | `reactions.write` | `channelId`, `messageId`, `emoji`                       | Trigger     | Add a reaction to a whitelisted user or bot message.                   |
| `discord_reaction_remove_own` | `reactions.write` | `channelId`, `messageId`, `emoji`                       | Trigger     | Remove only the bot’s own reaction.                                    |
| `discord_reaction_users`      | `messages.read`   | `channelId`, `messageId`, `emoji`, `limit`, `before`    | Read        | Read a bounded reaction-user page; `before` maps to Discord's `after`. |
| `discord_poll_create`         | `messages.write`  | `channelId`, `poll`                                     | Trigger     | Create a poll in the originating channel.                              |
| `discord_poll_end`            | `messages.write`  | `channelId`, `messageId`                                | **Confirm** | End a bot-authored poll with confirmation.                             |
| `discord_poll_voters`         | `messages.read`   | `channelId`, `messageId`, `answerId`, `limit`, `before` | Read        | Read a bounded page of voters for one answer.                          |

## Channels and threads

| Tool                               | Scope            | Inputs beyond mutation controls                         | Guard       | Behavior                                                                                 |
| :--------------------------------- | :--------------- | :------------------------------------------------------ | :---------- | :--------------------------------------------------------------------------------------- |
| `discord_channel_create`           | `channels.write` | `guildId`, `name`, `type`, `parentId`, `topic`          | **Confirm** | Create a text, voice, category, announcement, stage or forum channel, with confirmation. |
| `discord_channel_edit`             | `channels.write` | `channelId`, `name`, `topic`, `slowmodeSeconds`, `nsfw` | **Confirm** | Change channel name, topic, slowmode or NSFW flag, with confirmation.                    |
| `discord_channel_delete`           | `channels.write` | `channelId`                                             | **Confirm** | Delete a channel or thread, with confirmation.                                           |
| `discord_channel_overwrite_set`    | `channels.write` | `channelId`, `overwriteId`, `type`, `allow`, `deny`     | **Confirm** | Set a typed member/role permission overwrite, with confirmation.                         |
| `discord_channel_overwrite_delete` | `channels.write` | `channelId`, `overwriteId`                              | **Confirm** | Delete a permission overwrite, with confirmation.                                        |
| `discord_thread_create`            | `threads.write`  | `channelId`, `name`, `autoArchiveMinutes`               | Trigger     | Start a public thread from the captured triggering message.                              |
| `discord_forum_post_create`        | `threads.write`  | `channelId`, `name`, `content`, `autoArchiveMinutes`    | Trigger     | Create a forum post in the originating forum channel.                                    |
| `discord_thread_edit`              | `threads.write`  | `channelId`, `archived`, `locked`, `name`               | **Confirm** | Archive, reopen, lock or rename a thread, with confirmation.                             |
| `discord_thread_join`              | `threads.write`  | `channelId`                                             | Trigger     | Join an approved thread as the bot.                                                      |
| `discord_thread_leave`             | `threads.write`  | `channelId`                                             | Trigger     | Leave an approved thread as the bot.                                                     |
| `discord_thread_member_add`        | `threads.write`  | `channelId`, `userId`                                   | **Confirm** | Add a whitelisted user to a thread, with confirmation.                                   |
| `discord_thread_member_remove`     | `threads.write`  | `channelId`, `userId`                                   | **Confirm** | Remove a thread member, with confirmation.                                               |

## Members, roles, moderation and voice

| Tool                           | Scope              | Inputs beyond mutation controls                                             | Guard       | Behavior                                                                                 |
| :----------------------------- | :----------------- | :-------------------------------------------------------------------------- | :---------- | :--------------------------------------------------------------------------------------- |
| `discord_message_delete`       | `moderation.write` | `channelId`, `messageId`                                                    | **Confirm** | Delete one message after explicit Discord confirmation.                                  |
| `discord_messages_bulk_delete` | `moderation.write` | `channelId`, `messageIds`                                                   | **Confirm** | Delete 2–100 messages newer than 14 days, with confirmation.                             |
| `discord_member_get`           | `members.read`     | `guildId`, `userId`                                                         | Read        | Read one member and their role IDs.                                                      |
| `discord_members_list`         | `members.read`     | `guildId`, `limit`, `before`                                                | Read        | Read a bounded member page; Server Members intent is required.                           |
| `discord_member_nickname`      | `members.write`    | `guildId`, `userId`, `nickname`                                             | **Confirm** | Change a member nickname, with confirmation.                                             |
| `discord_member_timeout`       | `moderation.write` | `guildId`, `userId`, `durationSeconds`, `reason`                            | **Confirm** | Set or clear a member timeout, with confirmation. Discord hierarchy applies.             |
| `discord_member_kick`          | `moderation.write` | `guildId`, `userId`, `reason`                                               | **Confirm** | Kick a member, with confirmation. No automatic DM is sent.                               |
| `discord_member_ban`           | `moderation.write` | `guildId`, `userId`, `deleteMessageSeconds`, `reason`                       | **Confirm** | Ban a member, optionally delete up to seven days of messages, with confirmation.         |
| `discord_member_unban`         | `moderation.write` | `guildId`, `userId`, `reason`                                               | **Confirm** | Remove a guild ban, with confirmation.                                                   |
| `discord_bans_list`            | `members.read`     | `guildId`, `limit`, `before`                                                | Read        | Read a bounded list of bans.                                                             |
| `discord_roles_list`           | `roles.read`       | `guildId`                                                                   | Read        | Read guild roles and permission bitfields.                                               |
| `discord_role_create`          | `roles.write`      | `guildId`, `name`, `permissions`, `color`, `hoist`, `mentionable`           | **Confirm** | Create a role, including explicit permission bits, with confirmation.                    |
| `discord_role_edit`            | `roles.write`      | `guildId`, `roleId`, `name`, `permissions`, `color`, `hoist`, `mentionable` | **Confirm** | Edit a role or its permissions, with confirmation.                                       |
| `discord_role_delete`          | `roles.write`      | `guildId`, `roleId`                                                         | **Confirm** | Delete a role, with confirmation.                                                        |
| `discord_role_position`        | `roles.write`      | `guildId`, `roleId`, `position`                                             | **Confirm** | Move a role in the hierarchy, with confirmation.                                         |
| `discord_member_role_add`      | `roles.write`      | `guildId`, `userId`, `roleId`                                               | **Confirm** | Assign a guild role, with confirmation.                                                  |
| `discord_member_role_remove`   | `roles.write`      | `guildId`, `userId`, `roleId`                                               | **Confirm** | Remove a member role, with confirmation.                                                 |
| `discord_voice_member_edit`    | `voice.write`      | `guildId`, `userId`, `channelId`, `mute`, `deaf`                            | **Confirm** | Move, disconnect, mute or deafen a member, with confirmation; no audio capture/playback. |

## Guild administration, commands, invites and discovery

| Tool                       | Scope            | Inputs beyond mutation controls                       | Guard       | Behavior                                                                                            |
| :------------------------- | :--------------- | :---------------------------------------------------- | :---------- | :-------------------------------------------------------------------------------------------------- |
| `discord_channels_list`    | `guild.read`     | `guildId`                                             | Read        | List approved channels in a guild.                                                                  |
| `discord_channel_get`      | `guild.read`     | `channelId`                                           | Read        | Read channel metadata.                                                                              |
| `discord_threads_active`   | `guild.read`     | `guildId`                                             | Read        | List approved active guild threads.                                                                 |
| `discord_threads_archived` | `guild.read`     | `channelId`, `limit`, `before`                        | Read        | Read a bounded page of public archived threads.                                                     |
| `discord_guild_get`        | `guild.read`     | `guildId`                                             | Read        | Read guild metadata and approximate counts.                                                         |
| `discord_guild_edit`       | `guild.write`    | `guildId`, `name`, `description`, `verificationLevel` | **Confirm** | Change guild name, description or verification level, with confirmation.                            |
| `discord_audit_log`        | `audit.read`     | `guildId`, `limit`, `before`, `actionType`            | Read        | Read a bounded page of guild audit entries.                                                         |
| `discord_invites_list`     | `invites.read`   | `channelId`                                           | Read        | Read invites for the approved channel. Invite codes are access-bearing data.                        |
| `discord_invite_create`    | `invites.write`  | `channelId`, `maxAgeSeconds`, `maxUses`, `temporary`  | **Confirm** | Create a bounded channel invite, with confirmation. This is not a bot installation invite.          |
| `discord_invite_delete`    | `invites.write`  | `channelId`, `code`                                   | **Confirm** | Revoke an invite belonging to the specified approved channel, with confirmation.                    |
| `discord_command_register` | `commands.write` | `guildId`                                             | **Confirm** | Register /discordinator with a text option in this guild, with confirmation. No global replacement. |
| `discord_commands_list`    | `guild.read`     | `guildId`                                             | Read        | Read this bot’s guild application commands.                                                         |
| `discord_command_delete`   | `commands.write` | `guildId`, `commandId`                                | **Confirm** | Delete one of this bot’s guild commands, with confirmation.                                         |

## Scheduled events

| Tool                             | Scope          | Inputs beyond mutation controls                                | Guard       | Behavior                                                               |
| :------------------------------- | :------------- | :------------------------------------------------------------- | :---------- | :--------------------------------------------------------------------- |
| `discord_scheduled_events_list`  | `events.read`  | `guildId`                                                      | Read        | Read scheduled guild events.                                           |
| `discord_scheduled_event_create` | `events.write` | `guildId`, `name`, `description`, `start`, `end`, `location`   | **Confirm** | Create an external scheduled event, with confirmation.                 |
| `discord_scheduled_event_edit`   | `events.write` | `guildId`, `scheduledEventId`, `name`, `description`, `status` | **Confirm** | Edit scheduled event text or transition its status, with confirmation. |
| `discord_scheduled_event_delete` | `events.write` | `guildId`, `scheduledEventId`                                  | **Confirm** | Delete a scheduled event, with confirmation.                           |

## Expressions

| Tool                     | Scope               | Inputs beyond mutation controls                       | Guard       | Behavior                                                                     |
| :----------------------- | :------------------ | :---------------------------------------------------- | :---------- | :--------------------------------------------------------------------------- |
| `discord_emojis_list`    | `expressions.read`  | `guildId`                                             | Read        | Read guild emoji metadata.                                                   |
| `discord_emoji_create`   | `expressions.write` | `guildId`, `name`, `image`                            | **Confirm** | Create an emoji from bounded image data, with confirmation; no URL fetching. |
| `discord_emoji_rename`   | `expressions.write` | `guildId`, `emojiId`, `name`                          | **Confirm** | Rename a guild emoji, with confirmation.                                     |
| `discord_emoji_delete`   | `expressions.write` | `guildId`, `emojiId`                                  | **Confirm** | Delete a guild emoji, with confirmation.                                     |
| `discord_stickers_list`  | `expressions.read`  | `guildId`                                             | Read        | Read guild sticker metadata; uploads are not implemented.                    |
| `discord_sticker_edit`   | `expressions.write` | `guildId`, `stickerId`, `name`, `description`, `tags` | **Confirm** | Change a guild sticker’s name, description or tags, with confirmation.       |
| `discord_sticker_delete` | `expressions.write` | `guildId`, `stickerId`                                | **Confirm** | Delete a guild sticker, with confirmation.                                   |

## AutoMod

| Tool                             | Scope           | Inputs beyond mutation controls                                | Guard       | Behavior                                                         |
| :------------------------------- | :-------------- | :------------------------------------------------------------- | :---------- | :--------------------------------------------------------------- |
| `discord_automod_rules_list`     | `automod.read`  | `guildId`                                                      | Read        | Read guild AutoMod rules.                                        |
| `discord_automod_keyword_create` | `automod.write` | `guildId`, `name`, `keywords`, `exemptRoles`, `exemptChannels` | **Confirm** | Create an enabled keyword-block AutoMod rule, with confirmation. |
| `discord_automod_rule_toggle`    | `automod.write` | `guildId`, `ruleId`, `enabled`                                 | **Confirm** | Enable or disable an AutoMod rule, with confirmation.            |
| `discord_automod_rule_delete`    | `automod.write` | `guildId`, `ruleId`                                            | **Confirm** | Delete an AutoMod rule, with confirmation.                       |

## Discord prerequisites

The policy's capabilities are independent of Discord permissions. Discord can deny an operation even when the policy permits it. For channel reads use View Channel/Read Message History; sending requires Send Messages or Send Messages in Threads. Pins require Pin Messages; reactions require Add Reactions when applicable. Manage Messages controls deleting others' messages and bulk deletion; bulk IDs must be unique and less than two weeks old. Discordinator does not use deletion as a means of responding to denied users. See [messages](https://docs.discord.com/developers/resources/message) and [polls](https://docs.discord.com/developers/resources/poll).

Channel/overwrite/thread operations require the corresponding Manage Channels, Manage Roles or thread permissions and appropriate channel types. Forum-post creation needs a forum-channel origin such as a permitted /discordinator invocation, not an ordinary message in a parent text channel. Private thread discovery is incomplete. In allowlist mode, approval of a parent does not approve child thread IDs. See [channels](https://docs.discord.com/developers/resources/channel).

Member listing additionally requires the Server Members privileged intent. Kicks, bans, timeouts, nicknames and role operations remain restricted by ownership/hierarchy/managed roles. Timeout duration is at most 28 days; ban deletion at most seven days. Moderation reasons are sent as Discord audit reasons where supported. Voice-member edits manipulate state only; the bot does not join a voice connection or process audio. See [guild/member operations](https://docs.discord.com/developers/resources/guild) and [permissions](https://docs.discord.com/developers/topics/permissions).

Event tools support external-location creation and text/status updates, with valid future ordered timestamps. Discord enforces event transitions. Expression operations need expression permissions, available guild slots, supported images and sticker access. Emoji creation accepts bounded inline PNG/JPEG/GIF data, not file paths or remote downloads; the size bound does not prove Discord will accept the image. See [scheduled events](https://docs.discord.com/developers/resources/guild-scheduled-event), [emoji](https://docs.discord.com/developers/resources/emoji) and [stickers](https://docs.discord.com/developers/resources/sticker).

AutoMod needs Manage Guild and supports keyword blocking without alert-message or custom explanatory responses. No alert-channel forwarding path is implemented. These confirmed rules are intentional guild-wide moderation policy; their operation can affect non-whitelisted members without treating those members as bot requesters. See [AutoMod](https://docs.discord.com/developers/resources/auto-moderation).

Invites require Create Instant Invite and list/revoke permissions; creation is always bounded to a finite lifetime/use count and requires confirmation. Invite codes are access-bearing results delivered only to the authenticated operator. This is channel-invite management, separate from application installation. Command tools manage only this application's guild commands; /discordinator registration defaults to admin-only and needs a Discord permission overwrite for another whitelisted user. See [application commands](https://docs.discord.com/developers/interactions/application-commands).

## Coverage gaps and deliberate exclusions

There is no unlimited capability, raw REST passthrough or user-account automation. Coverage excludes arbitrary user OAuth endpoints, ownership transfer, friendship/group DMs, mass messaging, arbitrary webhook creation/execution/token access, crossposting/forwarding, automatic member-event replies, role/everyone mention notifications, voice/audio transport, streaming, arbitrary embeds/components/autocomplete/context-menu interactions, arbitrary command registration/permission OAuth, full AutoMod trigger/action editing, sticker uploads, soundboard management, stage instances, guild templates, commerce/entitlements and complete profile customization. Media supports a finite safe format set and client byte handoff; controls support buttons, single-choice string selects and text-input modals. Arbitrary URLs, local paths, HTML/SVG uploads and executable/archive uploads are excluded.

Message-create triggers, this bot's /discordinator slash invocations and verified actor-bound child controls are actionable origins. Non-addressed DMs, reactions, member joins/leaves, edits and unrelated interactions do not produce a response event. General attachment metadata is readable within approved message reads; safe retrieval refreshes a verified source handle and only fetches its fixed Discord CDN path. No supplied URL or filesystem fetch exists. Read objects are projected and may omit API fields; use tool schemas/reference code to assess the exact supported surface.

Administrator cannot make absent tools appear, grant privileged intents or remove Discord's hierarchy/API/policy restrictions. Every operation still needs permissions and a valid resource type. No live Discord integration has been validated in this build; later authorized integration may expose permission, channel-type, quota or API changes requiring an in-scope update.

## Context and official MCP Events

`context_recent`, `context_user` and `context_search` add bounded local context reads with `messages.read` and a live allowed trigger. The webhook event `discord.message.created` has addressed/all filters and authenticated `events/list`, `events/subscribe` and `events/unsubscribe` methods, separate from tools. See [Events and context](mcp-events.md) for schemas, opt-ins, durable lifecycle and honest search/delivery limits. Replies to fetched bot-authored messages also count as addressing; arbitrary references, edits, reactions and observation payloads do not.

## Media, source replies and correlated controls

| Tool                    | Scopes                                                                       | Guard and coverage                                                                                              |
| :---------------------- | :--------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `media_search`          | `media.read`, `messages.read`                                                | Live trigger; newest local attachment/image matches, user/channel/message/time/ID filters, opaque pagination    |
| `media_history`         | `media.read`, `messages.read`                                                | Live trigger; one Discord channel history page or exact message; explicit pagination/truncation references      |
| `media_attachment_read` | `media.read`, `messages.read`                                                | Live trigger/source handle; freshly verified CDN-only bounded chunks; small images also yield MCP image content |
| `media_upload_begin`    | `media.write`, `messages.write`                                              | Live trigger; bounded reservation, filename/MIME/size/SHA-256                                                   |
| `media_upload_chunk`    | `media.write`, `messages.write`                                              | Same event/upload; ordered canonical base64, at most 128 KiB decoded                                            |
| `media_upload_seal`     | `media.write`, `messages.write`                                              | Size/hash/format/dimension verification                                                                         |
| `discord_media_reply`   | `media.write`, `messages.write`; additionally read scopes for source handles | Live trigger/idempotency; up to three sealed files and three verified source links, origin-only reply           |
| `discord_prompt`        | `interactions.write`, `messages.write`                                       | Live trigger/idempotency; single-use actor/source-bound buttons/select/modal launch                             |

See [files and controls](media-and-controls.md) for schemas, format limits, privileged intent, resource/SSRF checks and honest host editing limitations. Sending attachments requires Attach Files as well as channel/thread send permissions. Incoming reads need View Channel/Read Message History and applicable Message Content access. Emoji arguments accept Unicode emoji sequences or `name:snowflake` for a custom emoji; Discord enforces emoji availability and Use External Emojis where applicable. Reactions remain outbound actions, not request triggers.

## Second-release breadth audit

The fixed operation families cover practical conversations, messages/pins/polls/reactions, channel/thread/forum management and overwrites, members/moderation, roles, voice state, guild settings/audit/invites/commands, external scheduled events, expressions and keyword AutoMod. This release fills the deferred file transfer, source-linked reply, attachment lookup/retrieval, correlated control and reaction-user read surfaces. Role creation/assignment already had typed confirmed endpoints; creation now requires a nonempty name and defaults explicitly to permission bits `"0"`, and local validation exercises fresh confirmation, exact bindings and cross-guild denial. Role permissions use string bitfields; managed roles, positions at/above the bot and ownership remain Discord-enforced restrictions. Administrator does not bypass hierarchy or grant a permission the bot cannot manage.

Useful remaining gaps include advanced channel/role attributes, reaction moderation/clear-all, message-global platform search, private-thread discovery, richer scheduled event types, full AutoMod triggers/actions and the explicitly excluded families above. Full-page role/emoji lists can be projected to 100 objects; the API does not provide pagination for every collection. These are deliberate finite schemas, not an undisclosed raw API escape hatch. Capability availability must be established by actual tool discovery plus Discord permissions, not by assuming any absent endpoint exists.
