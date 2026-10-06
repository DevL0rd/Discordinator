import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Authenticator } from '../src/mcp/auth.js';
import { fakeConfig } from './fixtures.js';

export async function checkAuth(): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const config = {
        ...fakeConfig(),
        DISCORDINATOR_AUTH_MODE: 'oauth' as const,
        DISCORDINATOR_RESOURCE_URL: 'https://discordinator.example/mcp',
        DISCORDINATOR_OAUTH_ISSUER: 'https://issuer.example',
        DISCORDINATOR_OAUTH_JWKS_URL: 'https://issuer.example/jwks',
        DISCORDINATOR_OAUTH_SUBJECTS: 'owner',
    };
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'validation', alg: 'RS256' }] });
    const auth = new Authenticator(config, keys);
    const accepts = (token: string) => auth.accepts({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage);
    const token = (
        scope = 'discordinator:control',
        subject = 'owner',
        audience = config.DISCORDINATOR_RESOURCE_URL,
        issuer = config.DISCORDINATOR_OAUTH_ISSUER,
    ) =>
        new SignJWT({ scope })
            .setProtectedHeader({ alg: 'RS256', kid: 'validation' })
            .setSubject(subject)
            .setAudience(audience)
            .setIssuer(issuer)
            .setIssuedAt()
            .setExpirationTime('1m')
            .sign(privateKey);
    assert.equal(await accepts(await token()), true);
    assert.equal(await accepts(await token('other:scope')), false);
    assert.equal(await accepts(await token('discordinator:control', 'stranger')), false);
    assert.equal(await accepts(await token('discordinator:control', 'owner', 'https://other.example/mcp')), false);
    assert.equal(
        await accepts(await token('discordinator:control', 'owner', config.DISCORDINATOR_RESOURCE_URL, 'https://wrong.example')),
        false,
    );
    assert.equal(await accepts('invalid.signature.value'), false);
    const expired = await new SignJWT({ scope: 'discordinator:control' })
        .setProtectedHeader({ alg: 'RS256', kid: 'validation' })
        .setSubject('owner')
        .setAudience(config.DISCORDINATOR_RESOURCE_URL)
        .setIssuer(config.DISCORDINATOR_OAUTH_ISSUER)
        .setIssuedAt()
        .setExpirationTime(1)
        .sign(privateKey);
    assert.equal(await accepts(expired), false);
    assert.equal(auth.metadata().resource, config.DISCORDINATOR_RESOURCE_URL);
    assert.ok(auth.challenge().includes('resource_metadata='));
    assert.equal(await auth.authenticate({ headers: {} } as IncomingMessage), null, 'Authentication is always required');
}
