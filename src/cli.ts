#!/usr/bin/env node

import { runCli } from "./main.js";

void runCli(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
