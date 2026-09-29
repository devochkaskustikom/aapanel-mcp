/**
 * aaPanel HTTP client.
 *
 * Two wire details drive this implementation, both taken from the official
 * demo and the API PDF:
 *
 *  1. Authentication is a per-request signature, not a header:
 *         request_token = md5(str(request_time) + md5(api_key))
 *     sent alongside `request_time` as a Unix timestamp in seconds.
 *
 *  2. The panel expects the caller to keep a session cookie across calls
 *     ("In order to ensure the efficiency of the request, please save the
 *     cookie and attach a cookie on each request"), so a single cookie jar is
 *     held in memory for the lifetime of the process.
 *
 * Two API generations exist. v1 (documented in the PDF) answers with the bare
 * payload. v2 (documented by the OpenAPI specs) wraps it in
 * `{ status, timestamp, message }`. `call` unwraps v2 automatically so tool
 * handlers only ever see the payload.
 */

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Agent } from 'node:https';
import { URL } from 'node:url';
import type { PanelConfig } from './config.js';

export type Params = Record<string, string | number | boolean | undefined | null>;

/** aaPanel v2 envelope. v1 responses come back unwrapped and are detected by shape. */
interface V2Envelope {
  status: number | string;
  timestamp?: number;
  message?: unknown;
}

export class AaPanelError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AaPanelError';
  }
}

/** Compute the request signature exactly as the panel expects. */
export function sign(requestTimeSeconds: number, apiKey: string): string {
  const keyHash = createHash('md5').update(apiKey, 'utf8').digest('hex');
  return createHash('md5')
    .update(String(requestTimeSeconds) + keyHash, 'utf8')
    .digest('hex');
}

/** Minimal cookie store: `name=value` pairs keyed by name, per origin. */
class CookieJar {
  private cookies = new Map<string, string>();

  absorb(setCookie: string[] | undefined): void {
    for (const raw of setCookie ?? []) {
      const pair = raw.split(';')[0];
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export class AaPanelClient {
  private readonly base: URL;
  private readonly jar = new CookieJar();
  private readonly agent: Agent | undefined;

  constructor(private readonly config: PanelConfig) {
    this.base = new URL(config.panelUrl);
    if (this.base.protocol === 'https:' && config.allowSelfSigned) {
      this.agent = new Agent({ rejectUnauthorized: false });
    }
  }

  /**
   * Invoke a panel action.
   *
   * @param route  Route prefix, e.g. `/v2/site`. The `action` query parameter
   *               selects the method, matching the panel's URL scheme.
   * @param action Action name, e.g. `AddSite`.
   * @param query  Extra query parameters the route needs. Some actions are
   *               addressed by query as well as by name — `/v2/data?action=getData&table=sites`
   *               is a different endpoint from `/v2/data?action=getData&table=domain` —
   *               so these belong in the URL, not in the form body.
   * @param params Form fields.
   */
  async call(
    route: string,
    action: string,
    params: Params = {},
    query: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(
      `${this.base.pathname.replace(/\/$/, '')}${route}`,
      this.base.origin,
    );
    url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      // Booleans are accepted by the panel as 0/1; stringifying 'false' is
      // what its own front end does and is understood by the v2 endpoints.
      body.set(key, String(value));
    }

    const requestTime = Math.floor(Date.now() / 1000);
    body.set('request_time', String(requestTime));
    body.set('request_token', sign(requestTime, this.config.apiKey));

    const payload = await this.post(url, body);
    return unwrapV2(payload);
  }

  private post(url: URL, body: URLSearchParams): Promise<string> {
    const isHttps = url.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const req = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          agent: this.agent,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body.toString()),
            'user-agent': 'aapanel-mcp/1.0',
            accept: 'application/json, text/plain, */*',
            ...(this.jar.header() ? { cookie: this.jar.header() } : {}),
          },
        },
        (res) => {
          this.jar.absorb(res.headers['set-cookie'] as string[] | undefined);
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 0) >= 400) {
              reject(
                new AaPanelError(
                  `Panel returned HTTP ${res.statusCode} for ${url.pathname}?${url.searchParams.get('action')}. ` +
                    `Check that the API interface is enabled and this host is in the panel's IP whitelist.`,
                  text.slice(0, 500),
                ),
              );
              return;
            }
            resolve(text);
          });
        },
      );

      req.setTimeout(this.config.timeoutMs, () => {
        req.destroy(
          new AaPanelError(
            `Request to the panel timed out after ${this.config.timeoutMs}ms.`,
          ),
        );
      });
      req.on('error', (err) =>
        reject(
          err instanceof AaPanelError
            ? err
            : new AaPanelError(
                `Could not reach the aaPanel at ${this.base.origin}: ${err.message}. ` +
                  'Verify AAPANEL_PANEL_URL and that the panel port is open.',
              ),
        ),
      );
      req.end(body.toString());
    });
  }
}

/**
 * Unwrap the v2 `{status, timestamp, message}` envelope.
 *
 * v1 endpoints answer with the payload directly, and some v1 actions answer
 * with a bare scalar (`0`, `"1"`), so the envelope is only unwrapped when the
 * three expected fields are actually present.
 */
export function unwrapV2(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;

  const trimmed = payload.trim();
  if (trimmed === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON: hand the raw text back so the caller can surface it.
    return trimmed;
  }

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'status' in parsed &&
    'message' in parsed
  ) {
    const env = parsed as V2Envelope;
    // status 0 is success. Non-zero carries an error in `message`.
    if (typeof env.status === 'number' && env.status !== 0) {
      throw new AaPanelError(
        `Panel rejected the request (status ${env.status}): ${stringify(env.message)}`,
        env.message,
      );
    }
    return env.message;
  }

  return parsed;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
