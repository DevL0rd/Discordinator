# Practical validation

Run from the project root:

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

- Empty/mandatory string whitelist, listed/all scope semantics, denied origins/destinations and capability denial.
- Whitelist checks before trigger parsing, literal mention/name/alias matching, Unicode/underscore boundaries and escaped alias punctuation.
- No ordinary-message or non-whitelisted-user response, message dedupe, ephemeral slash deferral/edit gating.
- Captured-event requirements, suppressed mentions, same-author DMs, and proactive denial without a destination grant.
- Exact sensitive-action previews, same-actor/channel confirmation, mismatched input rejection and successful retry replay.
- Journal reload, changed-key-input denial, ambiguous outcomes, capacity rejection, queue loss/expiry/dedupe.
- Real v2 SDK MCP discovery/tool listing/poll/reply against mocks, unauthenticated/wrong-credential/Origin denial, body limits and actor-field spoof rejection.
- Modern 2026-07-28 authenticated discovery/list/subscribe/unsubscribe, disabled all-message denial and schema validation.
- Signed verification challenges, invalid/tampered signatures, stable retry IDs/bytes with fresh signing times, private durable restart, owner/resource revocation, expiration, secret rotation and pending-verification cancellation.
- HTTPS/public-address policy, private/mapped/reserved addresses, DNS validation and pinned lookup/TLS options; callback mocks send no external request.
- Context ingestion from unlisted guild users without triggers, recent/same-user/search selection, truncation/retention/eviction/update/delete and forged-event denial.
- Reply-to-bot author/channel/reference verification after whitelist checks; denied users never fetch references and deleted references fail closed.
- OAuth JWT signature, issuer, audience, expiry, subject allowlist and scope checks using local keys.
- Token-only default configuration and derived loopback URLs, unsafe bind/host/origin/credential rejection, nonlocal peer/local-address denial and IPv4-only tunnel acceptance.
- Real SDK tunnel tool listing and reply without a DotBot bearer key; public Host, Origin and proxy-header denial; rejection when listener binding is reported as wildcard; preserved Discord whitelist and approval previews.
- Media upload reservation/expiry/size, canonical ordered chunks, exact retry bytes, SHA-256 sealing, filename/format/MIME/dimension checks and mention-safe source-linked multipart replies.
- Local versus history attachment coverage, latest/exact/filter/pagination selection, cross-channel scope checks, handle/event binding, metadata redaction, deletion, source mutation and revocation during retrieval.
- Fixed CDN host/path, private DNS denial, redirect/size/stream rejection and byte-bound downloads using mocks; no live attachment request is made.
- Actor/application/message/channel/guild/type-bound single-use controls, invalid choices/fields, modal launch before deferral, correlated child response and parent expiry. Modal approval-like text cannot confirm sensitive actions.
- Confirmed role creation/assignment, cross-guild denial and Unicode/custom emoji schemas/routes.

Build, type, quality, mock behavior and banner checks were run locally on Linux. Both production-only and full dependency audits reported zero known advisories at validation time. Canonical serialization matched both baseline implementations in 22 cases; control-byte validation preserved all 32 ASCII control cases and 11 Unicode/custom emoji acceptance/rejection cases passed. This does not establish live Discord permissions, privileged-intent approval, end-to-end Secure MCP Tunnel/ChatGPT OAuth, actual platform delivery or Windows/macOS execution. Those require later explicitly authorized integration work with the owner’s credentials and resources.

The original README SVG was rendered and visually inspected as a rasterized asset, with no application UI screenshots. `npm run validate:banner` uses an existing local Chrome (`DOTBOT_CHROME` can select its executable) to check SVG image decoding, animation advancement and zero running animations under reduced motion. It creates a temporary ignored browser profile/cache inside `.data/` and removes them. No browser installation, deployment or GitHub Action is added. The GitHub-rendered README retains the top asset and recommendation picture entries; every linked public repository and dark/light banner URL was checked. Animated SVG rendering depends on the viewer; the static base composition remains readable.

The sole GitHub workflow is **Basic quality**. It runs spelling, 400-line file bounds, zero duplication, formatting, unused-code/dependency detection, TypeScript checks and ESLint's logic/function bounds. Production functions have cognitive complexity at most 15, at most 60 lines and six parameters; the existing cyclomatic limit of 10, nesting four and 35 statements remain. See [quality parity and justified language differences](quality.md) for the pinned Konveyor reference, complete settings and local commands. A green workflow establishes static quality; live Discord behavior requires separately authorized integration work.
