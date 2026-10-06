export async function probeConnection(endpoint: string, request = fetch): Promise<string> {
    try {
        const response = await request(endpoint, {
            method: 'POST',
            signal: AbortSignal.timeout(3000),
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Method': 'initialize' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'discordinator-setup-check', version: '1' },
                },
            }),
        });
        if (response.status === 401) return 'Server reached; client sign-in is still required.';
        if (!response.ok) return `Connection not ready (HTTP ${response.status}). Start Discordinator or check the domain.`;
        return identifiesDiscordinator(await response.text())
            ? 'Discordinator server reached. Client sign-in and automatic wake-ups still need verification in the client.'
            : 'The URL responded, but it did not identify itself as Discordinator. Check the endpoint before connecting.';
    } catch {
        return 'Connection not ready yet. Start Discordinator, then finish the client connection from the dashboard.';
    }
}
function identifiesDiscordinator(text: string): boolean {
    const data =
        text.startsWith('event:') || text.startsWith('data:')
            ? text
                  .split('\n')
                  .find((line) => line.startsWith('data:'))
                  ?.slice(5)
            : text;
    const body = JSON.parse(data ?? '{}') as { result?: { serverInfo?: { name?: string } } };
    return body.result?.serverInfo?.name === 'Discordinator';
}
