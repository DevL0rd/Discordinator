export const scalar = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
