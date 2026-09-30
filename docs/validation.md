# Practical validation

Run from the project root:

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run validate
npm run complexity
```

`validate` uses Node assertions, synthetic Discord IDs, mocked Gateway/REST objects and a temporary loopback MCP server. OAuth checks sign disposable fixture JWTs against in-memory keys; no provider or Discord credentials are configured. The temporary directory inside ignored `.data/` and HTTP server are removed/closed in `finally` blocks. No bot login, invitation, server change, Discord post, external OAuth exchange or durable service is part of validation.

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

Build/type/complexity checks were run locally on Linux. The measured maximum cyclomatic complexity is 10 across 526 functions, within the enforced limit of 10. Production-dependency audit reported zero known advisories at build time. This does not establish live Discord permissions, privileged-intent approval, end-to-end ChatGPT OAuth, actual platform delivery or Windows/macOS execution. Those require later explicitly authorized integration work with the owner’s credentials and resources.

The sole GitHub workflow is **Complexity**. It installs the locked dependencies and runs ESLint’s cyclomatic complexity limit of 10, nesting depth of four, 35 statements/function and 90 lines/function. It performs no deployment, bot connection, integration validation, model call or credential operation. A green complexity workflow means those code bounds pass, not that the live bot was exercised.
