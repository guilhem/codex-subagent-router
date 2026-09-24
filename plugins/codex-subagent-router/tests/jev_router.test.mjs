import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DEFER, INSTRUCTIONS, loadProfiles, main, missionFrom, MODEL, route, selectedProfile } from '../scripts/jev_router.mjs';

const script = fileURLToPath(new URL('../scripts/jev_router.mjs', import.meta.url));
const event = (tool_input = { message: 'Run tests' }, changes = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', model: 'active-parent-is-not-a-pin', tool_input, ...changes,
});
const profile = (description = 'Implement or test code', model = 'custom/model-42', reasoning_effort = 'high') =>
  ({ description, model, reasoning_effort });
const answer = (profiles, selected = 'build') => ({
  model: MODEL,
  answers: { route: {
    type: 'choice', choice: selected,
    probabilities: Object.fromEntries([...profiles.keys(), 'defer'].map(id => [id, Number(id === selected)])),
    confidence: 0.85,
  } },
  usage: { input_tokens: 10, output_tokens: 2 },
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'jev-router-'));
  const dir = join(home, 'subagent-router');
  await mkdir(dir);
  const env = { CODEX_HOME: process.env.CODEX_HOME, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    JEV_API_KEY: process.env.JEV_API_KEY };
  process.env.CODEX_HOME = home;
  process.env.TYPESAFE_API_KEY = 'key';
  delete process.env.JEV_API_KEY;
  t.after(async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  const add = (id, data = profile()) => writeFile(join(dir, `${id}.json`), JSON.stringify(data));
  await add('build');
  await add('observe', profile('Read files and run checks', 'other/provider', 'max'));
  const warnings = [];
  t.mock.method(console, 'error', (...args) => warnings.push(args.join(' ')));
  return { home, dir, add, warnings };
}

function transport(t, responses) {
  const requests = [];
  const outcomes = [...responses];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('unexpected extra fetch');
    return Response.json(next.body ?? { error: { message: 'SECRET remote failure' } }, { status: next.status });
  });
  return requests;
}

test('direct executable keeps native defaults for missing key and malformed Unicode input', async t => {
  const { home } = await fixture(t);
  const noKey = { ...process.env, CODEX_HOME: home, TYPESAFE_API_KEY: '', JEV_API_KEY: '' };
  delete noKey.NODE_TEST_CONTEXT;
  const run = input => spawnSync(process.execPath, [script], { input, env: noKey, encoding: 'utf8', timeout: 5000 });
  const normal = run(JSON.stringify(event()));
  assert.equal(normal.error, undefined);
  assert.equal(normal.status, 0);
  assert.equal(normal.stdout, '');
  assert.match(normal.stderr, /Jev routing unavailable; using native spawn defaults\./);
  const malformed = run(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
  assert.equal(malformed.error, undefined);
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr, '');
});

test('main preserves native input and prints chosen input', async t => {
  const { warnings } = await fixture(t);
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  t.after(() => Object.defineProperty(process, 'stdin', stdin));
  const output = [];
  const write = t.mock.method(process.stdout, 'write', value => { output.push(value); return true; });
  const run = async input => {
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([input]) });
    await main();
  };
  delete process.env.TYPESAFE_API_KEY;
  await run(Buffer.from(JSON.stringify(event())));
  assert.deepEqual(output, []);
  assert.deepEqual(warnings, ['Jev routing unavailable; using native spawn defaults.']);
  await run(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
  assert.deepEqual(output, []);
  assert.equal(warnings.length, 1);
  process.env.TYPESAFE_API_KEY = 'key';
  const profiles = await loadProfiles();
  transport(t, [{ status: 200, body: answer(profiles) }]);
  await run(Buffer.from(JSON.stringify(event())));
  assert.deepEqual(JSON.parse(output[0]).hookSpecificOutput.updatedInput,
    { message: 'Run tests', model: 'custom/model-42', reasoning_effort: 'high' });
  write.mock.restore();
});

test('explicit pins and unrelated inputs skip catalog and provider', async t => {
  const { dir, warnings } = await fixture(t);
  await writeFile(join(dir, 'api-key'), Buffer.from([0xff]));
  delete process.env.TYPESAFE_API_KEY;
  const inputs = [
    null, [], {}, { hook_event_name: 'SubagentStart' }, event(undefined, { tool_name: 'Agent' }),
    event(undefined, { tool_name: 'multi_agent_v1__spawn_agent' }), event({ message: ' ' }),
    event({ message: 'Run', model: 'pinned' }), event({ message: 'Run', model: '' }),
    event({ message: 'Run', reasoning_effort: 'low' }), event({ message: 'Run', agent_type: 'reviewer' }),
    event({ items: [{ type: 'image', image_url: 'data:' }] }),
    event({ items: [{ type: 'text', text: 'Run' }, { type: 'image' }] }),
    event({ message: 'Run', items: [{ type: 'text', text: 'Tests' }] }),
    event({ items: [{ type: 'text', text: '  ' }] }),
  ];
  const requests = transport(t, []);
  for (const input of inputs) assert.equal(await route(input), null);
  assert.deepEqual(warnings, []);
  process.env.CODEX_HOME = join(process.env.CODEX_HOME, 'missing');
  assert.equal(await route(event()), null);
  assert.deepEqual(warnings, []);
  assert.equal(requests.length, 0);
  assert.equal(missionFrom({ items: [{ type: 'text', text: ' Implement' }, { type: 'text', text: 'tests ' }] }), 'Implement\ntests');
});

test('file key is trimmed, ignored by profiles, and follows both environment keys', async t => {
  const { dir, warnings } = await fixture(t);
  const profiles = await loadProfiles();
  await writeFile(join(dir, 'api-key'), '  file-secret\n');
  assert.deepEqual([...await loadProfiles()].map(([id]) => id), [...profiles.keys()]);
  const requests = transport(t, Array(4).fill({ status: 200, body: answer(profiles) }));
  delete process.env.TYPESAFE_API_KEY;
  assert.equal((await route(event())).hookSpecificOutput.updatedInput.model, 'custom/model-42');
  process.env.JEV_API_KEY = 'jev-secret';
  await route(event());
  process.env.TYPESAFE_API_KEY = 'typesafe-secret';
  await route(event());
  process.env.TYPESAFE_API_KEY = '';
  process.env.JEV_API_KEY = '';
  await route(event());
  assert.deepEqual(requests.map(request => request.init.headers.Authorization), [
    'Bearer file-secret', 'Bearer jev-secret', 'Bearer typesafe-secret', 'Bearer file-secret',
  ]);
  assert.deepEqual(warnings, []);
});

test('missing, empty, unreadable, and malformed file keys keep native defaults privately', async t => {
  const { dir, warnings } = await fixture(t);
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_API_KEY;
  const requests = transport(t, []);
  const key = join(dir, 'api-key');
  assert.equal(await route(event()), null);
  await writeFile(key, ' \n ');
  assert.equal(await route(event()), null);
  await writeFile(key, Buffer.concat([Buffer.from('SECRET-file-key'), Buffer.from([0xff])]));
  assert.equal(await route(event()), null);
  await rm(key);
  await mkdir(key);
  assert.equal(await route(event()), null);
  assert.deepEqual(warnings, Array(4).fill('Jev routing unavailable; using native spawn defaults.'));
  assert.doesNotMatch(warnings.join(' '), /SECRET-file-key|api-key/);
  assert.equal(requests.length, 0);
});

test('fresh profiles, SDK request, preserved input, defer, and special profile IDs', async t => {
  const { add, warnings } = await fixture(t);
  const original = { items: [{ type: 'text', text: ' Implement' }, { type: 'text', text: 'tests ' }],
    model: null, reasoning_effort: null, fork_context: true, custom: { keep: [1, 2] } };
  let selected = 'build';
  const response = { status: 200, get body() { return answer(new Map(Object.entries(requests.at(-1).body.questions.route.criteria)), selected); } };
  const requests = transport(t, Array(4).fill(response));
  const result = await route(event(original));
  assert.deepEqual(result.hookSpecificOutput.updatedInput, { ...original, model: 'custom/model-42', reasoning_effort: 'high' });
  assert.equal(original.model, null);
  assert.equal(requests[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer key');
  assert.deepEqual(requests[0].body, { model: MODEL, state: { mission: 'Implement\ntests' },
    questions: { route: { type: 'choice', instructions: INSTRUCTIONS,
      criteria: { build: 'Implement or test code', observe: 'Read files and run checks', defer: DEFER } } } });

  await add('build', profile('Updated', 'updated/model', 'low'));
  await add('__proto__', profile('Special', 'special/model', 'max'));
  await add('constructor', profile('Another special', 'constructor/model', 'medium'));
  selected = '__proto__';
  assert.equal((await route(event())).hookSpecificOutput.updatedInput.model, 'special/model');
  assert.deepEqual(Object.keys(requests[1].body.questions.route.criteria), ['__proto__', 'build', 'constructor', 'observe', 'defer']);
  selected = 'build';
  assert.equal((await route(event())).hookSpecificOutput.updatedInput.model, 'updated/model');
  selected = 'defer';
  assert.equal(await route(event()), null);
  assert.deepEqual(warnings, []);
});

test('empty, invalid, reserved, malformed UTF-8, and excessive catalogs never call provider', async t => {
  const { dir, add, warnings } = await fixture(t);
  const requests = transport(t, []);
  await rm(join(dir, 'build.json'));
  await rm(join(dir, 'observe.json'));
  assert.equal(await route(event()), null);
  await add('valid');
  const invalid = [
    ['defer.json', '{}', 'reserved id'], ['bad.json', '{"model":"SECRET', 'invalid JSON'],
    ['bad.json', '[]', 'expected JSON object'],
    ['bad.json', JSON.stringify(profile(' ', 'SECRET')), 'description must be a nonempty string'],
    ['bad.json', JSON.stringify(profile('safe', 2)), 'model must be a nonempty string'],
    ['bad.json', JSON.stringify(profile('safe', 'x', null)), 'reasoning_effort must be a nonempty string'],
    ['bad.json', Buffer.from([0xff]), 'invalid JSON'],
  ];
  for (const [name, content, reason] of invalid) {
    await writeFile(join(dir, name), content);
    assert.equal(await route(event()), null);
    assert.match(warnings.at(-1), new RegExp(reason));
    assert.doesNotMatch(warnings.at(-1), /SECRET/);
    await rm(join(dir, name));
  }
  await Promise.all(Array.from({ length: 253 }, (_, i) => add(`p${String(i).padStart(3, '0')}`)));
  assert.equal((await loadProfiles()).size, 254);
  await add('one_more');
  assert.equal(await route(event()), null);
  assert.match(warnings.at(-1), /more than 254 profiles/);
  assert.equal(requests.length, 0);
});

test('254 profiles plus defer are sent and chosen safely', async t => {
  const { add } = await fixture(t);
  await Promise.all(Array.from({ length: 252 }, (_, i) => add(`p${String(i).padStart(3, '0')}`)));
  const profiles = await loadProfiles();
  const requests = transport(t, [{ status: 200, body: answer(profiles, 'p251') }]);
  assert.equal((await route(event())).hookSpecificOutput.updatedInput.model, 'custom/model-42');
  assert.equal(Object.keys(requests[0].body.questions.route.criteria).length, 255);
  assert.ok(Object.hasOwn(requests[0].body.questions.route.criteria, 'p251'));
});

test('direct JSON symlink to a file remains a profile', async t => {
  const { dir } = await fixture(t);
  await symlink('build.json', join(dir, 'linked.json'));
  const profiles = await loadProfiles();
  assert.ok(profiles.has('linked'));
  const requests = transport(t, [{ status: 200, body: answer(profiles, 'linked') }]);
  assert.equal((await route(event())).hookSpecificOutput.updatedInput.model, 'custom/model-42');
  assert.ok(Object.hasOwn(requests[0].body.questions.route.criteria, 'linked'));
});

test('response validation rejects malformed probabilities, confidence, model, and unknown choices', async t => {
  const { warnings } = await fixture(t);
  const profiles = await loadProfiles();
  const mutations = [
    a => { a.answers.route.choice = 'unknown'; },
    a => { delete a.answers.route.probabilities.observe; },
    a => { a.answers.route.probabilities.extra = 0; },
    a => { a.answers.route.probabilities.build = NaN; },
    a => { a.answers.route.probabilities.build = 0.2; },
    a => { a.answers.route.probabilities.build = 0.49; a.answers.route.probabilities.observe = 0.51; },
    a => { a.answers.route.confidence = 1.1; },
    a => { a.model = 'unexpected'; },
  ];
  for (const mutate of mutations) {
    const response = answer(profiles);
    mutate(response);
    assert.equal(selectedProfile(response, profiles), null);
  }
  const responses = mutations.map(mutate => {
    const body = answer(profiles); mutate(body); return { status: 200, body };
  });
  transport(t, responses);
  for (const _ of mutations) assert.equal(await route(event()), null);
  assert.equal(warnings.length, mutations.length);
});

test('real SDK handles 403, retries 503, and keeps remote errors out of diagnostics', async t => {
  const { warnings } = await fixture(t);
  const profiles = await loadProfiles();
  const requests = transport(t, [
    { status: 403 }, { status: 503 }, { status: 200, body: answer(profiles) },
    { status: 503 }, { status: 503 }, { status: 503 },
  ]);
  assert.equal(await route(event()), null);
  assert.equal(requests.length, 1);
  assert.equal((await route(event())).hookSpecificOutput.updatedInput.model, 'custom/model-42');
  assert.equal(requests.length, 3);
  assert.equal(await route(event()), null);
  assert.equal(requests.length, 6);
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(warnings.join(' '), /SECRET/);
});

test('whole-call timeout aborts the SDK during a pending fetch', async t => {
  const { warnings } = await fixture(t);
  const timeout = AbortSignal.timeout;
  const budgets = [];
  t.mock.method(AbortSignal, 'timeout', ms => { budgets.push(ms); return timeout(30); });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    attempts++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('SECRET abort')), { once: true }));
  });
  assert.equal(await route(event()), null);
  assert.deepEqual(budgets, [10_000]);
  assert.equal(attempts, 1);
  assert.deepEqual(warnings, ['Jev routing unavailable; using native spawn defaults.']);
});
