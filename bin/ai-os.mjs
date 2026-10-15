#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";
import { applicationRegistry } from "../src/capabilities/catalog.mjs";

await runCli(process.argv.slice(2), { registry: applicationRegistry });
