import { claudeModels, codexModels } from '../providers.js';
import { liveSetupStatus } from '../setup-model.js';
import { managedServiceStatus } from '../service-status.js';
import { runtimePresent } from '../status.js';
import { readOperatorConfig } from '../config.js';
import type { Observations } from './model.js';

export async function observations(known?: Pick<Observations, 'codex' | 'claude'>): Promise<Observations> {
    const [live, runtime, active, codex, claude, service] = await Promise.all([
        liveSetupStatus(),
        runtimePresent(),
        readOperatorConfig(),
        known?.codex ?? codexModels(),
        known?.claude ?? claudeModels(),
        managedServiceStatus(),
    ]);
    return { live, runtime, active, codex, claude, service, observedAt: new Date().toISOString() };
}
