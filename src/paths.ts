/** Fixed locations inside the app folder. User data lives only under the data folder. */
import { join, resolve } from 'node:path';

export const APP_ROOT = resolve(import.meta.dirname, '..');
export const FIXTURES_DIR = join(APP_ROOT, 'fixtures');
export const FIXTURE_IMAGES_DIR = join(FIXTURES_DIR, 'images');
export const PUBLIC_DIR = join(APP_ROOT, 'public');
export const SCHEMAS_DIR = join(APP_ROOT, 'schemas');
export const EXAMPLES_DIR = join(APP_ROOT, 'examples');
/** Git-ignored. Override with the EVAL_LAB_DATA_DIR environment variable. */
export const DEFAULT_DATA_DIR = join(APP_ROOT, 'data');
