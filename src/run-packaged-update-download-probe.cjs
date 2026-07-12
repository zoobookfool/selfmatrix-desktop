#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const appRoot = path.resolve(__dirname, "..");
const executable = path.join(appRoot, "dist", "win-unpacked", "SelfMatrix.exe");
const evidencePath = path.join(
  appRoot,
  "dist",
  "win-unpacked",
  "resources",
  "app",
  "evidence",
  "update-download-probe-result.json",
);

fs.rmSync(evidencePath, { force: true });
const result = spawnSync(executable, ["--update-download-probe"], {
  cwd: path.dirname(executable),
  encoding: "utf8",
  stdio: "inherit",
  timeout: 120_000,
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`packaged update probe exited with status ${result.status}`);
}
if (!fs.existsSync(evidencePath)) {
  throw new Error(`packaged update probe evidence not found: ${evidencePath}`);
}

const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
if (!evidence.pass || evidence.packaged !== true) {
  throw new Error(`packaged update probe failed: ${JSON.stringify(evidence, null, 2)}`);
}

console.log("[packaged-update-download-probe] PASS", JSON.stringify(evidence, null, 2));
