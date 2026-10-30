/** Writes the documented JSON Schema files in `schemas/` from the zod formats. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAT_NAMES, jsonSchemaFor } from '../src/domain/jsonSchemas.js';
import { SCHEMAS_DIR } from '../src/paths.js';

const INDENT = 2;

mkdirSync(SCHEMAS_DIR, { recursive: true });
FORMAT_NAMES.forEach((name) => writeFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), `${JSON.stringify(jsonSchemaFor(name), null, INDENT)}\n`));
console.log(`Wrote ${FORMAT_NAMES.length} schema files to ${SCHEMAS_DIR}`);
