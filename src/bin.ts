#!/usr/bin/env node

import process from 'node:process';

import { main } from './cli.js';

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
