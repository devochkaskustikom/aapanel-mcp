/**
 * MCP server exposing the aaPanel (btPanel fork) HTTP API to AI CLI agents.
 *
 * Design notes for the agent side:
 *  - Every panel action is a separate, narrowly described tool. Generic
 *    "call any endpoint" escape hatches are deliberately absent: a model that
 *    can only pick from described tools cannot invent a destructive call.
 *  - Destructive operations are gated twice, by `readOnly` and by the harder
 *    `allowDangerous` flag, and both refusals explain how to proceed.
 *  - The same data is also published as MCP resources, so an agent can read
 *    site and database inventories without spending tool calls.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig, type PanelConfig } from './config.js';
import { AaPanelClient, AaPanelError, type Params } from './client.js';
import { OPERATIONS, redact, redactParams, type Operation } from './operations.js';

const SERVER_NAME = 'aapanel';
const SERVER_VERSION = '1.0.0';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function createServer(config: PanelConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Manage aaPanel/btPanel hosting from the command line. Start with ' +
        'aapanel_status to confirm the panel is reachable, and list_sites or ' +
        'list_databases to get ids before any operation, since nearly every ' +
        'action needs a numeric id. Before deleting a site or database, run ' +
        'the matching *_delete_check tool and show the user what would be lost.',
    },
  );

  const client = new AaPanelClient(config);

const run = async (op: Operation, raw: Record<string, unknown>): Promise<ToolResult> => {
  const gate = checkRisk(op, config);
  if (gate) return gate;

    // Validate before the request leaves the process, so a malformed call
    // never reaches the panel.
    const schema = z.object(op.params);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return text(
        `Invalid arguments for ${op.name}:\n` +
          parsed.error.issues
            .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n'),
        true,
      );
    }

    const params: Params = {};
    for (const [k, v] of Object.entries(parsed.data)) params[k] = v as Params[string];

    // Apply the operation's parameter reshaping, then encode for the wire:
    // array fields (tables, domains) go as JSON, which is what the panel's own
    // front end does.
    const shaped = op.mapParams ? op.mapParams(params as Record<string, unknown>) : params;
    const wire: Params = {};
    for (const [k, v] of Object.entries(shaped)) {
      if (v === undefined || v === null) continue;
      wire[k] = Array.isArray(v) ? JSON.stringify(v) : (v as Params[string]);
    }

    const action = `${op.route}?action=${op.action}`;
    const started = Date.now();
    try {
      const result = await client.call(op.route, op.action, wire, op.query ?? {});
      const elapsed = Date.now() - started;
      return json({
        action,
        ok: true,
        durationMs: elapsed,
        result: redact(result),
      });
    } catch (err) {
      if (err instanceof AaPanelError) {
        return json(
          {
            action,
            ok: false,
            error: err.message,
            detail: redact(err.detail),
            sent: redactParams(wire as Record<string, unknown>),
          },
          true,
        );
      }
      throw err;
    }
  };

  // ------------------------------------------------------------- tools
  for (const op of OPERATIONS) {
    server.registerTool(
      op.name,
      {
        title: op.title,
        description: op.description,
        inputSchema: op.params,
        annotations: {
          readOnlyHint: op.risk === 'read',
          destructiveHint: op.annotations?.destructiveHint ?? op.risk === 'dangerous',
          idempotentHint: op.risk === 'read',
          openWorldHint: true,
        },
      },
      async (args) => run(op, (args ?? {}) as Record<string, unknown>),
    );
  }

  // --------------------------------------------------------- resources
  server.registerResource(
    'panel-overview',
    'aapanel://panel/overview',
    {
      title: 'Panel overview',
      description: 'Server health snapshot: OS, panel version, CPU, memory, disks and load.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const [total, disks, net] = await Promise.all([
        client.call('/system', 'GetSystemTotal').catch((e: Error) => ({ error: e.message })),
        client.call('/system', 'GetDiskInfo').catch((e: Error) => ({ error: e.message })),
        client.call('/system', 'GetNetWork').catch((e: Error) => ({ error: e.message })),
      ]);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ system: total, disks, network: net }, null, 2),
          },
        ],
      };
    },
  );
  /**
   * Fetch the site list once per call and degrade to a diagnostic rather than
   * failing the whole `resources/list` exchange: a client enumerating
   * resources should still see the catalog when the panel is down.
   */
  const listSites = async (): Promise<{ rows: Array<Record<string, unknown>>; error?: string }> => {
    try {
      const raw = (await client.call('/v2/data', 'getData', {
        table: 'sites',
        p: 1,
        limit: 200,
        type: -1,
        search: '',
      })) as { data?: unknown[] };
      return { rows: (raw?.data ?? []) as Array<Record<string, unknown>> };
    } catch (err) {
      return { rows: [], error: (err as Error).message };
    }
  };

  server.registerResource(
    'sites',
    new ResourceTemplate('aapanel://sites/{id}', {
      list: async () => {
        const { rows, error } = await listSites();
        if (error) {
          return {
            resources: [
              {
                uri: 'aapanel://sites/unavailable',
                name: 'Site list unavailable',
                description: error,
                mimeType: 'application/json',
              },
            ],
          };
        }
        return {
          resources: rows.map((r) => ({
            uri: `aapanel://sites/${r.id}`,
            name: `${r.name} (${r.path})`,
            description: `Website id ${r.id} at ${r.path}`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Websites',
      description: 'All PHP sites on the panel, addressable by id.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = Number.parseInt(String(variables.id), 10);
      if (!Number.isFinite(id)) {
        return {
          contents: [
            { uri: uri.href, mimeType: 'application/json', text: '{"error":"invalid site id"}' },
          ],
        };
      }
      const { rows, error } = await listSites();
      const site = rows.find((r) => Number(r.id) === id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(site ?? { error: error ?? `site ${id} not found` }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'databases',
    'aapanel://databases',
    {
      title: 'Databases',
      description: 'All MySQL databases tracked by the panel.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const data = (await client.call('/v2/data', 'getData', {
          table: 'databases',
          type: 'MySQL',
          p: 1,
          limit: 200,
          search: '',
        })) as { data?: unknown[] };
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ data: data?.data ?? [] }, null, 2),
            },
          ],
        };
      } catch (err) {
        // A down panel must not turn a resource read into a protocol error:
        // the agent is better served by a readable diagnostic it can act on.
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: (err as Error).message }, null, 2),
            },
          ],
        };
      }
    },
  );

  // ------------------------------------------------------ meta / guidance
  server.registerTool(
    'aapanel_status',
    {
      title: 'Connection and mode status',
      description:
        'Report the panel address, whether the connection works, the panel version, and which modes are active (read-only, dangerous operations). Safe to call at any time; it reveals no secrets.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      try {
        const total = (await client.call('/system', 'GetSystemTotal')) as Record<string, unknown>;
        return json({
          ok: true,
          panelUrl: config.panelUrl,
          connected: true,
          panelVersion: total.version ?? null,
          os: total.system ?? null,
          modes: {
            readOnly: config.readOnly,
            allowDangerous: config.allowDangerous,
          },
          toolCount: OPERATIONS.length,
        });
      } catch (err) {
        return json(
          {
            ok: false,
            panelUrl: config.panelUrl,
            connected: false,
            error: (err as Error).message,
            modes: {
              readOnly: config.readOnly,
              allowDangerous: config.allowDangerous,
            },
            hint:
              'Check that the panel is running, that the URL includes the port, and that this ' +
              "host's ip is in the panel's API ip whitelist (Settings -> API Interface).",
          },
          true,
        );
      }
    },
  );

  server.registerTool(
    'aapanel_capabilities',
    {
      title: 'List available operations',
      description:
        'Every operation this server exposes, with its risk level. Use it to discover what is possible and which operations are currently blocked by the server mode.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      json({
        panelUrl: config.panelUrl,
        modes: { readOnly: config.readOnly, allowDangerous: config.allowDangerous },
        operations: OPERATIONS.map((op) => ({
          name: op.name,
          title: op.title,
          action: `${op.route}?action=${op.action}`,
          risk: op.risk,
          available: availability(op, config),
        })),
      }),
  );

  return server;
}

/** Explain, in the agent's own terms, why an operation is blocked. */
function checkRisk(op: Operation, config: PanelConfig): ToolResult | undefined {
  if (op.risk === 'read') return undefined;

  if (op.risk === 'dangerous' && !config.allowDangerous) {
    return text(
      `${op.name} is blocked: this operation is on the dangerous list and the server is ` +
        'running without AAPANEL_ALLOW_DANGEROUS. It can expose or replace credentials and ' +
        'bypass the validation in the site tools. If a human has confirmed this specific ' +
        'action, ask them to restart the server with AAPANEL_ALLOW_DANGEROUS=true, then retry.',
      true,
    );
  }

  if (config.readOnly) {
    return text(
      `${op.name} is blocked: the server is running in read-only mode (AAPANEL_READ_ONLY=true), ` +
        'which refuses every operation that changes the panel. Show the user the parameters you ' +
        'would send and ask them to run it themselves, or to restart the server with ' +
        'AAPANEL_READ_ONLY=false if they want the agent to make changes.',
      true,
    );
  }

  return undefined;
}

function availability(op: Operation, config: PanelConfig): boolean {
  if (op.risk === 'dangerous' && !config.allowDangerous) return false;
  if (op.risk !== 'read' && config.readOnly) return false;
  return true;
}

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: body }], isError };
}

function json(value: unknown, isError = false): ToolResult {
  const structured = value as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: structured,
    isError,
  };
}
