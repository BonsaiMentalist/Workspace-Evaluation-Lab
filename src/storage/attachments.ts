/**
 * Image attachments. An upload is accepted only when its first bytes prove it
 * is a PNG, JPEG or WebP image (the browser's claimed type and the file name
 * are ignored), and only up to the size limit. Stored files are named by
 * their content hash, so a user-supplied name never reaches the file system.
 * SVG is refused because it can carry scripts.
 */
import { writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AttachmentRef } from '../domain/schemas.js';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_NAME } from '../domain/schemas.js';
import { sha256 } from '../domain/hash.js';
import { FIXTURE_IMAGES_DIR } from '../paths.js';

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

type ImageType = 'png' | 'jpg' | 'webp';

interface Signature {
  readonly mediaType: AttachmentRef['mediaType'];
  readonly matches: (bytes: Buffer) => boolean;
}

/** The 8-byte PNG file signature. */
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
/** JPEG files start with a start-of-image marker followed by another marker. */
const JPEG_MAGIC = Buffer.from('ffd8ff', 'hex');
const RIFF = Buffer.from('RIFF', 'ascii');
const WEBP = Buffer.from('WEBP', 'ascii');
const WEBP_TAG_OFFSET = 8;
const WEBP_TAG_END = 12;

const SIGNATURES = {
  png: { mediaType: 'image/png', matches: (b) => b.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) },
  jpg: { mediaType: 'image/jpeg', matches: (b) => b.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC) },
  webp: {
    mediaType: 'image/webp',
    matches: (b) => b.subarray(0, RIFF.length).equals(RIFF) && b.subarray(WEBP_TAG_OFFSET, WEBP_TAG_END).equals(WEBP),
  },
} as const satisfies Record<ImageType, Signature>;

const IMAGE_TYPES = Object.keys(SIGNATURES) as ImageType[]; // keys of a total Record over ImageType
const BYTES_PER_MB = 1_048_576;
const MAX_MB = ATTACHMENT_MAX_BYTES / BYTES_PER_MB;

export function detectImageType(bytes: Buffer): ImageType | null {
  return IMAGE_TYPES.find((type) => SIGNATURES[type].matches(bytes)) ?? null;
}

/** Validates an uploaded image and stores it under its content hash. Storing the same image twice is harmless. */
export async function saveImage(attachmentsDir: string, bytes: Buffer, alt: string): Promise<AttachmentRef> {
  if (!bytes.length) throw new AttachmentError('The image file is empty.');
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw new AttachmentError(`Images can be at most ${MAX_MB} MB.`);
  const type = detectImageType(bytes);
  if (!type) throw new AttachmentError('Only PNG, JPEG and WebP images are accepted (the file’s contents are checked, not its name).');
  const name = `${sha256(bytes.toString('base64'))}.${type}`;
  await writeFile(join(attachmentsDir, name), bytes, { flag: 'w' });
  return { store: 'local', name, mediaType: SIGNATURES[type].mediaType, bytes: bytes.length, alt };
}

/**
 * The file path for a stored attachment, or null when the name is not a
 * plain attachment name or the file does not exist. The resolved path is
 * checked to stay inside its folder, so "../" tricks can't escape it.
 */
export function attachmentPath(store: string, name: string, attachmentsDir: string): string | null {
  const bases: Readonly<Record<string, string>> = { fixture: FIXTURE_IMAGES_DIR, local: attachmentsDir };
  const base = Object.hasOwn(bases, store) ? bases[store] : undefined;
  if (!base || !ATTACHMENT_NAME.test(name)) return null;
  const root = resolve(base);
  const path = resolve(root, name);
  if (!path.startsWith(root + sep)) return null;
  return existsSync(path) && statSync(path).isFile() ? path : null;
}

export function mediaTypeForName(name: string): AttachmentRef['mediaType'] | null {
  const type = IMAGE_TYPES.find((t) => name.endsWith(`.${t}`));
  return type ? SIGNATURES[type].mediaType : null;
}
