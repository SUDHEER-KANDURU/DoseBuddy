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

test("Health Assistant chat layout is centered with comfortable SaaS desktop width", async () => {
  const css = await source("DoseBuddy_frontend/style.css");
  assert.match(css, /body\.view-ai \.main-content\s*\{[\s\S]*?align-items:\s*center/);
  assert.match(css, /body\.view-ai #ai-view\s*\{[\s\S]*?max-width:\s*960px[\s\S]*?margin:\s*0\s+auto/);
  assert.match(css, /body\.view-ai \.ai-chat-container\s*\{[\s\S]*?width:\s*100%/);
  assert.match(css, /body\.view-ai #ai-view > \.ai-disclaimer-card\s*\{[\s\S]*?width:\s*100%/);
});

test("Health Assistant composer textarea prevents internal scrollbars and auto-sizes smoothly", async () => {
  const [css, app] = await Promise.all([
    source("DoseBuddy_frontend/style.css"),
    source("DoseBuddy_frontend/app.js")
  ]);
  // CSS prevents premature scrollbars and gives sufficient line-height / padding
  assert.match(css, /#ai-chat-input\s*\{[\s\S]*?overflow-y:\s*hidden/);
  assert.match(css, /#ai-chat-input\s*\{[\s\S]*?min-height:\s*46px/);
  assert.match(css, /#ai-chat-input\s*\{[\s\S]*?max-height:\s*140px/);
  assert.match(css, /\.ai-send-btn\s*\{[\s\S]*?border-radius:\s*50%/);

  // JS dynamically auto-sizes between 44/46px and 140px, setting overflowY only when exceeding max-height
  assert.match(app, /function syncChatInputHeight\s*\(\)/);
  assert.match(app, /scrollHeight > maxHeight \? ["']auto["'] : ["']hidden["']/);
});

test("Past chats modal is a top-level backdrop outside hidden dashboard view", async () => {
  const html = await source("DoseBuddy_frontend/index.html");
  const dashEnd = html.indexOf('</section>', html.indexOf('id="dashboard-view"'));
  const modalPos = html.indexOf('id="past-chats-modal"');
  assert.ok(modalPos > dashEnd, "past-chats-modal must be outside section#dashboard-view");
});

test("Past chats slide-out drawer is properly anchored to sidebar and topnav with opaque background", async () => {
  const [html, css, app] = await Promise.all([
    source("DoseBuddy_frontend/index.html"),
    source("DoseBuddy_frontend/style.css"),
    source("DoseBuddy_frontend/app.js")
  ]);

  // HTML structure: backdrop and drawer with proper header, close button and body
  assert.match(html, /<div id="past-chats-drawer-backdrop" class="ai-drawer-backdrop"/);
  assert.match(html, /<aside id="past-chats-modal" class="ai-drawer"/);
  assert.match(html, /class="ai-drawer-header"/);
  assert.match(html, /id="close-past-chats-btn" class="ai-drawer-close-btn"/);
  assert.match(html, /id="past-chats-list" class="ai-drawer-body"/);

  // CSS structure: desktop anchored to topnav and sidebar with opaque surface background
  assert.match(css, /\.ai-drawer\s*\{[\s\S]*?top:\s*var\(--topnav-h\)/);
  assert.match(css, /\.ai-drawer\s*\{[\s\S]*?left:\s*var\(--sidebar-w\)/);
  assert.match(css, /\.ai-drawer\s*\{[\s\S]*?background:\s*var\(--surface\)/);
  assert.match(css, /\.ai-drawer-backdrop\s*\{[\s\S]*?position:\s*fixed/);

  // JS wire-up: open, close, and Escape key listeners
  assert.match(app, /function openPastChatsModal\s*\(\)/);
  assert.match(app, /function closePastChatsModal\s*\(\)/);
  assert.match(app, /pastChatsDrawerBackdrop\.addEventListener\("click", closePastChatsModal\)/);
  assert.match(app, /if\s*\(e\.key === "Escape"\)/);
});

test("Mobile chat action buttons use 50/50 grid and compact single-line placeholder", async () => {
  const [html, css] = await Promise.all([
    source("DoseBuddy_frontend/index.html"),
    source("DoseBuddy_frontend/style.css")
  ]);

  // Single-line fits-all placeholder (34 chars, fits cleanly without multi-line clipping)
  assert.match(html, /placeholder="Ask about health or medications\.\.\."/);

  // Buttons are in .ai-header-actions
  assert.match(html, /class="ai-header-actions page-header-actions"/);
  assert.match(html, /id="past-chats-btn"/);
  assert.match(html, /id="new-conversation-btn"/);

  // CSS mobile 50/50 action row
  assert.match(css, /\.ai-header-actions[\s\S]*?grid-template-columns:\s*1fr\s+1fr/);
});

test("Conversation history persists with local index cache fallback", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  // Local conversation indexing and fallback methods
  assert.match(app, /function getAiConversationsIndexKey\s*\(\)/);
  assert.match(app, /function getLocalConversationIndex\s*\(\)/);
  assert.match(app, /function saveLocalConversationIndex\s*\(/);
  assert.match(app, /function updateLocalConversationIndex\s*\(/);
  assert.match(app, /function removeLocalConversation\s*\(/);

  // Authoritative server fetch with graceful local cache fallback
  assert.match(app, /const cached = getLocalConversationIndex\(\)/);
  assert.match(app, /renderPastChatsList\(cached\)/);
  assert.match(app, /authFetch\(`\${API_BASE}\/ai\/conversations`/);

  // Detail loading with offline/unmigrated table fallback
  assert.match(app, /getAiConversationDetailKey\(conversationId\)/);
});
