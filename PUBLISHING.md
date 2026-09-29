# Publishing

## One-time setup

**1. GitHub repository.** `gh` is not installed, so the remote is already wired
up to `https://github.com/devochkaskustikom/aapanel-mcp.git`. Create the
repository in the browser — an **empty** one, with no README, license or
.gitignore, since this project already has all three — then push:

```bash
cd /path/to/aapanel-mcp
git push -u origin main
```

The `homepage`, `repository` and `bugs` fields in `package.json` already point
at this account, so nothing else needs editing.

If you would rather install the GitHub CLI, `winget install --id GitHub.cli`
gives you `gh auth login` and `gh repo create` for future use.

**2. npm login.** This machine is not logged in yet:

```bash
npm login
```

**3. Repository secret.** For the automated publish workflow, create an npm
automation token and add it as `NPM_TOKEN` under
*Settings → Secrets and variables → Actions*. Use an **automation** token, not
your account password. With that secret present, `--provenance` attaches a
signed build attestation to the release.

## Releasing

```bash
npm version patch      # or minor / major
git push --follow-tags
```

The tag is the trigger. The `publish` job verifies the tag matches
`package.json`, checks the tarball contents, runs the tests and publishes.
Publishing never happens from a plain push, so a version number cannot be
consumed by accident.

## Without CI

To publish straight from your machine:

```bash
npm publish --access public
```

`prepublishOnly` runs the full typecheck and test suite first, so a broken
build cannot be published.

## Verifying the release

```bash
npm view aapanel-mcp
npx aapanel-mcp            # with AAPANEL_PANEL_URL and AAPANEL_API_KEY set
```

## What gets published

Only `dist/src`, `README.md`, `LICENSE` and the example config. Sources, tests,
the compiled tests and any real `aapanel.config.json` are excluded, and the
workflow fails the release if they ever appear.
