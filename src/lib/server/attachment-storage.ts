import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getStorageDir } from '@/lib/server/audio-storage';

/**
 * File storage for transcript attachments ("attached context"), parallel to
 * the audio store: bytes live under `${MW_STORAGE_DIR}/attachments/`, the DB
 * stores just the generated filename.
 */

export function getAttachmentsDir(): string {
  return path.join(getStorageDir(), 'attachments');
}

export function resolveAttachmentPath(filename: string): string {
  if (filename.includes('/') || filename.includes('..') || filename.includes('\\')) {
    throw new Error(`Refusing unsafe attachment filename: ${filename}`);
  }
  return path.join(getAttachmentsDir(), filename);
}

/** Generate a stored filename keeping a sanitised original extension. */
export function attachmentFilename(originalFilename: string | null): string {
  let ext = '';
  if (originalFilename) {
    const dotIdx = originalFilename.lastIndexOf('.');
    if (dotIdx > 0 && dotIdx < originalFilename.length - 1) {
      ext = originalFilename.substring(dotIdx).toLowerCase();
    }
  }
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = '.bin';
  return `att-${randomUUID()}${ext}`;
}

export async function saveAttachmentBytes(
  filename: string,
  data: Buffer | Uint8Array
): Promise<string> {
  await fsp.mkdir(getAttachmentsDir(), { recursive: true });
  const abs = resolveAttachmentPath(filename);
  await fsp.writeFile(abs, data);
  return abs;
}

export async function deleteAttachmentFile(filename: string): Promise<void> {
  try {
    await fsp.unlink(resolveAttachmentPath(filename));
  } catch {
    // best-effort
  }
}
