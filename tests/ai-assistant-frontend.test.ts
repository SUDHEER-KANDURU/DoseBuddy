import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Source-level regression tests for the AI Assistant frontend (FEAT-001).
// There is no DOM in the node:test unit runner, so — like tests/frontend-dedupe.test.ts
// — these read DoseBuddy_frontend/app.js as text and assert against its source with
// assert.match / assert.doesNotMatch. They pin:
//   (1) clicking a suggested prompt fills the composer and focuses it WITHOUT sending
//       (ChatGPT-style), then re-enables the Send button;
//   (2) scrollChatToBottom only forces scroll when the user is already near the bottom,
//       so it does not yank a reader of older messages back down;
//   (3) Enter-to-send, Send-button-click, and the duplicate-submit guard are preserved.
//
// Note: the bounded /api/ai/chat authFetch timeout is implemented in FEAT-002
// (Problems B + C), so a regression test asserting `timeout: 30000` on that fetch is
// intentionally added there rather than here.

async function loadAppSource(): Promise<string> {
  return readFile(new URL("../DoseBuddy_frontend/app.js", import.meta.url), "utf8");
}

// Extract the full text of a named function (handles nested braces; the AI Assistant
// functions contain no unmatched braces inside string literals).
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
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  assert.ok(depth === 0, `function ${name} braces must be balanced`);
  return source.slice(m.index, i);
}

test("wireStarterPrompts fills the composer without sending and re-enables Send", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "wireStarterPrompts");

  // ChatGPT-style: the suggestion text fills the composer and focus moves to it.
  assert.match(fn, /chatInput\.value\s*=\s*prompt/, "must set chatInput.value = prompt");
  assert.match(fn, /chatInput\.focus\s*\(\)/, "must focus the composer");

  // Clicking a suggestion must NOT auto-send.
  assert.doesNotMatch(
    fn,
    /sendChatMessage\s*\(/,
    "wireStarterPrompts must not call sendChatMessage() — clicking only fills the composer"
  );

  // The existing autosize input listener runs via a dispatched input event, and the
  // Send button is refreshed so the user can immediately press Enter or click Send.
  assert.match(
    fn,
    /dispatchEvent\(\s*new\s+Event\(\s*["']input["']/,
    "must dispatch an input event so the autosize listener resizes the textarea"
  );
  assert.match(fn, /updateSendButton\s*\(\)/, "must call updateSendButton() to enable Send");
});

test("scrollChatToBottom only auto-scrolls when the user is already near the bottom", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "scrollChatToBottom");

  // A near-bottom guard decides whether to force-scroll.
  assert.match(
    fn,
    /nearBottom\s*=\s*chatMessages\.scrollHeight\s*-\s*chatMessages\.scrollTop\s*-\s*chatMessages\.clientHeight\s*<\s*120/,
    "must compute a near-bottom guard (within ~120px)"
  );

  // The scroll assignment must be inside the if (nearBottom) guard, not unconditional.
  assert.match(
    fn,
    /if\s*\(\s*nearBottom\s*\)\s*\{\s*chatMessages\.scrollTop\s*=\s*chatMessages\.scrollHeight/,
    "scrollTop = scrollHeight must be guarded by nearBottom"
  );
});

test("Enter-to-send, Send-button click, and duplicate-submit guard are preserved", async () => {
  const source = await loadAppSource();
  const setup = extractFunction(source, "setupUnifiedAiChat");

  // Enter sends (Shift+Enter falls through to the textarea's default newline).
  assert.match(
    setup,
    /e\.key\s*===\s*["']Enter["']\s*&&\s*!e\.shiftKey/,
    "Enter (without Shift) must trigger send"
  );
  // Only send when idle and there is text — prevents duplicate submissions while a
  // request is in flight.
  assert.match(
    setup,
    /if\s*\(\s*!aiConversationState\.isProcessing\s*&&\s*chatInput\.value\.trim\(\)\s*\)\s*\{[\s\S]*?sendChatMessage\(\)/,
    "Enter must send only when not processing and the composer has text"
  );
  // The Send button still sends.
  assert.match(
    setup,
    /chatSend\.addEventListener\(\s*["']click["']\s*,\s*sendChatMessage\s*\)/,
    "Send button click must call sendChatMessage"
  );

  // sendChatMessage itself guards against duplicate submission.
  const send = extractFunction(source, "sendChatMessage");
  assert.match(
    send,
    /if\s*\(\s*!message\s*\|\|\s*aiConversationState\.isProcessing\s*\)\s*return/,
    "sendChatMessage must early-return when empty or already processing"
  );
});

// ── addQuestionOptions: inline Other branch ────────────────────────────────────
// These tests cover the inline custom-answer row added for options whose
// id === 'custom' (or isOther / type:'other' / text starts with 'Other').

test("addQuestionOptions: Other option renders with a text input, not a plain button", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // Must branch via isOtherOption
  assert.match(fn, /isOtherOption\(option\)/, "must call isOtherOption to detect custom options");

  // The Other branch creates an input[type=text]
  assert.match(fn, /input\.type\s*=\s*["']text["']/, "Other option must use input[type=text]");

  // Normal options still use ai-option-btn
  assert.match(fn, /button\.className\s*=\s*["']ai-option-btn["']/, "normal options still render as ai-option-btn");
  assert.match(fn, /button\.onclick\s*=\s*\(\)\s*=>\s*selectOption/, "normal options still call selectOption");
});

test("addQuestionOptions: Other row uses the .ai-other-option-row class (inline layout)", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  assert.match(fn, /ai-other-option-row/, "Other row must use .ai-other-option-row class");
  assert.match(fn, /row\.appendChild\(sendBtn\)/, "send button must be inside the Other row");
});

test("addQuestionOptions: Other input has accessible label wiring", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // label.for → input.id pairing
  assert.match(fn, /label\.setAttribute\(\s*["']for["']/, "label must have a for attribute");
  assert.match(fn, /input\.id\s*=\s*inputId/, "input id must match label.for");

  // aria-label on input
  assert.match(fn, /input\.setAttribute\(\s*["']aria-label["']/, "input must have aria-label");

  // role=group with aria-labelledby pointing to the label element
  assert.match(fn, /role["']?\s*,\s*["']group["']/, "Other row must have role=group");
  assert.match(fn, /aria-labelledby["']?\s*,\s*labelId/, "row aria-labelledby must reference the label's id, not the input's id");
});

test("addQuestionOptions: Enter on Other input submits custom text, not the word 'Other'", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  assert.match(fn, /e\.key\s*===\s*["']Enter["']/, "Enter key must be handled on the Other input");
  assert.match(fn, /e\.preventDefault\(\)/, "Enter must call preventDefault to avoid page-level form submit");
  assert.match(fn, /sendOptionSelection\(customText\)/, "must send customText, not the literal option label");
  assert.doesNotMatch(fn, /sendOptionSelection\(\s*["']Other["']\s*\)/, "must never send the literal word 'Other'");
});

test("addQuestionOptions: empty and whitespace-only inputs are rejected", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // customText comes from input.value.trim() — empty string is falsy
  assert.match(fn, /input\.value\.trim\(\)/, "input value must be trimmed before validation");
  assert.match(fn, /if\s*\(\s*!customText\s*\)\s*return/, "empty custom text must bail out without sending");
});

test("addQuestionOptions: duplicate submission is prevented", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  assert.match(fn, /otherSubmitting/, "must have an otherSubmitting duplicate-submission guard");
  assert.match(fn, /aiConversationState\.isProcessing/, "must also respect the global isProcessing guard");
  assert.match(fn, /sendBtn\.disabled\s*=\s*true/, "send button must be disabled immediately on submit");
  assert.match(fn, /input\.disabled\s*=\s*true/, "input must be disabled immediately on submit");
});

test("addQuestionOptions: user's answer is shown and options container removed after submission", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  assert.match(fn, /addChatMessage\(\s*["']user["']\s*,\s*customText\)/, "user's typed answer must be shown in conversation");
  assert.match(fn, /optionsDiv\.remove\(\)/, "options container must be removed after submission");
});

test("addQuestionOptions: controls are re-enabled and options container restored on network error", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // The submitOther function must be async and wrap sendOptionSelection in try/catch
  assert.match(fn, /const submitOther\s*=\s*async\s*\(\)/, "submitOther must be async for error recovery");
  assert.match(fn, /await\s+sendOptionSelection\(customText\)/, "sendOptionSelection must be awaited");
  // On error: reset otherSubmitting and re-enable controls
  assert.match(fn, /otherSubmitting\s*=\s*false/, "otherSubmitting must be reset to false on error");
  assert.match(fn, /input\.disabled\s*=\s*false/, "input must be re-enabled on network error");
  // Options container re-appended to chatMessages so user can retry
  assert.match(fn, /chatMessages\.appendChild\(optionsDiv\)/, "options container must be restored to DOM on error");
});

test("'I'm not sure' still renders as a normal button, not an Other row", async () => {
  const source = await loadAppSource();
  const fn = extractFunction(source, "addQuestionOptions");

  // Non-custom options (e.g. not-sure, mild, moderate, severe) fall through to the
  // else branch which creates a plain button. The branch guard ensures this.
  assert.match(fn, /if\s*\(\s*isOtherOption\(option\)\s*\)\s*\{[\s\S]*?\}\s*else\s*\{/, "non-Other options fall through to normal button path");
});
