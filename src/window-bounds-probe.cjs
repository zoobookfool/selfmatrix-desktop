#!/usr/bin/env node
"use strict";

const { restoreWindowBounds } = require("./window-bounds.cjs");

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -1280, y: 0, width: 1280, height: 1024 };
const cases = [
  {
    name: "visible bounds are preserved",
    actual: restoreWindowBounds({ x: 200, y: 100, width: 960, height: 640 }, [primary, left]),
    expected: { x: 200, y: 100, width: 960, height: 640 },
  },
  {
    name: "detached monitor bounds return to primary center",
    actual: restoreWindowBounds({ x: 3000, y: 100, width: 960, height: 640 }, [primary]),
    expected: { x: 480, y: 200, width: 960, height: 640 },
  },
  {
    name: "negative-coordinate monitor remains selected",
    actual: restoreWindowBounds({ x: -1200, y: 80, width: 900, height: 700 }, [primary, left]),
    expected: { x: -1200, y: 80, width: 900, height: 700 },
  },
  {
    name: "oversized window fits work area",
    actual: restoreWindowBounds({ x: -100, y: -100, width: 4000, height: 3000 }, [primary]),
    expected: { x: 0, y: 0, width: 1920, height: 1040 },
  },
  {
    name: "tiny window is raised to minimum size",
    actual: restoreWindowBounds({ x: 100, y: 100, width: 20, height: 20 }, [primary]),
    expected: { x: 720, y: 360, width: 480, height: 320 },
  },
];

let pass = true;
for (const testCase of cases) {
  const casePass = JSON.stringify(testCase.actual) === JSON.stringify(testCase.expected);
  pass = pass && casePass;
  if (!casePass) {
    console.error(
      `[window-bounds-probe] FAIL ${testCase.name}: expected=${JSON.stringify(testCase.expected)} actual=${JSON.stringify(testCase.actual)}`,
    );
  }
}

if (!pass) process.exitCode = 1;
else console.log(`[window-bounds-probe] PASS ${cases.length} cases`);
