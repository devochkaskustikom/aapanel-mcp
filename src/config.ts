/**
 * Runtime configuration.
 *
 * Precedence: environment variable > config file > built-in default.
 * The API key is never logged and never returned in any tool output.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PanelConfig {
  /** Panel base URL, e.g. https://panel.example.com:8888 */
  panelUrl: string;
  /** API interface key from Settings -> API in the aaPanel UI. */
  apiKey: string;
  /**
   * When true, every tool that mutates panel state is refused before a
   * request is ever sent. Safe default for unattended agents.
   */
  readOnly: boolean;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Allow a self-signed panel TLS certificate. */
  allowSelfSigned: boolean;
  /**
   * Allow the destructive / privileged endpoints that are not a normal part
   * of day-to-day panel use (MySQL root password reset, panel self-update,
   * writing raw files). Off by default.
   */
  allowDangerous: boolean;
}

export const DEFAULTS = {
  panelUrl: 'http://127.0.0.1:8888',
  readOnly: true,
  timeoutMs: 60_000,
  allowSelfSigned: false,
  allowDangerous: false,
} as const;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Strip trailing slashes so URL joining stays predictable. */
export function normalizePanelUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

type FileConfig = Partial<{
  panelUrl: string;
  apiKey: string;
  readOnly: boolean;
  timeoutMs: number;
  allowSelfSigned: boolean;
  allowDangerous: boolean;
}>;

function readConfigFile(): FileConfig {
  const explicit = process.env.AAPANEL_CONFIG;
  const candidates = explicit
    ? [explicit]
    : [
        join(process.cwd(), 'aapanel.config.json'),
        join(homedir(), '.aapanel-mcp.json'),
      ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as FileConfig;
    } catch (err) {
      throw new Error(
        `Failed to parse aapanel config file ${path}: ${(err as Error).message}`,
      );
    }
  }
  return {};
}

export function loadConfig(): PanelConfig {
  const file = readConfigFile();

  const panelUrl = process.env.AAPANEL_PANEL_URL ?? file.panelUrl ?? DEFAULTS.panelUrl;
  const apiKey = process.env.AAPANEL_API_KEY ?? file.apiKey ?? '';

  if (!apiKey) {
    throw new Error(
      'Missing aaPanel API key. Set AAPANEL_API_KEY, or add "apiKey" to ' +
        'aapanel.config.json / ~/.aapanel-mcp.json. ' +
        'The key is created in the panel under Settings -> API Interface.',
    );
  }

  return {
    panelUrl: normalizePanelUrl(panelUrl),
    apiKey: apiKey.trim(),
    readOnly: parseBool(process.env.AAPANEL_READ_ONLY, file.readOnly ?? DEFAULTS.readOnly),
    timeoutMs: parseInt(process.env.AAPANEL_TIMEOUT_MS, file.timeoutMs ?? DEFAULTS.timeoutMs),
    allowSelfSigned: parseBool(
      process.env.AAPANEL_ALLOW_SELF_SIGNED,
      file.allowSelfSigned ?? DEFAULTS.allowSelfSigned,
    ),
    allowDangerous: parseBool(
      process.env.AAPANEL_ALLOW_DANGEROUS,
      file.allowDangerous ?? DEFAULTS.allowDangerous,
    ),
  };
}
