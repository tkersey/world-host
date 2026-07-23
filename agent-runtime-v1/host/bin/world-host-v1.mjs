#!/usr/bin/env bun
import { runApplicationV1Cli } from '../src/bun/application_v1_cli.mjs';

try {
  process.exitCode = await runApplicationV1Cli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    name: error?.name ?? 'Error',
    code: typeof error?.code === 'string' ? error.code : null,
    message: error?.message ?? String(error),
    details: error?.details ?? null,
  })}\n`);
  process.exitCode = 1;
}
