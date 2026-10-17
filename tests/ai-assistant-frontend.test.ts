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
