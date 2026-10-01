import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { IncomingMessage } from 'node:http';
import type { Principal } from '../events/security.js';
import { csv, validateTunnelConfig, type Config } from '../core/config.js';
import { localTunnelRequest } from './local.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

export class Authenticator {
    private readonly verifyJwt;
    constructor(
        readonly config: Config,
        verifyKey?: JWTVerifyGetKey,
    ) {
        if (config.DOTBOT_AUTH_MODE === 'tunnel') validateTunnelConfig(config);
        this.verifyJwt =
            config.DOTBOT_AUTH_MODE === 'oauth'
                ? (verifyKey ?? createRemoteJWKSet(new URL(config.DOTBOT_OAUTH_JWKS_URL!), { timeoutDuration: 5000 }))
                : undefined;
    }

    async accepts(request: IncomingMessage): Promise<boolean> {
        return (await this.authenticate(request)) !== null;
    }

    ownerAllowed = (id: string): boolean => {
        if (this.config.DOTBOT_AUTH_MODE === 'tunnel') return id === 'tunnel:local';
        if (this.config.DOTBOT_AUTH_MODE === 'bearer') return id === `bearer:${digest(this.config.DOTBOT_MCP_TOKEN!).toString('hex')}`;
        return csv(this.config.DOTBOT_OAUTH_SUBJECTS).some((subject) => id === this.oauthOwner(subject));
    };

    async authenticate(request: IncomingMessage): Promise<Principal | null> {
        if (this.config.DOTBOT_AUTH_MODE === 'tunnel') return localTunnelRequest(request, this.config) ? { id: 'tunnel:local' } : null;
        const header = request.headers.authorization ?? '';
        const match = /^Bearer ([^\s]{1,8192})$/.exec(header);
        if (!match?.[1]) return null;
        if (this.config.DOTBOT_AUTH_MODE === 'bearer') {
            if (!timingSafeEqual(digest(match[1]), digest(this.config.DOTBOT_MCP_TOKEN!))) return null;
            return { id: `bearer:${digest(this.config.DOTBOT_MCP_TOKEN!).toString('hex')}` };
        }
        return this.authenticateOauth(match[1]);
    }

    private async authenticateOauth(token: string): Promise<Principal | null> {
        try {
            const { payload } = await jwtVerify(token, this.verifyJwt!, {
                issuer: this.config.DOTBOT_OAUTH_ISSUER!,
                audience: this.config.DOTBOT_RESOURCE_URL!,
                algorithms: ['RS256', 'ES256'],
                requiredClaims: ['exp', 'iat', 'sub'],
            });
            if (!csv(this.config.DOTBOT_OAUTH_SUBJECTS).includes(payload.sub!)) return null;
            if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes('dotbot:control')) return null;
            return { id: this.oauthOwner(payload.sub!), expiresAt: payload.exp! * 1000 };
        } catch {
            return null;
        }
    }

    private oauthOwner(subject: string): string {
        return `oauth:${digest(JSON.stringify([this.config.DOTBOT_OAUTH_ISSUER, subject])).toString('hex')}`;
    }

    challenge(): string {
        if (this.config.DOTBOT_AUTH_MODE !== 'oauth') return 'Bearer realm="DotBot"';
        const metadata = new URL('/.well-known/oauth-protected-resource', this.config.DOTBOT_RESOURCE_URL!).href;
        return `Bearer resource_metadata="${metadata}", scope="dotbot:control"`;
    }

    metadata() {
        return {
            resource: this.config.DOTBOT_RESOURCE_URL,
            authorization_servers: [this.config.DOTBOT_OAUTH_ISSUER],
            scopes_supported: ['dotbot:control'],
            bearer_methods_supported: ['header'],
        };
    }
}
