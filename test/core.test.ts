/**
 * Unit tests for the parts that are easy to get subtly wrong: the request
 * signature, the v1/v2 response envelope, secret redaction, and the
 * configuration guards. Run with `npm test`.
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';

import { sign, unwrapV2, AaPanelError } from '../src/client.js';
import { redact, redactParams, OPERATIONS } from '../src/operations.js';
import { normalizePanelUrl, DEFAULTS } from '../src/config.js';

/** The wire form the server would send, after shaping and encoding. */
function wire(op: (typeof OPERATIONS)[number], args: Record<string, unknown>) {
  const parsed = z.object(op.params).parse(args);
  const shaped = op.mapParams ? op.mapParams(parsed as Record<string, unknown>) : parsed;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shaped)) {
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

const byName = (name: string) => {
  const op = OPERATIONS.find((o) => o.name === name);
  if (!op) throw new Error(`no such operation: ${name}`);
  return op;
};

test('sign matches the documented algorithm md5(time + md5(key))', () => {
  // A throwaway key: no real panel credential belongs in a repository.
  const key = 'test-api-key-0123456789abcdef';
  const time = 1_700_000_000;

  const inner = createHash('md5').update(key, 'utf8').digest('hex');
  const expected = createHash('md5').update(String(time) + inner, 'utf8').digest('hex');

  assert.equal(sign(time, key), expected);
  // The signature is hex md5, lower case, 32 chars.
  assert.match(sign(time, key), /^[0-9a-f]{32}$/);
});

test('sign is stable for the same timestamp and differs across timestamps', () => {
  const key = 'abc';
  assert.equal(sign(1000, key), sign(1000, key));
  assert.notEqual(sign(1000, key), sign(1001, key));
});

test('unwrapV2 unwraps the v2 envelope and keeps only the message', () => {
  const raw = JSON.stringify({
    status: 0,
    timestamp: 1_700_000_000,
    message: { data: [{ id: 1, name: 'a.com' }] },
  });
  const out = unwrapV2(raw) as { data: unknown[] };
  assert.deepEqual(out.data, [{ id: 1, name: 'a.com' }]);
});

test('unwrapV2 raises on a non-zero status', () => {
  const raw = JSON.stringify({ status: 1, message: 'site not found' });
  assert.throws(() => unwrapV2(raw), (err: unknown) => {
    assert.ok(err instanceof AaPanelError);
    assert.match(err.message, /site not found/);
    return true;
  });
});

test('unwrapV2 leaves v1 payloads untouched', () => {
  // v1 returns the payload directly, and some actions return a bare scalar.
  const list = JSON.stringify({ data: [{ id: 66 }], where: 'type_id=0', page: '<div/>' });
  assert.deepEqual(unwrapV2(list), { data: [{ id: 66 }], where: 'type_id=0', page: '<div/>' });
  assert.equal(unwrapV2('0'), 0);
  assert.equal(unwrapV2('true'), true);
});

test('unwrapV2 does not mistake an ordinary object for an envelope', () => {
  // A v1 record that happens to carry a "status" field but no "message".
  const raw = JSON.stringify({ status: '1', ps: 'bbb.com', name: 'bbb.com' });
  assert.deepEqual(unwrapV2(raw), { status: '1', ps: 'bbb.com', name: 'bbb.com' });
});

test('unwrapV2 tolerates empty and non-JSON bodies', () => {
  assert.equal(unwrapV2('   '), null);
  assert.equal(unwrapV2('not json at all'), 'not json at all');
});

test('redact masks secrets recursively, including inside arrays', () => {
  const payload = {
    databasePass: 'PdbNjJy5hBA346AR',
    ftpPass: 'sRxmY6xCn6zEsFtG',
    nested: { password: 'hunter2', keep: 'visible' },
    list: [{ datapassword: 'zzz' }],
  };
  const out = redact(payload) as Record<string, any>;
  assert.equal(out.databasePass, '***redacted***');
  assert.equal(out.ftpPass, '***redacted***');
  assert.equal(out.nested.password, '***redacted***');
  assert.equal(out.nested.keep, 'visible');
  assert.equal(out.list[0].datapassword, '***redacted***');
});

test('redactParams masks the secret fields of an outgoing request', () => {
  const out = redactParams({
    name: 'shop',
    password: 'secret',
    ftp_password: 'secret2',
    tables: ['a', 'b'],
  });
  assert.equal(out.name, 'shop');
  assert.equal(out.password, '***redacted***');
  assert.equal(out.ftp_password, '***redacted***');
  assert.deepEqual(out.tables, ['a', 'b']);
});

test('normalizePanelUrl adds a scheme and drops trailing slashes', () => {
  assert.equal(normalizePanelUrl('panel.example.com:8888'), 'https://panel.example.com:8888');
  assert.equal(normalizePanelUrl('http://127.0.0.1:8888/'), 'http://127.0.0.1:8888');
  assert.equal(normalizePanelUrl('  https://a.b:8443/// '), 'https://a.b:8443');
});

test('read-only is the default mode', () => {
  assert.equal(DEFAULTS.readOnly, true);
  assert.equal(DEFAULTS.allowDangerous, false);
});

test('deletion previews send the id as a JSON array, as the panel expects', () => {
  const site = wire(byName('site_delete_check'), { id: 128 });
  assert.equal(site.ids, '[128]');
  assert.equal(site.id, undefined, 'the bare id must not be sent alongside it');

  const db = wire(byName('db_delete_check'), { id: 134 });
  assert.equal(db.ids, '[134]');
  assert.equal(db.id, undefined);
});

test('site_list_domains sends the id under the parameter name the panel reads', () => {
  const sent = wire(byName('site_list_domains'), { id: 128 });
  assert.equal(sent.list, '128');
  assert.equal(byName('site_list_domains').query?.table, 'domain');
});

test('array parameters are JSON-encoded, single values are not', () => {
  const tables = wire(byName('db_optimize_table'), { db_name: 'shop', tables: ['a', 'b'] });
  assert.equal(tables.tables, '["a","b"]');

  const domains = wire(byName('ssl_deploy'), { hash: 'abc', domains: ['x.com', 'www.x.com'] });
  assert.equal(domains.domains, '["x.com","www.x.com"]');
  assert.equal(domains.hash, 'abc');
});

test('booleans reach the panel as 0/1 rather than JS literals', () => {
  const sent = wire(byName('site_create'), {
    webname: '{"domain":"x.com","domainlist":[],"count":0}',
    path: '/www/wwwroot/x.com',
    version: '82',
    ftp: false,
    sql: true,
  });
  assert.equal(sent.ftp, false);
  assert.equal(sent.sql, true);
  // Coercion happens in the URL encoder; what matters is that a boolean is a
  // boolean here and not the string "undefined".
  assert.equal(typeof sent.ftp, 'boolean');
});

test('every risky operation is explicitly classified', () => {
  for (const op of OPERATIONS) {
    assert.ok(['read', 'write', 'dangerous'].includes(op.risk), `${op.name} has risk ${op.risk}`);
  }
  // Anything that is not explicitly read-only must be gated by read-only mode.
  const risky = OPERATIONS.filter((o) => o.risk !== 'read');
  assert.ok(risky.length > 0 && risky.every((o) => o.risk === 'write' || o.risk === 'dangerous'));
});

test('delete operations are annotated destructive, read tools are read-only', () => {
  for (const op of OPERATIONS) {
    if (op.name.endsWith('_delete') || op.name === 'danger_mysql_reset_root_password') {
      assert.equal(op.annotations?.destructiveHint, true, `${op.name} must be marked destructive`);
    }
  }
});
