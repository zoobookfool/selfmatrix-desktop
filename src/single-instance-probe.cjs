#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const electronExecutable = require("electron");
const mainScript = path.join(__dirname, "main.cjs");
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "selfmatrix-single-instance-"));
const userDataDir = path.join(probeDir, "user-data");
const readyPath = path.join(probeDir, "ready");
const resultPath = path.join(probeDir, "result.json");
const args = [
  mainScript,
  "--single-instance-probe",
  `--single-instance-probe-dir=${probeDir}`,
  `--user-data-dir=${userDataDir}`,
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process ${child.pid} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function main() {
  const first = spawn(electronExecutable, args, { stdio: ["ignore", "pipe", "pipe"] });
  let firstOutput = "";
  first.stdout.on("data", (chunk) => {
    firstOutput += chunk;
  });
  first.stderr.on("data", (chunk) => {
    firstOutput += chunk;
  });

  try {
    await waitForFile(readyPath, 15_000);
    const second = spawn(electronExecutable, args, { stdio: "ignore" });
    const secondExit = await waitForExit(second, 15_000);
    const firstExit = await waitForExit(first, 15_000);
    await waitForFile(resultPath, 1_000);
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const pass = secondExit.code === 0 && firstExit.code === 0 && result.pass === true;
    if (!pass) {
      throw new Error(
        `single-instance probe failed: ${JSON.stringify({ secondExit, firstExit, result, firstOutput }, null, 2)}`,
      );
    }
    console.log("[single-instance-probe] PASS", JSON.stringify(result));
  } finally {
    if (first.exitCode === null && !first.killed) first.kill();
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
