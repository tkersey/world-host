#!/usr/bin/env node
import { runNodeCli } from '../src/node/node_cli.mjs';

await runNodeCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
