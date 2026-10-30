/** Builds the local web app. Kept separate from startup so tests can drive it without opening a port. */
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { LifecycleError } from '../domain/cases.js';
import { describeZodError } from '../domain/errors.js';
import { AttachmentError, attachmentPath, mediaTypeForName } from '../storage/attachments.js';
import { StoreError, type LabStore } from '../storage/store.js';
import { ATTACHMENT_MAX_BYTES } from '../domain/schemas.js';
import { PUBLIC_DIR } from '../paths.js';
import { localHostOnly, newCsrfToken, requireCsrf, sameOriginWrites, securityHeaders } from './security.js';
import { NotFoundError, render, type AppContext } from './context.js';
import { bodyOf, text } from './form.js';
import { html, linkButton } from './html.js';
import { HTTP } from './status.js';
import { overviewRoutes } from './pages/overview.js';
import { caseRoutes } from './pages/cases.js';
import { profileRoutes } from './pages/profiles.js';
import { evaluateRoutes } from './pages/evaluate.js';
import { reviewRoutes } from './pages/review.js';
import { compareRoutes } from './pages/compare.js';
import { historyRoutes } from './pages/history.js';
import { observationRoutes } from './pages/observations.js';
import { dataRoutes } from './pages/data.js';

export interface AppOptions {
  readonly store: LabStore;
  readonly csrf?: string;
  readonly owner?: string;
  /** Log one line per request (method, path, status). Never bodies or query strings. */
  readonly log?: boolean;
}

const FORM_BODY_LIMIT = '2mb';
const FORM_PARAMETER_LIMIT = 5000;
const JSON_FILE_LIMIT = 10_485_760;
const MAX_IMAGE_FILES = 10;
const MAX_FORM_FIELDS = 3000;
const MAX_FIELD_BYTES = 1_048_576;
const THEME_COOKIE_MAX_AGE_MS = 31_536_000_000;
const LIGHT = 'light';
const ROOT = '/';
const PROTOCOL_RELATIVE = '//';
const FILE_TOO_LARGE = 'LIMIT_FILE_SIZE';

/** Domain and validation errors carry plain-language messages that are safe to show; anything else is hidden. */
const USER_FACING_ERRORS = [LifecycleError, StoreError, AttachmentError, SyntaxError] as const;

export function createApp(options: AppOptions): express.Express {
  const ctx: AppContext = { store: options.store, csrf: options.csrf ?? newCsrfToken(), owner: options.owner ?? 'Owner' };
  const csrfCheck = requireCsrf(ctx.csrf);
  const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ATTACHMENT_MAX_BYTES, files: MAX_IMAGE_FILES, fields: MAX_FORM_FIELDS, fieldSize: MAX_FIELD_BYTES } });
  const jsonUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: JSON_FILE_LIMIT, files: 1, fields: MAX_FORM_FIELDS, fieldSize: MAX_FIELD_BYTES } });

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(localHostOnly);
  app.use(securityHeaders);
  if (options.log) {
    app.use((req, res, next) => {
      res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode}`));
      next();
    });
  }
  app.use('/static', express.static(PUBLIC_DIR, { dotfiles: 'deny', index: false, fallthrough: false }));
  app.use(sameOriginWrites);
  app.use(express.urlencoded({ extended: true, limit: FORM_BODY_LIMIT, parameterLimit: FORM_PARAMETER_LIMIT }));

  app.post('/theme', csrfCheck, (req, res) => {
    const body = bodyOf(req);
    const back = text(body, 'back');
    // Only same-site paths: "/cases" is fine, "//evil.example" and "https://…" are not.
    const safeBack = back.startsWith(ROOT) && !back.startsWith(PROTOCOL_RELATIVE) ? back : ROOT;
    const theme = text(body, 'theme') === LIGHT ? LIGHT : 'dark';
    res.cookie('theme', theme, { httpOnly: true, sameSite: 'strict', maxAge: THEME_COOKIE_MAX_AGE_MS, path: ROOT });
    res.redirect(HTTP.seeOther, safeBack);
  });

  app.get('/attachments/:store/:name', (req, res) => {
    const path = attachmentPath(String(req.params['store']), String(req.params['name']), ctx.store.attachmentsDir);
    const mediaType = path ? mediaTypeForName(path) : null;
    if (!path || !mediaType) throw new NotFoundError('That image');
    res.type(mediaType).sendFile(path, { dotfiles: 'deny' });
  });

  app.use(overviewRoutes(ctx));
  app.use(caseRoutes(ctx, imageUpload, jsonUpload, csrfCheck));
  app.use(profileRoutes(ctx, jsonUpload, csrfCheck));
  app.use(evaluateRoutes(ctx, imageUpload, jsonUpload, csrfCheck));
  app.use(reviewRoutes(ctx, csrfCheck));
  app.use(compareRoutes(ctx, csrfCheck));
  app.use(historyRoutes(ctx));
  app.use(observationRoutes(ctx, jsonUpload, csrfCheck));
  app.use(dataRoutes(ctx, jsonUpload, csrfCheck));

  app.use((req: Request, _res: Response, next: NextFunction) => next(new NotFoundError(`The page ${req.path}`)));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const { status, message } = describeError(err);
    if (status === HTTP.serverError) console.error(`Error on ${req.method} ${req.path}: ${err instanceof Error ? err.name : 'unknown'}`);
    render(req, res, ctx, {
      title: status === HTTP.notFound ? 'Not found' : 'Something needs attention',
      intro: status === HTTP.notFound ? 'There is nothing at this address.' : 'The last action could not be completed. Nothing was changed.',
      active: 'overview',
      body: html`<div class="alert alert-bad" role="alert">${message}</div><p>${linkButton('/', 'Go to the overview')}</p>`,
    }, status);
  });

  return app;
}

function describeError(err: unknown): { status: number; message: string } {
  if (err instanceof NotFoundError) return { status: HTTP.notFound, message: err.message };
  if (err instanceof ZodError) return { status: HTTP.badRequest, message: describeZodError(err) };
  if (err instanceof multer.MulterError)
    return { status: err.code === FILE_TOO_LARGE ? HTTP.payloadTooLarge : HTTP.badRequest, message: err.code === FILE_TOO_LARGE ? 'That file is too large.' : `The upload was refused (${err.message}).` };
  if (err instanceof SyntaxError) return { status: HTTP.badRequest, message: 'That file is not valid JSON.' };
  if (USER_FACING_ERRORS.some((type) => err instanceof type)) return { status: HTTP.badRequest, message: (err as Error).message }; // every listed type extends Error
  return { status: HTTP.serverError, message: 'Something went wrong inside the lab. Your data was not changed.' };
}
