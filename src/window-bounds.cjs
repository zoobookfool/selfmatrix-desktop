"use strict";

const MIN_VISIBLE_WIDTH = 80;
const MIN_VISIBLE_HEIGHT = 80;
const MIN_WINDOW_WIDTH = 480;
const MIN_WINDOW_HEIGHT = 320;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function intersection(rect, workArea) {
  const left = Math.max(rect.x, workArea.x);
  const top = Math.max(rect.y, workArea.y);
  const right = Math.min(rect.x + rect.width, workArea.x + workArea.width);
  const bottom = Math.min(rect.y + rect.height, workArea.y + workArea.height);
  return {
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function fitToWorkArea(bounds, workArea) {
  const width = clamp(Math.round(bounds.width), Math.min(MIN_WINDOW_WIDTH, workArea.width), workArea.width);
  const height = clamp(
    Math.round(bounds.height),
    Math.min(MIN_WINDOW_HEIGHT, workArea.height),
    workArea.height,
  );
  const x = clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width);
  const y = clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height);
  return { x, y, width, height };
}

function centeredBounds(bounds, workArea) {
  const fitted = fitToWorkArea({ ...bounds, x: workArea.x, y: workArea.y }, workArea);
  return {
    ...fitted,
    x: Math.round(workArea.x + (workArea.width - fitted.width) / 2),
    y: Math.round(workArea.y + (workArea.height - fitted.height) / 2),
  };
}

function restoreWindowBounds(savedBounds, workAreas) {
  if (!savedBounds || !Array.isArray(workAreas) || workAreas.length === 0) return savedBounds || null;

  let bestWorkArea = workAreas[0];
  let bestIntersection = { width: 0, height: 0 };
  let bestArea = 0;
  for (const workArea of workAreas) {
    const visible = intersection(savedBounds, workArea);
    const area = visible.width * visible.height;
    if (area > bestArea) {
      bestArea = area;
      bestIntersection = visible;
      bestWorkArea = workArea;
    }
  }

  if (bestIntersection.width < MIN_VISIBLE_WIDTH || bestIntersection.height < MIN_VISIBLE_HEIGHT) {
    return centeredBounds(savedBounds, workAreas[0]);
  }
  return fitToWorkArea(savedBounds, bestWorkArea);
}

module.exports = { restoreWindowBounds, intersection };
