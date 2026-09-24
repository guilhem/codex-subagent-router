# Codex Subagent Router

A Codex plugin with one native `PreToolUse` hook. When an agent delegates without
an explicit model or reasoning effort, the router asks Jev to choose from your
task profiles. The parent only needs to describe the mission.

## Install

```sh
codex plugin marketplace add guilhem/codex-subagent-router --ref main
codex plugin add codex-subagent-router@codex-subagent-router
python3 -m pip install 'typesafe-sdk==0.7.1'
```

Install the SDK in the Python environment used by the hook's `python3` command
(Python 3.10+). Set `TYPESAFE_API_KEY` in the Codex process environment;
`JEV_API_KEY` is also supported. The router never loads a workspace `.env` file.
Review and trust the plugin hook in Codex `/hooks`, then start a fresh session.

Leave `model` and `reasoning_effort` unset on native `spawn_agent` calls unless
you want to pin them. Personal agent instructions that require these fields on
every spawn take precedence and prevent automatic routing.

## Add task profiles

The router reads every `*.json` file directly inside
`$CODEX_HOME/subagent-router/`, or `~/.codex/subagent-router/` when `CODEX_HOME`
is unset. It rereads the directory on every delegation. It does not write profiles.

For example, create `myteam-implementation.json` in that directory:

```json
{
  "description": "Ordinary code or test changes under a clear contract; standard technical review.",
  "model": "gpt-6-sol",
  "reasoning_effort": "high"
}
```

Each profile requires those three nonempty strings. Its filename without `.json`
is its choice identifier. `defer` is reserved. Several profiles can use the same
model; describe the work each profile fits, including distinctions from nearby
choices. A model must be available on your Codex host.

Skills, plugins, and users can add profiles to this shared directory. Prefix
filenames with the producer's name to avoid collisions, and preserve existing
user-edited files. The producer owns installation, updates, and removal. No
registration is needed. [Astra Advisor](https://github.com/guilhem/astra-advisor)
provides profiles for routine work, implementation, and complex technical work.

Jev receives the mission and all profile descriptions in one `Choice` question,
plus `defer` for missing context or no suitable profile. The router copies the
chosen profile's model and effort into the spawn arguments; it does not change
the mission or other arguments. Model capabilities and task categories are not
hardcoded in the router.

## Precedence and fallback

An explicit non-null `model`, `reasoning_effort`, or `agent_type` bypasses routing,
including catalog reads and provider calls. Explicit settings remain authoritative.

An empty or invalid catalog, missing SDK or credential, invalid Jev response,
provider failure, or `defer` leaves native inheritance/defaults in place. One
invalid profile invalidates the catalog for that call; the router never silently
uses only part of it. Diagnostics omit profile contents, missions, and credentials.

The catalog supports up to 254 profiles plus `defer`, within the
[255-option Choice limit](https://docs.typesafe.ai/primitives/choice). Larger
catalogs fall back without truncation. The SDK has at most two retries within a
10-second retry budget; Codex caps the hook at 15 seconds. No confidence threshold
is applied. Selection is a configured model request, not proof of provider execution.

## Development

```sh
python3 -m pip install -r plugins/codex-subagent-router/requirements.txt
python3 -B -m unittest discover -s plugins/codex-subagent-router/tests
git diff --check
```

To test a checkout as a plugin, add its absolute repository path as a marketplace
and install `codex-subagent-router@codex-subagent-router`. Use an isolated
`CODEX_HOME` for tests that add profiles or change hook trust.

The implementation was extracted from
[Astra Advisor PR #12](https://github.com/guilhem/astra-advisor/pull/12) and retains
the small MIT-licensed adapter attribution to
[jev_codex](https://github.com/Madikhan33/jev_codex). It uses the TypeSafe Python SDK;
no separate routing service or agent-facing tool is required.
