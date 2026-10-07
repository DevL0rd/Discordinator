import type { Principal } from '../events/security.js';

export function requireOwner(principal?: Principal): void {
    if (!principal) throw new Error('Authenticated owner required');
}
