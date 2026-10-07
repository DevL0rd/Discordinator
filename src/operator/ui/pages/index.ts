import type { Item, PageId, View } from '../model.js';
import { homeItems } from './home.js';
import { assistantItems } from './assistant.js';
import { discordItems } from './discord.js';
import { appsItems } from './apps.js';
import { memoryItems, systemItems } from './system.js';
import { voiceItems } from './voice.js';

const builders: Record<PageId, (view: View) => Item[]> = {
    home: homeItems,
    assistant: assistantItems,
    discord: discordItems,
    apps: appsItems,
    memory: memoryItems,
    voice: voiceItems,
    system: systemItems,
};

export const pageItems = (page: PageId, view: View): Item[] => builders[page](view);
