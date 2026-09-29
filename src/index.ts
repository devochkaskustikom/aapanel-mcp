#!/usr/bin/env node
/**
 * Entry point: stdio MCP transport, which is what every CLI agent
 * (ZCode, Claude Code, Cursor, Codex, ...) launches as a subprocess.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  // stdout is the MCP channel, so every diagnostic must go to stderr.
  const log = (msg: string) => process.stderr.write(`[aapanel-mcp] ${msg}\n`);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log(`configuration error: ${(err as Error).message}`);
    process.exit(1);
  }

  log(`panel=${config.panelUrl} readOnly=${config.readOnly} dangerous=${config.allowDangerous}`);

  const server = createServer(config);
  const transport = new StdioServerTransport();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  let closing = false;
  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    log(`received ${signal}, shutting down`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  }

  try {
    await server.connect(transport);
    log('connected over stdio');
  } catch (err) {
    log(`fatal: ${(err as Error).message}`);
    process.exit(1);
  }
}

void main();
