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
  const start = html.indexOf('<div class="ai-chat-container">');
  const container = html.slice(start, html.indexOf("</section>", start));
  assert.ok(container.indexOf('class="ai-chat-messages"') < container.indexOf('class="ai-chat-input-area"'));
  assert.ok(container.indexOf('class="ai-disclaimer-card"') < container.indexOf('class="ai-chat-input-area"'));
  assert.match(css, /\.main-content\s*\{[\s\S]*?min-height:\s*0/);
  assert.match(css, /--app-viewport-height/);
  assert.match(css, /body\.view-ai #ai-view\s*\{[\s\S]*?display:\s*flex[\s\S]*?min-height:\s*0/);
  assert.match(css, /body\.view-ai \.ai-chat-messages\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(css, /body\.view-ai \.ai-chat-input-area\s*\{[\s\S]*?flex-shrink:\s*0/);
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

test("New Chat restores the disclaimer inside the scrolling history", async () => {
  const app = await source("DoseBuddy_frontend/app.js");
  assert.match(app, /AI_CHAT_DISCLAIMER_HTML/);
  assert.match(app, /AI_CHAT_WELCOME_HTML \+ AI_CHAT_DISCLAIMER_HTML/);
});

test("AI chat tracks visual viewport height for mobile keyboard resizing", async () => {
  const app = await source("DoseBuddy_frontend/app.js");
  assert.match(app, /window\.visualViewport\?\.height \|\| window\.innerHeight/);
  assert.match(app, /visualViewport\?\.addEventListener\("resize", syncAiViewportHeight\)/);
});
