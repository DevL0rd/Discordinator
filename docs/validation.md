# Practical validation

`npm run quality` runs the static checks described in [Quality](quality.md). `npm run validate` runs the offline suite with no Discord connection. `npm run validate:banner` checks the README banners in headless Chrome.

Run everything from the project root:

```sh
npm ci --ignore-scripts
npm run setup:spelling
npm run quality
npm run build
npm run validate
npm run validate:banner
npm run validate:connection
npm audit --omit=dev
```

`validate` uses Node assertions, synthetic Discord IDs, mocked Gateway/REST objects and a temporary loopback MCP server. OAuth checks sign disposable fixture JWTs against in-memory keys; no provider or Discord credentials are configured. The temporary directory inside ignored `.data/` and HTTP servers are removed/closed in `finally` blocks. No bot login, invitation, server change, Discord post, external OAuth exchange or durable service is part of validation.

Checked behavior includes:

- Empty/mandatory string whitelist, server/channel allowlist and blocklist rules (empty allowlist allows nothing, blocked IDs always win), migration of older policy files, denied origins/destinations and capability denial.
- Setup app rendering and navigation at 80×24 and 120×40.
- Claude Code session delivery and the Discordinator plugin's tool bridge.
- Connected-app registration reconciliation for the `discordinator` entry, including removal of a legacy `dotbot` entry.
- Whitelist checks before trigger parsing, literal mention/name/alias matching, Unicode/underscore boundaries and escaped alias punctuation.
- No ordinary-message or non-whitelisted-user response, message dedupe, slash deferral/edit gating.
- Captured-event requirements, suppressed mentions, same-author DMs, and owner sends refused outside the server and channel rules or to people who are not approved.
- Journal reload, changed-key-input denial, ambiguous outcomes, capacity rejection, queue loss/expiry/dedupe.
- Real v2 SDK MCP discovery/tool listing/poll/reply against mocks, unauthenticated/wrong-credential/Origin denial, body limits and actor-field spoof rejection.
- Modern 2026-07-28 authenticated discovery/list/subscribe/unsubscribe, disabled all-message denial and schema validation.
- Signed verification challenges, invalid/tampered signatures, stable retry IDs/bytes with fresh signing times, private durable restart, owner/resource revocation, expiration, secret rotation and pending-verification cancellation.
- HTTPS/public-address policy, private/mapped/reserved addresses, DNS validation and pinned lookup/TLS options; callback mocks send no external request.
- Context ingestion from unlisted guild users without triggers, recent/same-user/search selection, truncation/retention/eviction/update/delete and forged-event denial.
- Reply-to-bot author/channel/reference verification after whitelist checks; denied users never fetch references and deleted references fail closed.
- OAuth JWT signature, issuer, audience, expiry, subject allowlist and scope checks using local keys.
- Default configuration fails closed without bearer credentials; unsafe binds, unsupported auth modes, invalid ports and incomplete/non-HTTPS OAuth settings are rejected. Port overrides derive the matching local bearer resource URL.
- Generic OAuth HTTP challenges and both protected-resource metadata paths, exact public Host/Origin checks, real SDK authenticated tool listing/status and missing/wrong-credential denial using disposable local keys. Forwarding and identity headers cannot authorize requests.
- Media upload reservation/expiry/size, canonical ordered chunks, exact retry bytes, SHA-256 sealing, filename/format/MIME/dimension checks and mention-safe source-linked multipart replies.
- Local versus history attachment coverage, latest/exact/filter/pagination selection, cross-channel scope checks, handle/event binding, metadata redaction, deletion, source mutation and revocation during retrieval.
- Fixed CDN host/path, private DNS denial, redirect/size/stream rejection and byte-bound downloads using mocks; no live attachment request is made.
- Actor/application/message/channel/guild/type-bound single-use controls, invalid choices/fields, modal launch before deferral, correlated child response and parent expiry.
- Confirmed role creation/assignment, cross-guild denial and Unicode/custom emoji schemas/routes.

Build, type, quality, mock behavior and banner checks were run locally on Linux. Both production-only and full dependency audits reported zero known advisories at validation time. Canonical serialization matched both baseline implementations in 22 cases; control-byte validation preserved all 32 ASCII control cases and 11 Unicode/custom emoji acceptance/rejection cases passed. This does not establish live Discord permissions, privileged-intent approval, end-to-end public HTTPS/provider OAuth integration, actual platform delivery or Windows/macOS execution. Those require later explicitly authorized integration work with the owner’s credentials and resources.

The original README SVG was rendered and visually inspected as a rasterized asset, with no application UI screenshots. `npm run validate:banner` uses an existing local Chrome (`DISCORDINATOR_CHROME` can select its executable) to check SVG image decoding, animation advancement and zero running animations under reduced motion. It creates a temporary ignored browser profile/cache inside `.data/` and removes them. No browser installation, deployment or GitHub Action is added. The GitHub-rendered README retains the top asset and recommendation picture entries; every linked public repository and dark/light banner URL was checked. Animated SVG rendering depends on the viewer; the static base composition remains readable.

The sole GitHub workflow is **Basic quality**. It runs spelling, 400-line file bounds, zero duplication, formatting, unused-code/dependency detection, TypeScript checks and ESLint's logic/function bounds. Production functions have cognitive complexity at most 15, at most 60 lines and six parameters; the existing cyclomatic limit of 10, nesting four and 35 statements remain. See [quality parity and justified language differences](quality.md) for the pinned Konveyor reference, complete settings and local commands. A green workflow establishes static quality; live Discord behavior requires separately authorized integration work.
