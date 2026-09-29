# aapanel-mcp

An MCP server that gives AI CLI agents full control of an **aaPanel** (the
btPanel fork) hosting panel over its HTTP API.

The panel speaks a signature-based API that no generic HTTP MCP client can use:
authentication is a per-request MD5 signature rather than a header, and the
caller is expected to keep a session cookie across calls. This server
implements that protocol once, correctly, and exposes it as **57 described
tools** plus **3 resources**.

## Why the tools are not generic

There is deliberately no "call any panel endpoint" tool. A model that can only
choose from individually described operations cannot invent a destructive call
it was never shown, and every argument is validated against a schema *before*
the request leaves the process.

## Install

```bash
npm install
npm run build
```

Requires Node 20 or newer.

## Configure the panel

Two things must be true in the aaPanel UI before any client can connect:

1. **Settings → API Interface → Modify** — enable the API and generate a key.
2. **Add your client's IP to the whitelist.** This is not optional. A request
   from an address that is not on the list is refused by the panel regardless
   of how correct the signature is. If you run the agent on the same machine as
   the panel, that is `127.0.0.1`.

Point the server at the panel and give it the key:

```bash
export AAPANEL_PANEL_URL="https://your-panel.example.com:8888"
export AAPANEL_API_KEY="your-api-interface-key"
```

The key in your message is a real credential. Rotate it in the panel UI, and
prefer delivering it through the environment or a secret manager rather than
committing a config file.

### Configuration

Environment variables win over the config file, which wins over defaults. Copy
`aapanel.config.example.json` to `aapanel.config.json` (project root) or
`~/.aapanel-mcp.json` for a persistent setup.

| Setting | Env var | Default | Meaning |
| --- | --- | --- | --- |
| Panel URL | `AAPANEL_PANEL_URL` | `http://127.0.0.1:8888` | Must include the port. |
| API key | `AAPANEL_API_KEY` | — | Required. |
| Read-only | `AAPANEL_READ_ONLY` | `true` | Refuses every state-changing tool. |
| Timeout | `AAPANEL_TIMEOUT_MS` | `60000` | Per-request timeout. |
| Self-signed TLS | `AAPANEL_ALLOW_SELF_SIGNED` | `false` | Accept an unverifiable panel certificate. |
| Dangerous ops | `AAPANEL_ALLOW_DANGEROUS` | `false` | Unlocks root credentials and raw file access. |
| Config path | `AAPANEL_CONFIG` | — | Override the config file location. |

## Safety model

The server starts **read-only**. Two independent gates protect the panel:

- **`readOnly`** (default on) refuses every `write` operation. The refusal tells
  the agent to show the user the parameters it would have sent, rather than
  silently failing.
- **`allowDangerous`** (default off) is a second, harder gate over the five
  operations that can expose or replace credentials:

  | Tool | Why it is gated |
  | --- | --- |
  | `danger_mysql_root_password` | Reads the MySQL root password from panel config. |
  | `danger_mysql_reset_root_password` | Replaces it, breaking every existing root login. |
  | `danger_read_file` | Reads any file the panel user can read. |
  | `danger_write_file` | Writes any such file, bypassing all site-tool validation. |
  | `danger_update_panel` | Replaces the panel itself. |

Generated credentials are redacted on the way out. When `site_create` returns a
panel-generated FTP or database password, the value in the tool result is
replaced with `***redacted***` — including inside nested objects and arrays. Ask
the user to read the password from the panel UI instead of relying on the
transcript.

## Wire to your agent

### ZCode / Claude Code / Cursor (stdio)

Add to the client config, pointing `command` at your `node`:

```json
{
  "mcpServers": {
    "aapanel": {
      "command": "node",
      "args": ["/absolute/path/to/aapanel-mcp/dist/src/index.js"],
      "env": {
        "AAPANEL_PANEL_URL": "https://your-panel.example.com:8888",
        "AAPANEL_API_KEY": "your-api-interface-key",
        "AAPANEL_READ_ONLY": "true"
      }
    }
  }
}
```

Set `AAPANEL_READ_ONLY` to `"false"` only once you trust the agent with
production changes. When you do, keep `AAPANEL_ALLOW_DANGEROUS` at `"false"`.

### Harness

Harness drives an agent loop that shells out to tools. Give the loop this
server as an MCP endpoint and let it connect over stdio. Two Harness-specific
notes:

- Harness agents are good at composing steps but bad at remembering that a
  destructive call needs a numeric id. The `aapanel_capabilities` tool is
  cheap to call and returns every operation with its current availability, so
  let the agent call it first when the task is open-ended.
- Long panel operations (backups, panel updates) are asynchronous. The panel
  exposes `panel_install_task_count`; instruct the agent to poll it rather than
  assuming an operation finished when the call returned.

## Tools

`aapanel_capabilities` returns this list at runtime, along with which
operations the current mode actually permits.

**Panel and system** — `aapanel_status`, `aapanel_capabilities`,
`panel_system_total`, `panel_disk_info`, `panel_network_status`,
`panel_install_task_count`, `panel_check_update`, `panel_mysql_status`

**Websites (read)** — `site_list`, `site_get`, `site_types`, `site_list_domains`,
`site_get_root`, `site_php_versions`, `site_php_version`, `site_rewrite_templates`,
`site_get_rewrite`, `site_get_config`, `site_get_ssl`, `site_dir_userini`,
`site_delete_check`, `site_list_backups`

**Websites (write)** — `site_create`, `site_delete`, `site_start`, `site_stop`,
`site_add_domain`, `site_remove_domain`, `site_set_php_version`,
`site_set_run_path`, `site_set_dir_userini`, `site_set_rewrite`, `site_set_index`,
`site_backup`

**Databases (read)** — `db_list`, `db_tables`, `db_access_get`, `db_backups`,
`db_recycle_bin`, `db_delete_check`

**Databases (write)** — `db_create`, `db_set_password`, `db_set_access`,
`db_backup`, `db_delete`, `db_optimize_table`, `db_repair_table`,
`db_sync_from_server`, `db_restore`, `db_import_sql`

**SSL** — `ssl_list`, `ssl_upload`, `ssl_deploy`, `ssl_disable`

**Dangerous** — the five tools in the safety table above.

## Resources

Reading an inventory as a resource is often cheaper than a tool call:

| URI | Contents |
| --- | --- |
| `aapanel://panel/overview` | OS, panel version, CPU, memory, disks, live network. |
| `aapanel://sites/{id}` | One site record, listed by `resources/list`. |
| `aapanel://databases` | All MySQL databases. |

## How the protocol works

```
request_time  = unix timestamp in seconds
request_token = md5(str(request_time) + md5(api_key))
```

Both are sent as ordinary form fields on every POST, alongside the action
parameters. The session cookie returned by the panel is held in memory and
replayed on subsequent requests, as the panel's own demo does.

aaPanel has two API generations and they answer differently. v1 returns the
payload directly; v2 wraps it in `{status, timestamp, message}` where `status: 0`
means success. The server detects the envelope by shape and unwraps it, so tool
handlers and resources always see the payload. A non-zero `status` is raised as
an error carrying the panel's own message.

## Development

```bash
npm run build       # compile to dist/
npm run typecheck   # types only, no emit
npm test            # build, then run unit + end-to-end tests
npm run dev         # run from source via tsx
```

The test suite covers the signature algorithm against a hand-computed MD5, the
v1/v2 envelope handling, secret redaction, parameter shaping for the endpoints
whose wire format differs from their natural shape, and a full MCP session
(`initialize`, `tools/list`, tool calls, read-only refusal, resource read)
against an in-process fake panel that validates every signature.

## Adding an operation

Add one entry to `OPERATIONS` in `src/operations.ts`. It needs a `route`, an
`action`, a zod `params` shape, and a `risk`. Anything not marked `read` is
gated automatically, so a new operation is safe by default. Use `query` for
parameters the panel reads from the URL, and `mapParams` when the panel's
parameter name differs from the one an agent would guess.
