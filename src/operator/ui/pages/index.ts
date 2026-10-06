import type { Item, PageId, View } from '../model.js';
import { homeItems } from './home.js';
import { assistantItems } from './assistant.js';
import { discordItems } from './discord.js';
import { appsItems } from './apps.js';
import { memoryItems, systemItems } from './system.js';

const builders: Record<PageId, (view: View) => Item[]> = {
    home: homeItems,
    assistant: assistantItems,
    discord: discordItems,
    apps: appsItems,
    memory: memoryItems,
    system: systemItems,
};

export const pageItems = (page: PageId, view: View): Item[] => builders[page](view);
