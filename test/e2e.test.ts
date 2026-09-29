/**
 * End-to-end check against a fake aaPanel.
 *
 * Spins up an HTTP server that mimics the panel (verifying the signature),
 * then drives the real MCP server over stdio with the official SDK client:
 * initialize, tools/list, a read call, a read-only refusal, and a resource
 * read. This is the only test that proves the two halves actually speak the
 * same protocol.
 *
 * Run with: node dist/test/e2e.test.js
 */

import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'src', 'index.js');

const API_KEY = 'test-key-abcdef0123456789';

/** Validate the request the way the panel does, and answer like the panel does. */
async function startFakePanel(): Promise<{ url: string; close: () => Promise<void>; seen: Array<{ action: string; body: URLSearchParams; query: URLSearchParams }> }> {
  const seen: Array<{ action: string; body: URLSearchParams; query: URLSearchParams }> = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const url = new URL(req.url ?? '/', 'http://localhost');
      const action = url.searchParams.get('action') ?? '';
      seen.push({ action, body, query: url.searchParams });

      const requestTime = body.get('request_time') ?? '';
      const token = body.get('request_token') ?? '';
      const inner = createHash('md5').update(API_KEY).digest('hex');
      const expected = createHash('md5').update(requestTime + inner).digest('hex');

      const setCookie = ['bt_token=fake-session; path=/; HttpOnly'];
      res.setHeader('Set-Cookie', setCookie);

      if (token !== expected) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 401, msg: 'invalid signature' }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });

      // v2 envelope.
      if (action === 'GetSystemTotal') {
        res.end(
          JSON.stringify({
            status: 0,
            timestamp: 1700000000,
            message: { version: '6.8.1', system: 'Debian 12', cpuNum: 4, memTotal: 2048 },
          }),
        );
        return;
      }
      if (action === 'getData' && url.searchParams.get('table') === 'sites') {
        res.end(
          JSON.stringify({
            status: 0,
            timestamp: 1700000001,
            message: {
              data: [
                { id: 66, name: 'aaa.com', path: '/www/wwwroot/aaa.com', ps: 'first site' },
                { id: 67, name: 'bbb.com', path: '/www/wwwroot/bbb.com', ps: 'second site' },
              ],
              where: 'type_id=0',
              page: '<div/>',
            },
          }),
        );
        return;
      }
      if (action === 'getData') {
        // Any other table: the panel answers, but with a different shape, so a
        // dropped `table` query parameter is visible as a wrong result.
        res.end(
          JSON.stringify({
            status: 0,
            timestamp: 1700000099,
            message: { data: [{ id: 999, name: 'WRONG-TABLE' }], where: 'wrong' },
          }),
        );
        return;
      }
      if (action === 'get_site_types') {
        res.end(JSON.stringify({ status: 0, timestamp: 1700000002, message: [{ id: 0, name: 'Default' }] }));
        return;
      }
      // v1 style, bare payload.
      if (action === 'GetDiskInfo') {
        res.end(JSON.stringify([{ path: '/', size: ['8.3G', '4.0G', '4.3G', '49%'] }]));
        return;
      }
      if (action === 'GetNetWork') {
        res.end(JSON.stringify({ status: 0, timestamp: 1700000003, message: { up: 4.33, down: 8.77 } }));
        return;
      }
      if (action === 'AddSite') {
        res.end(
          JSON.stringify({
            status: 0,
            timestamp: 1700000004,
            message: { siteStatus: true, ftpPass: 'sRxmY6xCn6zEsFtG', databasePass: 'PdbNjJy5hBA346AR' },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ status: 0, timestamp: 1700000005, message: { result: 'ok' } }));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connectClient(panelUrl: string, extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      AAPANEL_PANEL_URL: panelUrl,
      AAPANEL_API_KEY: API_KEY,
      AAPANEL_READ_ONLY: 'true',
      ...extraEnv,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'e2e-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

test('end-to-end: full MCP session against a fake panel', async (t) => {
  const panel = await startFakePanel();
  let child: ChildProcessWithoutNullStreams | undefined;
  t.after(async () => {
    await panel.close();
  });

  const client = await connectClient(panel.url);
  t.after(async () => {
    await client.close();
  });

  // ---- tools are advertised
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);

  assert.ok(names.includes('site_list'), 'site_list must be exposed');
  assert.ok(names.includes('db_create'), 'db_create must be exposed');
  assert.ok(names.includes('danger_mysql_root_password'), 'dangerous tools stay visible but gated');
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');

  // Read tools must be annotated as such, destructive ones must not claim read-only.
  const siteList = tools.find((tool) => tool.name === 'site_list');
  assert.equal(siteList?.annotations?.readOnlyHint, true);
  const siteDelete = tools.find((tool) => tool.name === 'site_delete');
  assert.equal(siteDelete?.annotations?.readOnlyHint, false);
  assert.equal(siteDelete?.annotations?.destructiveHint, true);

  // Every tool must carry a description: an undescribed tool is a coin flip for the model.
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`);
  }

  // ---- status tool reports a healthy connection
  const status = (await client.callTool({ name: 'aapanel_status', arguments: {} })) as {
    content: Array<{ text: string }>;
  };
  const statusJson = JSON.parse(status.content[0]?.text ?? '{}');
  assert.equal(statusJson.connected, true);
  assert.equal(statusJson.panelVersion, '6.8.1');
  assert.equal(statusJson.modes.readOnly, true);

  // ---- a read call reaches the panel and is signed correctly
  const listed = (await client.callTool({ name: 'site_list', arguments: { limit: 10 } })) as {
    content: Array<{ text: string }>;
  };
  const listedJson = JSON.parse(listed.content[0]?.text ?? '{}');
  assert.equal(listedJson.ok, true);
  const rows = listedJson.result.data as Array<{ id: number; name: string }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.name, 'aaa.com');

  // The signature the panel accepted proves md5(time + md5(key)) round-trips.
  const signed = panel.seen.find((r) => r.action === 'getData');
  assert.ok(signed, 'the panel must have received a getData call');
  assert.ok(signed.body.get('request_token'), 'request_token must be present');
  assert.ok(signed.body.get('request_time'), 'request_time must be present');
  assert.equal(signed.body.get('limit'), '10');

  // Route-defining query parameters must travel in the URL. Without `table=sites`
  // the panel cannot tell this apart from a domain or backup listing.
  assert.equal(signed.query.get('table'), 'sites', 'table must be a query parameter, not a form field');
  assert.equal(signed.body.get('table'), null, 'table must not be duplicated into the body');

  // ---- read-only mode refuses a write, and the panel is never contacted
  const before = panel.seen.length;
  const refused = (await client.callTool({
    name: 'site_create',
    arguments: { webname: '{"domain":"x.com","domainlist":[],"count":0}', path: '/www/wwwroot/x.com', version: '82' },
  })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(refused.isError, true, 'a blocked write must be flagged as an error');
  assert.match(refused.content[0]?.text ?? '', /read-only/i);
  assert.equal(panel.seen.length, before, 'a blocked write must not reach the panel');

  // ---- dangerous tools are gated even when writes are permitted
  const rwClient = await connectClient(panel.url, { AAPANEL_READ_ONLY: 'false' });
  t.after(async () => {
    await rwClient.close();
  });

  const root = (await rwClient.callTool({
    name: 'danger_mysql_root_password',
    arguments: {},
  })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(root.isError, true);
  assert.match(root.content[0]?.text ?? '', /dangerous/i);

  // ---- with writes enabled, a write goes through and secrets come back redacted
  const created = (await rwClient.callTool({
    name: 'site_create',
    arguments: {
      webname: '{"domain":"x.com","domainlist":[],"count":0}',
      path: '/www/wwwroot/x.com',
      version: '82',
    },
  })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.notEqual(created.isError, true, 'a permitted write must succeed');
  const createdText = created.content[0]?.text ?? '';
  assert.ok(!createdText.includes('sRxmY6xCn6zEsFtG'), 'generated FTP password must be redacted');
  assert.ok(!createdText.includes('PdbNjJy5hBA346AR'), 'generated database password must be redacted');
  assert.match(createdText, /\*\*\*redacted\*\*\*/, 'redaction marker must be present');

  // ---- resources are readable
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes('aapanel://panel/overview'), 'overview resource must exist');
  assert.ok(uris.includes('aapanel://databases'), 'databases resource must exist');

  const overview = await client.readResource({ uri: 'aapanel://panel/overview' });
  const overviewText = String((overview.contents[0] as { text?: string })?.text ?? '{}');
  const overviewJson = JSON.parse(overviewText);
  assert.equal(overviewJson.system.version, '6.8.1', 'v2 envelope must be unwrapped in resources');
  assert.equal(overviewJson.network.up, 4.33);

  // ---- the panel surface actually covered
  const cap = (await client.callTool({ name: 'aapanel_capabilities', arguments: {} })) as {
    content: Array<{ text: string }>;
  };
  const capJson = JSON.parse(cap.content[0]?.text ?? '{}');
  assert.ok(capJson.operations.length >= 40, 'the catalogue should be broad');
  const blocked = capJson.operations.filter((o: { available: boolean }) => !o.available);
  assert.ok(blocked.length > 0, 'read-only mode must mark some operations unavailable');
  assert.ok(
    blocked.every((o: { risk: string }) => o.risk !== 'read'),
    'no read-only operation may be reported as blocked',
  );

  child = undefined;
});

test('an unreachable panel degrades resources instead of failing the protocol', async (t) => {
  // Port 1 is reserved and never listening, so every panel call is refused.
  const client = await connectClient('http://127.0.0.1:1');
  t.after(async () => {
    await client.close();
  });

  // resources/list must still answer: a client enumerating resources cannot
  // be left with a JSON-RPC error just because the panel is down.
  const listed = await client.listResources();
  const uris = listed.resources.map((r) => r.uri);
  assert.ok(uris.length > 0, 'resources/list must return entries even when the panel is down');
  assert.ok(
    uris.includes('aapanel://sites/unavailable'),
    'the site list must report unavailability rather than throw',
  );
  assert.ok(uris.includes('aapanel://panel/overview'), 'static resources must still be listed');

  // Reading a resource yields a readable diagnostic, not a protocol error.
  const read = await client.readResource({ uri: 'aapanel://databases' });
  const text = String((read.contents[0] as { text?: string })?.text ?? '{}');
  const parsed = JSON.parse(text) as { error?: string };
  assert.ok(parsed.error, 'the databases resource must explain the failure');
  assert.match(parsed.error ?? '', /panel/i);

  // Tools still work and report the failure clearly.
  const status = (await client.callTool({ name: 'aapanel_status', arguments: {} })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  const statusJson = JSON.parse(status.content[0]?.text ?? '{}');
  assert.equal(statusJson.connected, false);
  assert.equal(statusJson.ok, false);
  assert.equal(status.isError, true);
  assert.match(statusJson.hint ?? '', /whitelist/i);
});
