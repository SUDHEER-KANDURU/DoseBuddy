import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");

test("Today's Medicines action column prevents awkward button collapse and wrapping", async () => {
  const css = await source("DoseBuddy_frontend/style.css");

  // Action column headers and cells must maintain adequate min-width and nowrap on desktop
  assert.match(css, /\.schedule-table th:last-child\s*\{[\s\S]*?min-width:\s*160px/);
  assert.match(css, /\.schedule-table td:last-child\s*\{[\s\S]*?min-width:\s*160px/);

  // action-cell and dose-action-group must use flex-wrap: nowrap to prevent multi-line wrap on desktop
  assert.match(css, /\.action-cell\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?flex-wrap:\s*nowrap/);
  assert.match(css, /\.dose-action-group\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?flex-wrap:\s*nowrap/);
});

test("action buttons in table rows have compact, intentional sizing and are not bloated to 44px", async () => {
  const css = await source("DoseBuddy_frontend/style.css");

  // Base action-btn must have min-height: 32px with centered content
  assert.match(css, /\.action-btn\s*\{[\s\S]*?min-height:\s*32px;[\s\S]*?text-align:\s*center/);

  // 768px media query must NOT force action-btn into 44px height or ragged column
  assert.doesNotMatch(css, /@media \(max-width:\s*768px\)[\s\S]*?\.primary-btn,\s*\.action-btn/);
  assert.doesNotMatch(css, /@media \(max-width:\s*768px\)[\s\S]*?\.action-cell\s*\{\s*flex-direction:\s*column;\s*align-items:\s*flex-start/);
});

test("narrow screens provide a neat, cohesive vertical stack with equal width buttons", async () => {
  const [styleCss, responsiveCss] = await Promise.all([
    source("DoseBuddy_frontend/style.css"),
    source("DoseBuddy_frontend/responsive.css")
  ]);

  // 540px media query in style.css sets stretch alignment and equal width buttons
  assert.match(styleCss, /@media \(max-width:\s*540px\)[\s\S]*?\.schedule-table \.action-cell[\s\S]*?align-items:\s*stretch/);
  assert.match(styleCss, /@media \(max-width:\s*540px\)[\s\S]*?\.schedule-table \.action-btn\s*\{[\s\S]*?width:\s*100%/);

  // 480px media query in responsive.css ensures stretch alignment and centered text
  assert.match(responsiveCss, /@media \(max-width:\s*480px\)[\s\S]*?\.action-cell\s*\{[\s\S]*?align-items:\s*stretch/);
  assert.match(responsiveCss, /@media \(max-width:\s*480px\)[\s\S]*?\.schedule-table \.action-btn\s*\{[\s\S]*?width:\s*100%/);
});

test("table display is controlled by CSS media queries rather than hardcoded inline style in JS", async () => {
  const [appJs, responsiveCss] = await Promise.all([
    source("DoseBuddy_frontend/app.js"),
    source("DoseBuddy_frontend/responsive.css")
  ]);

  // app.js must clear inline display so CSS handles responsiveness dynamically
  assert.match(appJs, /scheduleTable\.style\.display\s*=\s*""/);
  assert.doesNotMatch(appJs, /scheduleTable\.style\.display\s*=\s*window\.innerWidth\s*<=\s*767/);

  // responsive.css mobile card reflow enforces display block
  assert.match(responsiveCss, /#schedule-table,[\s\S]*?display:\s*block !important/);
});
