#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { main } from './cli.js';

export { main, runCli, runProcessCli } from './cli.js';
export {
  BATCH_TOOL_NAMES,
  createBatchTasksServer,
  getAssignment,
  reportFailure,
  runMcpServer,
  submitResult,
} from './mcp-server.js';

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
