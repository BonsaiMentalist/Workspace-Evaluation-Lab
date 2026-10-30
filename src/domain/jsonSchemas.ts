/** JSON Schema documents for every lab format, generated from the zod formats so the two can never drift apart. */
import { z } from 'zod';
import { RECORD_SCHEMAS } from './schemas.js';

export type FormatName = keyof typeof RECORD_SCHEMAS;

export const FORMAT_NAMES = Object.keys(RECORD_SCHEMAS) as FormatName[]; // keys of a const object

export const isFormatName = (name: string): name is FormatName => Object.hasOwn(RECORD_SCHEMAS, name);

export function jsonSchemaFor(name: FormatName): Record<string, unknown> {
  const json = z.toJSONSchema(RECORD_SCHEMAS[name], { io: 'input', unrepresentable: 'any' });
  return { $id: `eval-lab/${name}.schema.json`, title: name, ...json };
}
