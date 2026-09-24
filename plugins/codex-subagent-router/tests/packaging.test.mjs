import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const plugin = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const nodeName = windows ? 'node.exe' : 'node';
const shell = windows ? process.env.ComSpec : '/bin/sh';
const mission = 'Run existing checks';
const event = { hook_event_name: 'PreToolUse', tool_name: 'spawn_agent',
  tool_input: { message: mission, fork_context: false, custom: { keep: true } } };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'router package with spaces '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'installed plugin');
  for (const file of ['dist/jev_router.mjs', 'hooks/hooks.json', 'scripts/launch_router', 'scripts/launch_router.cmd']) {
    const target = join(installed, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(plugin, file), target);
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (!windows) symlinkSync(shell, join(bin, 'sh'));
  const home = join(root, 'home');
  const catalog = join(home, 'subagent-router');
  mkdirSync(catalog, { recursive: true });
  writeFileSync(join(catalog, 'build.json'), JSON.stringify({
    description: 'Implement or test code', model: 'test/model', reasoning_effort: 'high',
  }));
  const preload = join(root, 'mock fetch.mjs');
  writeFileSync(preload, `
    import assert from 'node:assert/strict';
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer test-secret');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.state, { mission: ${JSON.stringify(mission)} });
      assert.equal(body.model, 'jev-1.13.0');
      assert.equal(body.questions.route.type, 'choice');
      assert.equal(body.questions.route.criteria.build, 'Implement or test code');
      assert.equal(Object.keys(body.questions.route.criteria).length, 2);
      return Response.json({ model: body.model, answers: { route: {
        type: 'choice', choice: 'build', probabilities: { build: 1, defer: 0 }, confidence: 1,
      } }, usage: { input_tokens: 1, output_tokens: 1 } });
    };
  `);
  const env = {
    PATH: bin, HOME: home, USERPROFILE: home, CODEX_HOME: home,
    LOCALAPPDATA: join(root, 'appdata'), XDG_CACHE_HOME: join(root, 'cache'),
    TYPESAFE_API_KEY: 'test-secret', TYPESAFE_LOG_LEVEL: 'debug',
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  };
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const config = JSON.parse(readFileSync(join(installed, 'hooks/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(config.hooks), ['PreToolUse']);
  const [group] = config.hooks.PreToolUse;
  assert.equal(group.matcher, '^spawn_agent$');
  const [handler] = group.hooks;
  assert.equal(handler.type, 'command');
  assert.equal(handler.timeout, 15);
  const command = handler[windows ? 'commandWindows' : 'command'].replaceAll('${PLUGIN_ROOT}', installed);
  function run(extraEnv = {}, input = event) {
    return spawnSync(shell, windows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], {
      cwd: root, env: { ...env, ...extraEnv }, input: JSON.stringify(input), encoding: 'utf8',
      timeout: 5_000, windowsVerbatimArguments: windows,
    });
  }
  return { root, bin, env, run };
}

function expectRoute(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { ...event.tool_input, model: 'test/model', reasoning_effort: 'high' },
  } });
}

function placeNode(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (windows) copyFileSync(process.execPath, path);
  else symlinkSync(process.execPath, path);
}

test('installed bundle and SDK run with only the Codex runtime and preserve explicit pins', t => {
  const { run } = fixture(t);
  expectRoute(run({ CODEX_MCP_NODE_PATH: process.execPath }));
  const pinned = run({ CODEX_MCP_NODE_PATH: process.execPath }, {
    ...event, tool_input: { message: 'Must not call the provider', model: 'explicit' },
  });
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, '');
  assert.equal(pinned.stderr, '');
});

test('launcher discovers the desktop resource directory and cached runtime', t => {
  const { root, env, run } = fixture(t);
  const resources = join(root, 'desktop resources');
  placeNode(join(resources, 'cua_node', 'bin', nodeName));
  expectRoute(run({ CODEX_ELECTRON_RESOURCES_PATH: resources }));
  placeNode(join(env.XDG_CACHE_HOME, 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', nodeName));
  expectRoute(run());
});

test('standalone CLI uses Node from PATH and missing Node keeps native defaults', t => {
  const { bin, run } = fixture(t);
  const missing = run({ CODEX_MCP_NODE_PATH: join(bin, 'missing-node') });
  assert.equal(missing.error, undefined);
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Node\.js 20\+ not found/);
  assert.doesNotMatch(missing.stderr, /test-secret|Run existing checks/);
  placeNode(join(bin, nodeName));
  expectRoute(run());
});
