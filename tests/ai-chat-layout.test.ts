import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");

test("AI chat has one bounded message scroller and a pinned composer", async () => {
  const [html, css] = await Promise.all([
    source("DoseBuddy_frontend/index.html"),
    source("DoseBuddy_frontend/style.css")
  ]);
  const viewStart = html.indexOf('<section id="ai-view"');
  const view = html.slice(viewStart, html.indexOf("</section>", viewStart));
  const chatStart = view.indexOf('<div class="ai-chat-container">');
  const disclaimerIndex = view.indexOf('class="ai-disclaimer-card"');
  const chat = view.slice(chatStart, disclaimerIndex);
  assert.ok(chat.indexOf('class="ai-chat-messages"') < chat.indexOf('class="ai-chat-input-area"'));
  assert.equal(chat.indexOf('class="ai-disclaimer-card"'), -1, "disclaimer must not be conversation content");
  assert.ok(disclaimerIndex > chatStart, "disclaimer must follow the chat panel");
  assert.match(css, /\.main-content\s*\{[\s\S]*?min-height:\s*0/);
  assert.match(css, /--app-viewport-height/);
  assert.match(css, /body\.view-ai #ai-view\s*\{[\s\S]*?display:\s*flex[\s\S]*?min-height:\s*0/);
  assert.match(css, /body\.view-ai \.ai-chat-messages\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(css, /body\.view-ai \.ai-chat-input-area\s*\{[\s\S]*?flex-shrink:\s*0/);
  assert.match(css, /body\.view-ai #ai-view > \.ai-disclaimer-card/);
  assert.doesNotMatch(css, /ai-chat-messages \.ai-disclaimer-card/);
});

test("AI chat decides whether to scroll before adding content", async () => {
  const app = await source("DoseBuddy_frontend/app.js");
  const ranges = [
    ["function addChatMessage", "function isOtherOption"],
    ["function addQuestionOptions", "function selectOption"],
    ["function showChatThinking", "function hideChatThinking"]
  ];
  for (const [startMarker, endMarker] of ranges) {
    const part = app.slice(app.indexOf(startMarker), app.indexOf(endMarker));
    assert.ok(part.indexOf("isChatNearBottom") < part.indexOf("appendChild"), "capture scroll state before DOM growth");
    assert.match(part, /scrollChatToBottom\(shouldAutoScroll\)/);
  }
});

test("New Chat restores only conversation content", async () => {
  const app = await source("DoseBuddy_frontend/app.js");
  assert.doesNotMatch(app, /AI_CHAT_DISCLAIMER_HTML/);
  assert.match(app, /chatMessages\.innerHTML = AI_CHAT_WELCOME_HTML/);
});

test("dark mode keeps outgoing chat messages distinct from the background", async () => {
  const css = await source("DoseBuddy_frontend/style.css");
  assert.match(css, /body\.dark-mode \.ai-chat-user \.ai-message-text\s*\{[\s\S]*?background:\s*#008f89/);
  assert.match(css, /body\.dark-mode \.ai-chat-user \.ai-message-text\s*\{[\s\S]*?color:\s*#ffffff/);
});
test("guided choices use a compact grid while Other keeps a full inline row", async () => {
  const css = await source("DoseBuddy_frontend/style.css");
  assert.match(css, /\.ai-question-options\s*\{[\s\S]*?display:\s*grid/);
  assert.match(css, /\.ai-option-btn\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.ai-other-option-row\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*?\.ai-other-option-row\s*\{\s*flex-wrap:\s*nowrap/);
});

test("AI chat tracks visual viewport height for mobile keyboard resizing", async () => {
  const app = await source("DoseBuddy_frontend/app.js");
  assert.match(app, /window\.visualViewport\?\.height \|\| window\.innerHeight/);
  assert.match(app, /visualViewport\?\.addEventListener\("resize", syncAiViewportHeight\)/);
});
