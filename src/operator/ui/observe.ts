import { claudeModels, codexModels } from '../providers.js';
import { liveSetupStatus } from '../setup-model.js';
import { managedServiceStatus } from '../service-status.js';
import { runtimePresent } from '../status.js';
import type { Observations } from './model.js';

export async function observations(known?: Pick<Observations, 'codex' | 'claude'>): Promise<Observations> {
    const [live, runtime, codex, claude, service] = await Promise.all([
        liveSetupStatus(),
        runtimePresent(),
        known?.codex ?? codexModels(),
        known?.claude ?? claudeModels(),
        managedServiceStatus(),
    ]);
    return { live, runtime, codex, claude, service, observedAt: new Date().toISOString() };
}
