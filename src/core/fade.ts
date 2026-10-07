/** How long progress updates stay before they are removed. */
export const fade = { ms: 6000 };

/** Removes a short-lived message later; failures (already gone, no access) are ignored. */
export function fadeLater(remove: () => Promise<unknown>, ms = fade.ms): void {
    setTimeout(() => void remove().catch(() => undefined), ms).unref();
}
