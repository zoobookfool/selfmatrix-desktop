#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const productLock = JSON.parse(fs.readFileSync(path.join(root, "product-lock.json"), "utf8"));
const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function fail(message) {
  console.error(`[release-inputs] ${message}`);
  process.exit(1);
}

function requireCommit(label, value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    fail(`${label} must be a full lowercase 40-character commit SHA`);
  }
}

function gitHead(directory) {
  return execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

if (productLock.schemaVersion !== 1) fail("unsupported product-lock schemaVersion");
requireCommit("cinny.commit", productLock.cinny && productLock.cinny.commit);
requireCommit("elementCall.commit", productLock.elementCall && productLock.elementCall.commit);

const tag = argument("--tag");
if (tag && tag !== `v${packageJson.version}`) {
  fail(`release tag ${tag} does not match package version v${packageJson.version}`);
}

if (args.includes("--verify-siblings")) {
  const cinnyDir = path.resolve(root, "..", "cinny");
  const elementCallDir = path.resolve(root, "..", "element-call");
  const cinnyHead = gitHead(cinnyDir);
  const elementCallHead = gitHead(elementCallDir);
  if (cinnyHead !== productLock.cinny.commit) {
    fail(`cinny checkout ${cinnyHead} does not match lock ${productLock.cinny.commit}`);
  }
  if (elementCallHead !== productLock.elementCall.commit) {
    fail(`element-call checkout ${elementCallHead} does not match lock ${productLock.elementCall.commit}`);
  }

  const cinnyElementCallRef = fs
    .readFileSync(path.join(cinnyDir, ".selfmatrix", "element-call-ref"), "utf8")
    .trim();
  if (cinnyElementCallRef !== productLock.elementCall.commit) {
    fail(
      `cinny element-call-ref ${cinnyElementCallRef} does not match desktop lock ${productLock.elementCall.commit}`,
    );
  }
}

const envFile = argument("--write-env");
if (envFile) {
  fs.appendFileSync(
    envFile,
    [
      `DESKTOP_VERSION=${packageJson.version}`,
      `CINNY_REPOSITORY=${productLock.cinny.repository}`,
      `CINNY_REF=${productLock.cinny.commit}`,
      `ELEMENT_CALL_REPOSITORY=${productLock.elementCall.repository}`,
      `ELEMENT_CALL_REF=${productLock.elementCall.commit}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

const manifestPath = argument("--write-manifest");
if (manifestPath) {
  const desktopCommit = process.env.GITHUB_SHA || gitHead(root);
  requireCommit("desktop commit", desktopCommit);
  const manifest = {
    schemaVersion: 1,
    version: packageJson.version,
    desktop: { repository: "zoobookfool/selfmatrix-desktop", commit: desktopCommit },
    cinny: productLock.cinny,
    elementCall: productLock.elementCall,
  };
  const output = path.resolve(root, manifestPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

console.log(
  `[release-inputs] OK desktop=${packageJson.version} cinny=${productLock.cinny.commit} element-call=${productLock.elementCall.commit}`,
);
