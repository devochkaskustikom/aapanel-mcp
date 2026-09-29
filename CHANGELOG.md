# aapanel-mcp 1.0.1-alpha.0

First public release. An MCP server that gives AI CLI agents full control of an
aaPanel (btPanel fork) hosting panel.

## Install

```bash
npx aapanel-mcp
```

Or as a dependency: `npm install -g aapanel-mcp`. Node 20.10 or newer.

## Configure the panel

In the aaPanel UI: **Settings → API Interface → Modify**, enable the API,
generate a key, and add the agent host's IP to the whitelist. The whitelist is
not optional — a request from an unlisted address is refused by the panel
regardless of how correct the signature is.

```bash
export AAPANEL_PANEL_URL="https://your-panel.example.com:8888"
export AAPANEL_API_KEY="your-api-interface-key"
```

## What it does

The panel's HTTP API authenticates with a per-request MD5 signature rather
than a header, and expects the caller to keep a session cookie across calls.
Generic HTTP clients cannot drive it. This server implements that protocol once
and exposes **57 described panel operations**, 2 meta tools and 3 MCP
resources.

Covered: system status and disks, website lifecycle, domains, PHP version
switching, rewrite rules, vhost config, MySQL databases and tables, backups,
the recycle bin, SSL certificates, and database import/export.

## Safety

The server starts **read-only**, which refuses every state-changing operation.
Five operations that can expose or replace credentials — the MySQL root
password, arbitrary file read/write, and panel self-update — are behind a
second flag (`AAPANEL_ALLOW_DANGEROUS`), off by default. Generated and
user-supplied secrets are redacted from tool results.

There is deliberately no generic "call any endpoint" tool: a model that can
only choose from individually described operations cannot invent a destructive
call it was never shown.

## Notes for this alpha

- Install path verified end to end through `npx` against a live registry.
- Known rough edge: this is an alpha. The tool set is stable, but expect
  additions as further panel APIs are covered.
- The `latest` dist-tag currently points at this prerelease, so a bare
  `npm install aapanel-mcp` gets the alpha. Use `--tag alpha` explicitly until
  a stable release.

Full documentation: https://github.com/devochkaskustikom/aapanel-mcp#readme
