export const fence = (code: string): string => `\`\`\`sh\n${code.replaceAll('```', "'''").slice(0, 1500)}\n\`\`\``;

export function activityLine(label: string, code?: string): string {
    const line = `-# ${label.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
    return code?.trim() ? `${line}\n${fence(code.trim())}` : line;
}

export function progressPost(activity: boolean, text: string, quietSince: number, intervalSeconds: number): string | undefined {
    if (activity) return text.slice(0, 1900);
    return Date.now() - quietSince >= intervalSeconds * 1000 ? activityLine('Still working on it…') : undefined;
}
