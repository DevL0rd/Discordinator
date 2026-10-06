# Bundled owner OAuth

Discordinator can run its portable authorization server on the same loopback listener as MCP. It uses `oidc-provider` and `argon2`, resolved through `package-lock.json`. Use a supported Node LTS release (22.16+). Hosting, TLS termination and the public URL remain operator configuration.

Setting a public domain in the setup app turns it on. The equivalent `.env` is just:

```dotenv
DISCORDINATOR_AUTH_MODE=oauth
DISCORDINATOR_RESOURCE_URL=https://bot.example.com/mcp
DISCORDINATOR_TRUSTED_PROXIES=127.0.0.1,::1
```

Everything else is derived from the domain: the issuer is its origin, the signing keys live at `/oauth/jwks`, its Host and Origin are allowed automatically, and the ChatGPT and Claude callbacks are built in. Only explicitly listed proxy socket IPs may establish HTTPS via `X-Forwarded-Proto: https`. The proxy must overwrite this header, preserve the canonical Host and Authorization, and discard incoming forwarding headers. OAuth ignores forwarded caller identities. Owner forms require the issuer Origin; other supplied Origins are rejected. Keep the listener on loopback and prevent request/body/cookie/Authorization logging at ingress.

Set the sign-in password in the setup app (first-run setup asks for it when you give a public domain, and **Apps → Sign-in password** changes it), or from a terminal:

```sh
npm run oauth:password
```

There is no username: the sign-in page asks only for the password (at least 12 characters, at most 1024 bytes). Only its Argon2id hash is stored, never the password, and it is never accepted from arguments or environment. Discordinator creates its signing and session keys automatically on first start, applies a new password immediately while running, and keeps the same owner identity when the password changes. There is no default credential, recovery endpoint or admin bypass; OAuth startup fails closed until a password is set.

The ignored OAuth directory requires mode 700; keys, enrollment and atomic state files require mode 600 and the current user's ownership. Clients, grants, sessions, interactions, CSRF state and rate budgets survive restart. Keep this directory private and backed up; operate one process per directory. A crash can leave `operation.lock` or `state.json.pending`; inspect the stopped process and backup before manually clearing only stale files. Keys are created once and never regenerated. Key rotation is outside this implementation.

Authorization permits only code flow with mandatory S256 PKCE and exact `discordinator:control` scope/resource. Login authenticates the one enrolled owner. Every authorization requires explicit consent, even with an existing session. Access tokens are RS256 JWTs with `typ=at+jwt`, issuer, owner subject, exact resource audience, `discordinator:control` and a 300-second lifetime. Codes expire after 60 seconds and cannot be replayed; refresh, implicit, password, device and client-credentials grants are unavailable. Existing Discord requester, destination, capability and approval checks still apply.

DCR requires `token_endpoint_auth_method=none` and accepts only public web clients, code response type and authorization-code grants. Redirect URIs must exactly match the configured allowlist. Its default is ChatGPT's stable callback; an operator may list up to four exact official ChatGPT callbacks shown by the host, including legacy `/aip/ID/oauth/callback` URLs. Wildcards, other origins, remote metadata/key URLs, custom IDs, extra scopes and unknown fields are rejected. Registration is limited to ten attempts/minute and 200 persistent clients. Owner login is limited globally to five attempts per fifteen minutes, including successful attempts, with persisted budgets. Signed Secure/HttpOnly/SameSite cookies and single-use interaction CSRF tokens protect owner forms.

Ingress must eventually forward `/mcp`, `/oauth/*`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` and both protected-resource discovery paths. This implementation does not apply ingress, DNS or service changes. Port 8788 remains an optional local deployment example only; see [the preserved laptop note](connection.md#optional-deployment-example-for-this-laptop).

The endpoints follow [official OpenAI authentication](https://developers.openai.com/plugins/build/auth), [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and [oidc-provider configuration](https://github.com/panva/node-oidc-provider/blob/v9.12.2/docs/README.md). The stable ChatGPT callback requires the advertised RFC 9207 issuer parameter, which the provider includes on authorization responses. Select DCR in the host; client metadata document fetching is disabled.

Run the focused checks with an explicit deadline:

```sh
timeout -k 2s 30s npm run validate:oauth
```

They use temporary ignored credentials/state and in-process HTTP handlers with five-second request deadlines. They exercise DCR, PKCE, owner login/consent, CSRF, proxy/Host/Origin boundaries, token claims, expiry/audience/scope rejection, persistence/restart, login rate limiting, unauthenticated MCP rejection and authenticated MCP initialization. They create no public listener and perform no Discord actions.
