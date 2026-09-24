<div align="center">

# Codex Subagent Router

**Describe the mission. Let Jev pick the model.**

AI model routing for native Codex subagents, powered by Jev and your task profiles.

[![Verify](https://github.com/guilhem/codex-subagent-router/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/guilhem/codex-subagent-router/actions/workflows/verify.yml)
[![Node.js 20+](https://img.shields.io/badge/node.js-20%2B-339933?logo=node.js&logoColor=white)](#quickstart)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-111827)](plugins/codex-subagent-router/.codex-plugin/plugin.json)
[![Powered by Jev](https://img.shields.io/badge/powered_by-Jev-8B5CF6)](https://docs.typesafe.ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E)](LICENSE)

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Task profiles](#task-profiles) · [Routing behavior](#routing-behavior) · [Contributing](#development--contributing)

</div>

Reading logs, implementing a feature, and reviewing an architectural change call
for different strengths. Define which models fit which work; the router asks
[Jev](https://docs.typesafe.ai) to choose a profile whenever Codex delegates
without an explicit model, reasoning effort, or agent type.

- **Native delegation.** One `PreToolUse` hook on `spawn_agent`; no extra
  agent-facing tool or routing service to run.
- **Your models, your rules.** Plain JSON profiles describe the tasks each model
  fits. Edits take effect on the next delegation.
- **Explicit choices win.** Pin a model, effort, or agent type to bypass routing.
  If routing is unavailable or Jev defers, native inheritance/defaults apply.

## Quickstart

You need a Codex host with native `spawn_agent` and plugin `PreToolUse` support
and a **TypeSafe API key**. The models and reasoning efforts in your profiles
must be available on your Codex host.

### 1. Install the plugin

```sh
codex plugin marketplace add guilhem/codex-subagent-router --ref main
codex plugin add codex-subagent-router@codex-subagent-router
```

The plugin includes the TypeSafe SDK in a ready-to-run JavaScript bundle.
Codex Desktop supplies its Node runtime; there is no Python, npm, or SDK to
install. With standalone Codex CLI, have Node.js 20+ on `PATH` if no Codex runtime
is available. The launcher checks Codex's runtime locations before the system
`node`; `CODEX_MCP_NODE_PATH` can point to a Node executable when needed.

### 2. Set your API key

```sh
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

Set this in the environment of the process that launches Codex. `JEV_API_KEY`
is also supported; `TYPESAFE_API_KEY` takes precedence. The router never loads
a workspace `.env` file.

### 3. Add your first profiles

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/subagent-router"
```

Create these files in that directory. These example model IDs are host-dependent;
replace them with models and reasoning efforts your host supports.

**`myteam-routine.json`** — evidence collection and existing checks:

```json
{
  "description": "Read files, collect logs, or run existing checks for a clearly scoped task. No code changes or complex diagnosis.",
  "model": "gpt-6-luna",
  "reasoning_effort": "max"
}
```

**`myteam-implementation.json`** — code changes and standard review:

```json
{
  "description": "Implement or test code under a clear contract, or perform standard technical review. Defer complex architectural decisions.",
  "model": "gpt-6-sol",
  "reasoning_effort": "high"
}
```

### 4. Trust the hook and delegate

Review and trust the plugin hook in Codex `/hooks`, then start a fresh session
with the API key available. Installing a plugin does not automatically trust its
hooks; see the [Codex plugin documentation](https://developers.openai.com/plugins/build/plugins).

Ask Codex to delegate a task, for example:

> Delegate a check of the existing test suite. Summarize failures and leave the
> model and reasoning effort to the router.

The native `spawn_agent` call should describe the mission and leave `model`,
`reasoning_effort`, and `agent_type` unset or `null`. Jev then chooses among your
profiles, or defers when none fits.

> [!IMPORTANT]
> Personal agent instructions that require explicit model or effort values on
> every spawn bypass automatic routing. Explicit settings always take precedence.

## How it works

```mermaid
flowchart LR
    task["Unpinned spawn_agent"] --> hook["PreToolUse hook"]
    profiles["Your JSON profiles"] --> hook
    hook --> choice["Jev Choice"]
    choice -->|Profile selected| routed["Spawn with model + effort"]
    choice -->|Defer or failure| defaults["Native defaults"]
    hook -->|Catalog or credentials unavailable| defaults
```

The hook reads your profiles and sends the delegated mission, profile identifiers,
and profile descriptions to TypeSafe in one Jev `Choice` question. Jev can select
a profile or `defer`. A selected profile supplies `model` and `reasoning_effort`;
the mission and all other spawn arguments stay unchanged.

The router handles a text `message` or text-only `items`. It does not hardcode
model capabilities or task categories. A selection requests a model from Codex;
it is not proof of which provider ultimately executes the subagent.

## Task profiles

Profiles live directly inside `$CODEX_HOME/subagent-router/`, or
`~/.codex/subagent-router/` when `CODEX_HOME` is unset or empty. Each `*.json` file
defines one choice, identified by its filename without `.json`.

| Field | What to put here |
| --- | --- |
| `description` | The work this profile fits, with enough detail to distinguish nearby choices. |
| `model` | A model ID available on your Codex host. |
| `reasoning_effort` | A reasoning effort supported by that model and host. |

All three fields must be nonempty strings. Several profiles can use the same
model. `defer` is reserved. The router rereads the directory on every delegation
and never writes profiles.

Skills, plugins, and users can contribute profiles to the same directory. Prefix
filenames with the producer's name, preserve existing user-edited files, and
let each producer own installation, updates, and removal. No registration is
needed.

## Routing behavior

| Situation | What happens |
| --- | --- |
| Explicit non-null `model`, `reasoning_effort`, or `agent_type` | Bypasses routing, catalog reads, and provider calls. |
| Valid catalog, credentials, and an unpinned text mission | Jev selects a profile or returns `defer`. |
| Empty, invalid, or oversized catalog | Keeps native inheritance/defaults; no provider call. |
| Missing runtime/key, provider failure, or invalid response | Keeps native inheritance/defaults. |
| Jev returns `defer` | Keeps native inheritance/defaults. |

One invalid profile invalidates the catalog for that call; the router never
silently uses only part of it. Diagnostics omit profile contents, missions, and
credentials.

<details>
<summary><strong>Limits and retries</strong></summary>

The catalog supports up to **254 profiles plus `defer`**, within the
[255-option Choice limit](https://docs.typesafe.ai/primitives/choice). Larger
catalogs fall back without truncation. The SDK has at most two retries within a
10-second total request budget; Codex caps the hook at 15 seconds. No confidence threshold
is applied.

</details>

<details>
<summary><strong>Routing not taking effect?</strong></summary>

Check that the hook is trusted, the API key reaches the Codex process, a Node
runtime is available to the hook, and at least one valid profile exists in the
active `CODEX_HOME`. Inspect the spawn arguments for explicit model, effort, or
agent type values. Native defaults are the expected fallback when routing cannot
run or Jev defers.

</details>

## Development & contributing

From a repository checkout:

```sh
npm ci
npm run build
npm test
npm run check:dist
git diff --check
```

Development requires Node.js 20+ and npm. Commit the generated
`plugins/codex-subagent-router/dist/jev_router.mjs` alongside source changes.
`check:dist` rebuilds in memory and rejects a stale bundle. The bundle includes
the project and SDK license notices; it runs without `node_modules` and does not
download dependencies at startup.

To test a checkout as a plugin, add its absolute repository path as a marketplace
and install `codex-subagent-router@codex-subagent-router`. Use an isolated
`CODEX_HOME` for tests that add profiles or change hook trust.

[Bug reports](https://github.com/guilhem/codex-subagent-router/issues) and focused
pull requests are welcome. Include your Codex/Node versions and a minimal
example with credentials and private mission content removed.

## License & credits

[MIT](LICENSE). Extracted from
[Astra Advisor PR #12](https://github.com/guilhem/astra-advisor/pull/12), with the
small MIT-licensed adapter attribution to
[jev_codex](https://github.com/Madikhan33/jev_codex). Powered by the
[TypeSafe JavaScript SDK](https://www.npmjs.com/package/@typesafe-ai/sdk).
