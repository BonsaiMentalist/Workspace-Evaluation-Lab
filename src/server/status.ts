/** HTTP status codes used by the lab. */
const OK = 200;
const SEE_OTHER = 303;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const PAYLOAD_TOO_LARGE = 413;
const MISDIRECTED = 421;
const SERVER_ERROR = 500;

export const HTTP = {
  ok: OK,
  seeOther: SEE_OTHER,
  badRequest: BAD_REQUEST,
  forbidden: FORBIDDEN,
  notFound: NOT_FOUND,
  conflict: CONFLICT,
  payloadTooLarge: PAYLOAD_TOO_LARGE,
  misdirected: MISDIRECTED,
  serverError: SERVER_ERROR,
} as const;
