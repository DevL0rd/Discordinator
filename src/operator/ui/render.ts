import React from 'react';
import { Box, Text } from 'ink';
import type { Line } from './canvas.js';

export const h = React.createElement;

export function Frame({ lines }: { lines: Line[] }) {
    return h(
        Box,
        { flexDirection: 'column' },
        ...lines.map((value, row) =>
            h(
                Text,
                { key: row, wrap: 'truncate' },
                ...value.spans.map((item, index) =>
                    h(Text, { key: index, color: item.fg, backgroundColor: item.bg, bold: item.bold }, item.text),
                ),
            ),
        ),
    );
}
