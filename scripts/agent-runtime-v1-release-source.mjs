import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const WORLD_HOST_RELEASE_SOURCE_PATHS = Object.freeze([
  'bin/world-host-v1.mjs',
  'docs',
  'scripts/agent-runtime-v1-release-source.mjs',
  'scripts/build-agent-runtime-v1.mjs',
  'scripts/check-agent-runtime-v1-pack.mjs',
  'scripts/run-agent-runtime-v1-conformance.mjs',
  'src/bun/application_v1_cli.mjs',
  'src/bun/application_v1_inspection_worker.mjs',
  'src/v1',
]);

export const WORLD_HOST_RUNTIME_SOURCE_PATHS = Object.freeze([
  'bin/world-host-v1.mjs',
  'src/bun/application_v1_cli.mjs',
  'src/bun/application_v1_inspection_worker.mjs',
  'src/v1',
]);

export async function worldHostReleaseSourceEvidence(repository) {
  const commit = await resolveWorldHostReleaseSourceCommit(repository);
  return Object.freeze({
    expectedWorldHostGitCommit: commit,
    expectedWorldHostSourceSha256: await worldHostReleaseSourceSha256(repository, commit),
  });
}

export async function resolveWorldHostReleaseSourceCommit(repository) {
  // Packaging sources must be clean, but only executable sources own the
  // embedded runtime identity. A squash merge may rewrite packaging commits
  // after the pack is built without changing the shipped host bytes.
  const output = await gitBytes(repository, [
    'log',
    '-1',
    '--format=%H',
    '--',
    ...WORLD_HOST_RUNTIME_SOURCE_PATHS,
  ]);
  const commit = new TextDecoder().decode(output).trim();
  assert(/^[0-9a-f]{40}$/.test(commit), 'invalid reviewed world-host source commit');
  return commit;
}

export async function worldHostReleaseSourceSha256(repository, commit) {
  assert(/^[0-9a-f]{40}$/.test(commit), 'invalid reviewed world-host source commit');
  const output = await gitBytes(repository, [
    'ls-tree',
    '-r',
    '--name-only',
    commit,
    '--',
    ...WORLD_HOST_RUNTIME_SOURCE_PATHS,
  ]);
  const sourcePaths = new TextDecoder().decode(output).trim().split('\n').filter(Boolean);
  assert(sourcePaths.length > 0, 'reviewed world-host source commit has no runtime files');
  const entries = await Promise.all(sourcePaths.map(async (sourcePath) => {
    const bytes = await gitBytes(repository, ['show', `${commit}:${sourcePath}`]);
    return [`host/${sourcePath}`, createHash('sha256').update(bytes).digest('hex')];
  }));
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) =>
    left.localeCompare(right))));
}

async function gitBytes(repository, args) {
  const command = Bun.spawn(['git', ...args], {
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errorOutput, exitCode] = await Promise.all([
    new Response(command.stdout).arrayBuffer(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  assert.equal(exitCode, 0, errorOutput || `git ${args[0]} failed`);
  return Buffer.from(output);
}
