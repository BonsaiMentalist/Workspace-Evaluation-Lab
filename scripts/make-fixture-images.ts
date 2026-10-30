/**
 * Writes the synthetic Designer fixture images to `fixtures/images/`.
 *
 * Each image is an original, stylised character figure built from rectangles
 * and circles on a plain background: hat, head, coat with a chest emblem,
 * belt, trousers and boots. The variants differ only in the parts named
 * below, so the Designer cases can ask whether a requested change was made
 * and whether a preserved element survived.
 *
 * Uses only Node built-ins: PNG chunks, a CRC32 implemented here and
 * node:zlib for the image data (raw RGB scanlines, filter byte 0).
 *
 * Run with: npx tsx scripts/make-fixture-images.ts
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT_DIR = join(import.meta.dirname, '..', 'fixtures', 'images');

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const WIDTH = 240;
const HEIGHT = 320;
const BIT_DEPTH = 8;
const COLOR_TYPE_RGB = 2;
const FILTER_NONE = 0;
const IHDR_LENGTH = 13;
const IHDR_HEIGHT_OFFSET = 4;
const IHDR_BIT_DEPTH_OFFSET = 8;
const IHDR_COLOR_TYPE_OFFSET = 9;
const UINT32_BYTES = 4;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

const CRC_POLYNOMIAL = 0xedb88320;
const CRC_INITIAL = 0xffffffff;
const CRC_TABLE_SIZE = 256;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;

/** Standard CRC-32 lookup table (reflected polynomial 0xEDB88320). */
const CRC_TABLE: readonly number[] = Array.from({ length: CRC_TABLE_SIZE }, (_, n) =>
  Array.from({ length: BITS_PER_BYTE }).reduce<number>((c) => (c & 1 ? CRC_POLYNOMIAL ^ (c >>> 1) : c >>> 1), n),
);

function crc32(bytes: Uint8Array): number {
  const crc = bytes.reduce<number>((c, byte) => (CRC_TABLE[(c ^ byte) & BYTE_MASK] ?? 0) ^ (c >>> BITS_PER_BYTE), CRC_INITIAL);
  return (crc ^ CRC_INITIAL) >>> 0;
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(UINT32_BYTES);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

function chunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([uint32(data.length), typed, uint32(crc32(typed))]);
}

function header(width: number, height: number): Buffer {
  const data = Buffer.alloc(IHDR_LENGTH);
  data.writeUInt32BE(width);
  data.writeUInt32BE(height, IHDR_HEIGHT_OFFSET);
  data.writeUInt8(BIT_DEPTH, IHDR_BIT_DEPTH_OFFSET);
  data.writeUInt8(COLOR_TYPE_RGB, IHDR_COLOR_TYPE_OFFSET);
  // Compression, filter and interlace methods stay 0 (the only standard values).
  return data;
}

function encodePng(width: number, height: number, pixelAt: (x: number, y: number) => Buffer): Buffer {
  const scanlines = Array.from({ length: height }, (_, y) =>
    Buffer.concat([Buffer.from([FILTER_NONE]), ...Array.from({ length: width }, (_, x) => pixelAt(x, y))]),
  );
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header(width, height)),
    chunk('IDAT', deflateSync(Buffer.concat(scanlines))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** A colour as a 3-byte RGB buffer, written as six hex digits. */
const rgb = (hex: string): Buffer => Buffer.from(hex, 'hex');

const BACKGROUND = rgb('efe9dc');
const FLOOR = rgb('d8cfbb');
const HAT = rgb('3b2f4a');
const HAT_BAND = rgb('8a6fa8');
const SKIN = rgb('e6c09c');
const EYE = rgb('2a2324');
const COAT_GREEN = rgb('2f7d4a');
const COAT_BLUE = rgb('2f5d9e');
const BELT = rgb('5a3b22');
const BUCKLE = rgb('c9a54a');
const TROUSERS = rgb('4a4a52');
const BOOTS_BLACK = rgb('231f20');
const BOOTS_RED = rgb('b3262d');
const EMBLEM_GOLD = rgb('e2b33c');
const EMBLEM_CENTRE = rgb('7a3e12');

interface Shape {
  readonly color: Buffer;
  readonly contains: (x: number, y: number) => boolean;
}

function rect(left: number, top: number, width: number, height: number, color: Buffer): Shape {
  return { color, contains: (x, y) => x >= left && x < left + width && y >= top && y < top + height };
}

function circle(cx: number, cy: number, radius: number, color: Buffer): Shape {
  return { color, contains: (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius };
}

// Figure layout (pixels). The figure is centred on CENTRE_X.
const CENTRE_X = 120;
const FLOOR_TOP = 292;
const HAT_CROWN_LEFT = 96;
const HAT_CROWN_TOP = 8;
const HAT_CROWN_WIDTH = 48;
const HAT_CROWN_HEIGHT = 34;
const HAT_BAND_TOP = 32;
const HAT_BAND_HEIGHT = 6;
const HAT_BRIM_LEFT = 80;
const HAT_BRIM_TOP = 40;
const HAT_BRIM_WIDTH = 80;
const HAT_BRIM_HEIGHT = 7;
const HEAD_CENTRE_Y = 68;
const HEAD_RADIUS = 23;
const EYE_OFFSET_X = 8;
const EYE_Y = 66;
const EYE_RADIUS = 3;
const NECK_LEFT = 112;
const NECK_TOP = 88;
const NECK_WIDTH = 16;
const NECK_HEIGHT = 12;
const COAT_LEFT = 80;
const COAT_TOP = 98;
const COAT_WIDTH = 80;
const COAT_HEIGHT = 130;
const ARM_WIDTH = 18;
const HAND_INSET = 9;
const ARM_TOP = 102;
const ARM_HEIGHT = 98;
const HAND_Y = 206;
const HAND_RADIUS = 9;
const BELT_TOP = 172;
const BELT_HEIGHT = 8;
const BUCKLE_LEFT = 113;
const BUCKLE_WIDTH = 14;
const LEG_WIDTH = 22;
const LEG_TOP = 228;
const LEG_HEIGHT = 50;
const LEFT_LEG_LEFT = 93;
const RIGHT_LEG_LEFT = 125;
const BOOT_WIDTH = 30;
const BOOT_TOP = 270;
const BOOT_HEIGHT = 26;
const LEFT_BOOT_LEFT = 86;
const RIGHT_BOOT_LEFT = 124;
const EMBLEM_X = 140;
const EMBLEM_Y = 128;
const EMBLEM_RADIUS = 11;
const EMBLEM_CENTRE_RADIUS = 5;

interface Outfit {
  readonly file: string;
  readonly coat: Buffer;
  readonly boots: Buffer;
  readonly emblem: boolean;
}

function figure(outfit: Outfit): readonly Shape[] {
  const emblem = outfit.emblem
    ? [circle(EMBLEM_X, EMBLEM_Y, EMBLEM_RADIUS, EMBLEM_GOLD), circle(EMBLEM_X, EMBLEM_Y, EMBLEM_CENTRE_RADIUS, EMBLEM_CENTRE)]
    : [];
  return [
    rect(0, FLOOR_TOP, WIDTH, HEIGHT - FLOOR_TOP, FLOOR),
    rect(COAT_LEFT - ARM_WIDTH, ARM_TOP, ARM_WIDTH, ARM_HEIGHT, outfit.coat),
    rect(COAT_LEFT + COAT_WIDTH, ARM_TOP, ARM_WIDTH, ARM_HEIGHT, outfit.coat),
    circle(COAT_LEFT - HAND_INSET, HAND_Y, HAND_RADIUS, SKIN),
    circle(COAT_LEFT + COAT_WIDTH + HAND_INSET, HAND_Y, HAND_RADIUS, SKIN),
    rect(LEFT_LEG_LEFT, LEG_TOP, LEG_WIDTH, LEG_HEIGHT, TROUSERS),
    rect(RIGHT_LEG_LEFT, LEG_TOP, LEG_WIDTH, LEG_HEIGHT, TROUSERS),
    rect(LEFT_BOOT_LEFT, BOOT_TOP, BOOT_WIDTH, BOOT_HEIGHT, outfit.boots),
    rect(RIGHT_BOOT_LEFT, BOOT_TOP, BOOT_WIDTH, BOOT_HEIGHT, outfit.boots),
    rect(COAT_LEFT, COAT_TOP, COAT_WIDTH, COAT_HEIGHT, outfit.coat),
    rect(COAT_LEFT, BELT_TOP, COAT_WIDTH, BELT_HEIGHT, BELT),
    rect(BUCKLE_LEFT, BELT_TOP, BUCKLE_WIDTH, BELT_HEIGHT, BUCKLE),
    ...emblem,
    rect(NECK_LEFT, NECK_TOP, NECK_WIDTH, NECK_HEIGHT, SKIN),
    circle(CENTRE_X, HEAD_CENTRE_Y, HEAD_RADIUS, SKIN),
    circle(CENTRE_X - EYE_OFFSET_X, EYE_Y, EYE_RADIUS, EYE),
    circle(CENTRE_X + EYE_OFFSET_X, EYE_Y, EYE_RADIUS, EYE),
    rect(HAT_BRIM_LEFT, HAT_BRIM_TOP, HAT_BRIM_WIDTH, HAT_BRIM_HEIGHT, HAT),
    rect(HAT_CROWN_LEFT, HAT_CROWN_TOP, HAT_CROWN_WIDTH, HAT_CROWN_HEIGHT, HAT),
    rect(HAT_CROWN_LEFT, HAT_BAND_TOP, HAT_CROWN_WIDTH, HAT_BAND_HEIGHT, HAT_BAND),
  ];
}

/** Later shapes are drawn over earlier ones. */
function pixelOf(shapes: readonly Shape[]): (x: number, y: number) => Buffer {
  return (x, y) => shapes.reduce((color, shape) => (shape.contains(x, y) ? shape.color : color), BACKGROUND);
}

const OUTFITS: readonly Outfit[] = [
  { file: 'outfit-before.png', coat: COAT_GREEN, boots: BOOTS_BLACK, emblem: true },
  { file: 'outfit-after-requested.png', coat: COAT_BLUE, boots: BOOTS_RED, emblem: true },
  { file: 'outfit-after-partial.png', coat: COAT_BLUE, boots: BOOTS_BLACK, emblem: true },
  { file: 'outfit-after-emblem-lost.png', coat: COAT_BLUE, boots: BOOTS_RED, emblem: false },
];

mkdirSync(OUT_DIR, { recursive: true });
OUTFITS.forEach((outfit) => {
  const path = join(OUT_DIR, outfit.file);
  writeFileSync(path, encodePng(WIDTH, HEIGHT, pixelOf(figure(outfit))));
  console.log(`${outfit.file}\t${statSync(path).size} bytes`);
});
