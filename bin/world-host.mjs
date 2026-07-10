#!/usr/bin/env bun
import { runBunCli } from '../src/bun/bun_cli.mjs';

try {
  process.exitCode = await runBunCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error) {
  if (process.env.WORLD_HOST_CLI_ERROR_JSON === '1') {
    process.stderr.write(`${JSON.stringify({
      name: error?.name ?? 'Error',
      code: typeof error?.code === 'string' ? error.code : null,
      message: error?.message ?? String(error),
      details: error?.details ?? null,
    })}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
