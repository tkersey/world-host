#!/usr/bin/env bun
import { runBunCli } from '../src/bun/bun_cli.mjs';

process.exitCode = await runBunCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
