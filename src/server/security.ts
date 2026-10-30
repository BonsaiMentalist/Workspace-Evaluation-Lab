/**
 * Request-level protections for a local-only app:
 * - Only requests addressed to localhost are served, which blocks DNS
 *   rebinding (a web page making the browser talk to this app under another name).
 * - Every state-changing request must come from the lab's own pages: the
 *   browser's Origin / Sec-Fetch-Site headers are checked, and forms carry a
 *   secret token that other sites cannot read.
 * - Strict security headers: no inline scripts, no framing, no external loads.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { HTTP } from './status.js';

export const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAME_SITE_FETCH: ReadonlySet<string> = new Set(['same-origin', 'none']);
const TOKEN_BYTES = 32;
const PORT_SEPARATOR = ':';
const IPV6_CLOSE = ']';

export const newCsrfToken = (): string => randomBytes(TOKEN_BYTES).toString('hex');

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/** "127.0.0.1:4317" → "127.0.0.1"; "[::1]:4317" → "[::1]"; "localhost" → "localhost". */
export function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith('[')) return lower.slice(0, lower.indexOf(IPV6_CLOSE) + 1);
  const colon = lower.indexOf(PORT_SEPARATOR);
  return colon < 0 ? lower : lower.slice(0, colon);
}

export function localHostOnly(req: Request, res: Response, next: NextFunction): void {
  if (!LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host ?? ''))) {
    res.status(HTTP.misdirected).type('text/plain').send('This lab only answers requests to localhost.');
    return;
  }
  next();
}

function originIsLocal(origin: string): boolean {
  try {
    const url = new URL(origin);
    return LOCAL_HOSTNAMES.has(url.hostname.toLowerCase()) || LOCAL_HOSTNAMES.has(`[${url.hostname.toLowerCase()}]`);
  } catch {
    return false;
  }
}

/** Refuses state-changing requests that a browser reports as coming from another site. */
export function sameOriginWrites(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  const badOrigin = typeof origin === 'string' && origin !== 'null' && !originIsLocal(origin);
  const nullOrigin = origin === 'null';
  const badFetchSite = typeof fetchSite === 'string' && !SAME_SITE_FETCH.has(fetchSite);
  if (badOrigin || nullOrigin || badFetchSite) {
    res.status(HTTP.forbidden).type('text/plain').send('Blocked: this request did not come from the lab’s own pages.');
    return;
  }
  next();
}

export function tokensMatch(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Checks the form's secret token. Runs after the body is parsed (including file uploads). */
export function requireCsrf(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body: unknown = req.body;
    const given = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['_csrf'] : undefined; // form fields are plain values
    if (!tokensMatch(token, given)) {
      res.status(HTTP.forbidden).type('text/plain').send('Blocked: this form is out of date or did not come from the lab. Reload the page and try again.');
      return;
    }
    next();
  };
}
