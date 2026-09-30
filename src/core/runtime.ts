import { mkdir, open, unlink } from 'node:fs/promises';

export async function acquireRuntime(): Promise<() => Promise<void>> {
  await mkdir('.data', { recursive: true, mode: 0o700 });
  const file = '.data/runtime.lock';
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch { throw new Error('Runtime lock exists or is inaccessible; inspect the previous instance before removing it'); }
  try { await handle.writeFile(String(process.pid)); }
  catch (error) { await handle.close(); await unlink(file); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    await unlink(file);
  };
}
