import { createHash } from 'node:crypto';

export const peopleRevision = (ids: string[]): string => createHash('sha256').update(JSON.stringify(ids)).digest('hex');
