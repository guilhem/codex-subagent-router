import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'plugins/codex-subagent-router/dist/jev_router.mjs');
const licenses = await Promise.all([
  readFile(resolve(root, 'LICENSE'), 'utf8'),
  readFile(resolve(root, 'node_modules/@typesafe-ai/sdk/LICENSE'), 'utf8'),
]);
const { outputFiles } = await build({
  absWorkingDir: root,
  entryPoints: ['plugins/codex-subagent-router/scripts/jev_router.mjs'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: `/*!\nCodex Subagent Router\n${licenses[0]}\nTypeSafe SDK\n${licenses[1]}*/` },
  write: false,
});
const contents = outputFiles[0].text;
if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (current !== contents) {
    console.error('Bundled router is stale; run npm run build.');
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
}
