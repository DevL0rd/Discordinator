import { messageOperations } from './messages.js';
import { channelOperations } from './channels.js';
import { memberOperations } from './members.js';
import { guildOperations } from './guilds.js';
import { scheduledEventOperations } from './events.js';
import { automodOperations } from './automod.js';

export const operations = [
    ...messageOperations,
    ...channelOperations,
    ...memberOperations,
    ...guildOperations,
    ...scheduledEventOperations,
    ...automodOperations,
];
