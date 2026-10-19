import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Regression tests for the inline "Other" text input on guided AI conversation
// options (FEAT: ai-assistant-other-input).
//
// There is no DOM in the node:test unit runner so — following the same pattern as
// tests/ai-assistant-frontend.test.ts — these read DoseBuddy_frontend/app.js as
// source text and assert against it with assert.match / assert.doesNotMatch.

async function loadAppSource(): Promise<string> {
  return readFile(new URL("../DoseBuddy_frontend/app.js", import.meta.url), "utf8");
}

// ── Helper: extract a named top-level function ────────────────────────────────
function extractFunction(source: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  assert.ok(m, `function ${name} must exist in app.js`);
  const open = source.indexOf("{", m.index!);
  assert.ok(open >= 0, `function ${name} must have a body`);
  let depth = 0;
  let i = open;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  assert.ok(depth === 0, `function ${name} braces must be balanced`);
  return source.slice(m.index, i);
}

// ── Helper: run isOtherOption from app.js in this process ─────────────────────
async function loadIsOtherOption(): Promise<(option: unknown) => boolean> {
  const source = await loadAppSource();
  const fn = extractFunction(source, "isOtherOption");
  // Evaluate the function body and return the callable
  return new Function(`${fn}; return isOtherOption;`)() as (option: unknown) => boolean;
}

// ── isOtherOption detection logic ─────────────────────────────────────────────
test("isOtherOption: option.id === 'custom' is detected as Other", async () => {
  const isOtherOption = await loadIsOtherOption();
  assert.equal(isOtherOption({ id: "custom", text: "Describe it differently", value: "Describe it differently" }), true);
});

test("isOtherOption: option.isOther flag is detected", async () => {
  const isOtherOption = await loadIsOtherOption();
  assert.equal(isOtherOption({ id: "x", text: "Some text", isOther: true }), true);
});

test("isOtherOption: option.type === 'other' is detected", async () => {
  const isOtherOption = await loadIsOtherOption();
  assert.equal(isOtherOption({ id: "x", text: "Some text", type: "other" }), true);
});

test("isOtherOption: text starting with 'Other' (case-insensitive) is detected", async () => {
  const isOtherOption = await loadIsOtherOption();
  assert.equal(isOtherOption({ id: "y", text: "Other timeframe", value: "Other timeframe" }), true);
  assert.equal(isOtherOption({ id: "y", text: "other timeframe", value: "other timeframe" }), true);
  assert.equal(isOtherOption({ id: "y", text: "OTHER", value: "OTHER" }), true);
});

test("isOtherOption: 'I'm not sure' is NOT detected as Other", async () => {
  const isOtherOption = await loadIsOtherOption();
  assert.equal(isOtherOption({ id: "not-sure", text: "I'm not sure", value: "I'm not sure" }), false);
});

test("isOtherOption: normal options are not detected", async () => {
  const isOtherOption = await loadIsOtherOption();
  assert.equal(isOtherOption({ id: "mild", text: "Mild", value: "Mild" }), false);
  assert.equal(isOtherOption({ id: "moderate", text: "Moderate", value: "Moderate" }), false);
  assert.equal(isOtherOption({ id: "severe", text: "Severe", value: "Severe" }), false);
  assert.equal(isOtherOption({ id: "before", text: "Before I started any medicine", value: "Before I started any medicine" }), false);
  assert.equal(isOtherOption({ id: "all", text: "It could be any of them", value: "It could be any of them" }), false);
});

test("isOtherOption: null / undefined option returns false", async () => {
  const isOtherOption = await loadIsOtherOption();
  assert.equal(isOtherOption(null), false);
  assert.equal(isOtherOption(undefined), false);
  assert.equal(isOtherOption("string"), false);
  assert.equal(isOtherOption(42), false);
});

// ── addQuestionOptions source structure ───────────────────────────────────────
test("addQuestionOptions renders Other option with input, not a plain button", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // Must detect via isOtherOption
  assert.match(fn, /isOtherOption\(option\)/, "must call isOtherOption to detect custom options");

  // The Other branch must create an input[type=text]
  assert.match(fn, /input\.type\s*=\s*["']text["']/, "Other option must use input[type=text]");

  // Must have an accessible label (for= attribute)
  assert.match(fn, /label\.setAttribute\(\s*["']for["']/, "input must be associated with a label");

  // Must have aria-label on the input for screen readers
  assert.match(fn, /input\.setAttribute\(\s*["']aria-label["']/, "input must have aria-label");

  // Must have a send button
  assert.match(fn, /sendBtn\.textContent\s*=\s*["']Send["']/, "must have a Send button");

  // Must have aria-label on send button
  assert.match(fn, /sendBtn\.setAttribute\(\s*["']aria-label["']/, "send button must have aria-label");

  // Must prevent default on Enter to avoid accidental page submission
  assert.match(fn, /e\.preventDefault\(\)/, "Enter must call preventDefault");

  // Must check for empty/whitespace before submitting
  assert.match(fn, /input\.value\.trim\(\)/, "must trim and validate before submitting");

  // Must prevent duplicate submissions
  assert.match(fn, /otherSubmitting/, "must have a duplicate-submission guard");

  // Non-Other options still produce buttons
  assert.match(fn, /button\.className\s*=\s*["']ai-option-btn["']/, "normal options still render as ai-option-btn");
});

test("addQuestionOptions: Other branch sends custom text via sendOptionSelection, not the label", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // Must call sendOptionSelection with customText (the user's typed value), not the
  // literal string "Other" or "Describe it differently".
  assert.match(fn, /sendOptionSelection\(customText\)/, "must send customText to sendOptionSelection");
  assert.doesNotMatch(fn, /sendOptionSelection\(\s*["']Other["']\s*\)/, "must not send the literal word 'Other'");
  assert.doesNotMatch(fn, /sendOptionSelection\(optionValue\)/, "Other branch must not use optionValue");
});

test("addQuestionOptions: Other branch shows user's answer before sending", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // addChatMessage("user", customText) must be called before sendOptionSelection
  assert.match(fn, /addChatMessage\(\s*["']user["']\s*,\s*customText\)/, "must show user's typed answer in the conversation");
});

test("addQuestionOptions: options container is removed after Other submission", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // optionsDiv.remove() is called in the submitOther closure
  assert.match(fn, /optionsDiv\.remove\(\)/, "options container must be removed after submission");
});

test("addQuestionOptions: disables input and button after submission to prevent duplicates", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  assert.match(fn, /sendBtn\.disabled\s*=\s*true/, "send button must be disabled after submission");
  assert.match(fn, /input\.disabled\s*=\s*true/, "input must be disabled after submission");
});

test("addQuestionOptions: checks aiConversationState.isProcessing before submitting", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  assert.match(fn, /aiConversationState\.isProcessing/, "must respect global isProcessing state");
});

// ── Existing behavior preserved ───────────────────────────────────────────────
test("selectOption and sendOptionSelection are still present and unchanged in shape", async () => {
  const source = await loadAppSource();

  // selectOption still exists
  const selectFn = extractFunction(source, "selectOption");
  assert.match(selectFn, /addChatMessage\(\s*["']user["']/, "selectOption still shows user message");
  assert.match(selectFn, /sendOptionSelection\(value\)/, "selectOption still calls sendOptionSelection");

  // sendOptionSelection still guards against empty/undefined
  const sendFn = extractFunction(source, "sendOptionSelection");
  assert.match(sendFn, /isOptionSelection:\s*true/, "sendOptionSelection still sets isOptionSelection flag");
});

test("'I'm not sure' still renders as a normal button, not an Other row", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // The else branch (normal button path) handles non-Other options including "I'm not sure"
  assert.match(fn, /button\.className\s*=\s*["']ai-option-btn["']/, "normal options still use ai-option-btn");
  assert.match(fn, /button\.onclick\s*=\s*\(\)\s*=>\s*selectOption/, "normal buttons still use selectOption");
});

// ── CSS presence checks ────────────────────────────────────────────────────────
test("style.css contains the ai-other-option-row and related classes", async () => {
  const source = await readFile(
    new URL("../DoseBuddy_frontend/style.css", import.meta.url),
    "utf8"
  );
  assert.match(source, /\.ai-other-option-row/, "ai-other-option-row class must exist");
  assert.match(source, /\.ai-other-option-label/, "ai-other-option-label class must exist");
  assert.match(source, /\.ai-other-option-input/, "ai-other-option-input class must exist");
  assert.match(source, /\.ai-other-option-send/, "ai-other-option-send class must exist");
  // font-size: 16px prevents iOS zoom
  assert.match(source, /\.ai-other-option-input[\s\S]{0,200}font-size:\s*16px/, "ai-other-option-input must have font-size: 16px");
});

test("style.css ai-other-option-row has flex display for inline layout", async () => {
  const source = await readFile(
    new URL("../DoseBuddy_frontend/style.css", import.meta.url),
    "utf8"
  );
  const idx = source.indexOf(".ai-other-option-row {");
  assert.ok(idx >= 0, ".ai-other-option-row must be in style.css");
  const block = source.slice(idx, idx + 300);
  assert.match(block, /display:\s*flex/, "ai-other-option-row must use flex layout");
  assert.match(block, /align-items:\s*center/, "ai-other-option-row must center items vertically");
});

// ── Snapshot: isOtherOption function must exist in source ─────────────────────
test("isOtherOption function is present at top level in app.js", async () => {
  const source = await loadAppSource();
  assert.match(
    source,
    /function\s+isOtherOption\s*\(/,
    "isOtherOption must be a named top-level function in app.js"
  );
});

test("guided questions reject stale selections and disable older controls", async () => {
  const source = await loadAppSource();
  const options = extractFunction(source, "addQuestionOptions");
  const select = extractFunction(source, "selectOption");

  assert.match(options, /activeQuestionOptions\?\.isConnected/, "a newer question must retire prior controls");
  assert.match(options, /querySelectorAll\(["']button, input["']\)/, "older question controls must be disabled");
  assert.match(select, /optionsContainer\s*!==\s*activeQuestionOptions/, "stale option clicks must be ignored");
});

test("custom guided answers clear on send and restore only after a failed request", async () => {
  const source = await loadAppSource();
  const options = extractFunction(source, "addQuestionOptions");
  const send = extractFunction(source, "sendOptionSelection");

  assert.match(options, /input\.value\s*=\s*["']["']/, "the inline field must clear once its answer is submitted");
  assert.match(options, /const accepted\s*=\s*await\s+sendOptionSelection\(customText\)/, "custom submission must await the actual request outcome");
  assert.match(options, /input\.value\s*=\s*customText/, "failed requests must restore the typed answer for retry");
  assert.match(send, /return true/, "selection sender must report success to the inline row");
  assert.match(send, /return false/, "selection sender must report failures to the inline row");
});
