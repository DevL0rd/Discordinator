import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';
import { z } from 'zod';

export const fileName = z
    .string()
    .min(1)
    .max(100)
    .refine((value) => /^[\p{L}\p{N}_][\p{L}\p{N}_. -]*\.[a-zA-Z0-9]{1,8}$/u.test(value), 'Invalid file name')
    .refine((value) => !value.includes('..') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(value));
const binary = new Map([
    ['image/png', ['png']],
    ['image/jpeg', ['jpg', 'jpeg']],
    ['image/gif', ['gif']],
    ['image/webp', ['webp']],
    ['application/pdf', ['pdf']],
    ['audio/mpeg', ['mp3']],
    ['audio/ogg', ['ogg']],
    ['audio/wav', ['wav']],
    ['audio/flac', ['flac']],
    ['video/mp4', ['mp4']],
    ['video/webm', ['webm']],
]);
const textual = new Map([
    ['txt', 'text/plain'],
    ['md', 'text/markdown'],
    ['csv', 'text/csv'],
    ['json', 'application/json'],
]);
export const mimeType = z.enum([...binary.keys(), ...textual.values()] as [string, ...string[]]);

export async function inspectFile(bytes: Buffer, name: string, provided?: string): Promise<string> {
    fileName.parse(name);
    const extension = name.split('.').at(-1)!.toLowerCase();
    const detected = await fileTypeFromBuffer(bytes);
    const mime = resolveMime(provided, detected?.mime, extension);
    if (!detected) {
        inspectText(bytes, extension, mime);
        return mime;
    }
    if (detected.mime !== mime || !binary.get(mime)?.includes(extension)) throw new Error('File format, MIME and extension must agree');
    if (mime.startsWith('image/')) inspectImage(bytes);
    return mime;
}

function resolveMime(provided: string | undefined, detected: string | undefined, extension: string): string {
    const mime = provided?.split(';')[0]!.trim().toLowerCase() ?? detected ?? textual.get(extension);
    if (!mime) throw new Error('Unsupported file format');
    return mime;
}

function inspectText(bytes: Buffer, extension: string, mime: string): void {
    if (textual.get(extension) !== mime) throw new Error('Unsupported file format');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if ([...decoded].some((character) => character.charCodeAt(0) < 32 && !'\t\n\r'.includes(character))) {
        throw new Error('Text contains binary control bytes');
    }
    if (extension === 'json') {
        try {
            JSON.parse(decoded);
        } catch {
            throw new Error('Invalid JSON file');
        }
    }
}

function inspectImage(bytes: Buffer): void {
    const { width, height } = imageSize(bytes);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 32_000_000) {
        throw new Error('Image dimensions exceed limits');
    }
}
