import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../cloudflare-worker/index.ts";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");

const patient1 = {
  id: 1,
  email: "patient1@example.test",
  password_hash: "password123",
  name: "Patient One",
  role: "PATIENT",
  time_zone: "UTC",
  accepted_terms: 1
};

const patient2 = {
  id: 2,
  email: "patient2@example.test",
  password_hash: "password123",
  name: "Patient Two",
  role: "PATIENT",
  time_zone: "UTC",
  accepted_terms: 1
};

class ConversationalDbAdapter {
  calls: Array<[string, unknown[]]> = [];
  conversations: Map<string, any> = new Map();
  messages: Array<any> = [];

  constructor(initialConvs: any[] = [], initialMsgs: any[] = []) {
    for (const c of initialConvs) this.conversations.set(c.id, c);
    this.messages = [...initialMsgs];
  }

  async query(statement: string, values: unknown[] = []): Promise<any> {
    this.calls.push([statement, values]);

    if (statement.includes("FROM users WHERE email=?")) {
      const email = values[0];
      if (email === patient2.email) return [[patient2], undefined];
      return [[patient1], undefined];
    }
    if (statement.includes("FROM users WHERE id=?")) {
      const id = values[0];
      if (Number(id) === 2) return [[patient2], undefined];
      return [[patient1], undefined];
    }

    if (statement.includes("SELECT id, user_id FROM ai_conversations WHERE id = ?")) {
      const convId = values[0] as string;
      const conv = this.conversations.get(convId);
      return [conv ? [{ id: conv.id, user_id: conv.user_id }] : [], undefined];
    }

    if (statement.includes("DELETE FROM ai_messages WHERE conversation_id = ? AND user_id = ?")) {
      const [convId, userId] = values as [string, number];
      this.messages = this.messages.filter(m => !(m.conversation_id === convId && Number(m.user_id) === Number(userId)));
      return [{ affectedRows: 1 }, undefined];
    }

    if (statement.includes("DELETE FROM ai_conversations WHERE id = ? AND user_id = ?")) {
      const [convId, userId] = values as [string, number];
      const conv = this.conversations.get(convId);
      if (conv && Number(conv.user_id) === Number(userId)) {
        this.conversations.delete(convId);
        return [{ affectedRows: 1 }, undefined];
      }
      return [{ affectedRows: 0 }, undefined];
    }

    return [[], undefined];
  }

  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  async end() {}
}

function createEnv(db: ConversationalDbAdapter): any {
  return {
    JWT_SECRET: "test-delete-secret",
    TEST_DB_FACTORY: async () => db
  };
}

async function loginUser(db: ConversationalDbAdapter, user = patient1): Promise<string> {
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "password123" })
  }), createEnv(db));
  assert.equal(response.status, 200);
  return (await response.json() as any).accessToken as string;
}

// ─── Front-End Markup & Accessibility Tests ─────────────────────────────────

test("Delete conversation confirmation dialog exists with accessible attributes and cream styling", async () => {
  const html = await source("DoseBuddy_frontend/index.html");

  assert.ok(html.includes('id="modal-delete-conversation"'), "Delete modal must exist in HTML");
  assert.ok(html.includes('id="modal-delete-conv-title"'), "Dialog title element must exist");
  assert.ok(html.includes('id="delete-conv-prompt-text"'), "Prompt description text element must exist");
  assert.ok(html.includes('id="cancel-delete-conv-btn"'), "Cancel button must exist");
  assert.ok(html.includes('id="confirm-delete-conv-btn"'), "Confirm Delete button must exist");
  assert.ok(html.includes('role="dialog"'), "Modal must have role=dialog");
  assert.ok(html.includes('aria-modal="true"'), "Modal must have aria-modal=true");
});

test("Delete button touch target complies with mobile accessibility (min 40x40px)", async () => {
  const css = await source("DoseBuddy_frontend/style.css");

  assert.match(css, /\.delete-chat-btn\s*\{[^}]*min-width:\s*40px/);
  assert.match(css, /\.delete-chat-btn\s*\{[^}]*min-height:\s*40px/);
  assert.match(css, /\.delete-chat-btn\s*\{[^}]*touch-action:\s*manipulation/);
  assert.match(css, /#modal-delete-conversation\s*\{[^}]*z-index:\s*750/);
  assert.match(css, /\.ai-delete-confirm-box\s*\{[^}]*max-width:\s*min\(420px,\s*92vw\)/);
});

// ─── Front-End Logic & Resurrection Guard Tests ─────────────────────────────

test("Front-end conversation deletion uses custom modal and prevents resurrection via tombstone", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  // Tombstone functions
  assert.match(app, /function getDeletedConversationIdsKey\s*\(\)/);
  assert.match(app, /function getDeletedConversationIds\s*\(\)/);
  assert.match(app, /function markConversationDeletedLocally\s*\(/);

  // Tombstone filtering in getLocalConversationIndex
  assert.match(app, /const deletedIds = getDeletedConversationIds\(\)/);

  // In-flight guard and state tracking
  assert.match(app, /let _conversationPendingDelete\s*=/);
  assert.match(app, /let _isDeletingConversation\s*=/);
  assert.match(app, /function openDeleteConversationDialog\s*\(/);
  assert.match(app, /function closeDeleteConversationDialog\s*\(/);
  assert.match(app, /async function confirmDeleteConversation\s*\(/);

  // Prevents resurrection in loadPastConversationsList
  assert.match(app, /rawServerConvs\.filter\([^)]*!freshDeletedIds\.has\(c\.id\)\)/);
});

test("Active conversation deletion resets chat view to welcome screen", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  const removeFnStart = app.indexOf("function removeLocalConversation(convId)");
  const removeFnEnd = app.indexOf("function saveAiConversationLocally()");
  const removeFnBody = app.slice(removeFnStart, removeFnEnd);

  assert.ok(removeFnBody.includes("startNewConversation()"), "removeLocalConversation must reset chat if active");
  assert.ok(removeFnBody.includes("markConversationDeletedLocally(convId)"), "Must record tombstone");
  assert.ok(removeFnBody.includes("localStorage.removeItem(getAiStorageKey())"), "Must clear active conversation storage key");
});

test("Snappy UI removes deleted item from DOM immediately and shows empty-state if none remain", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  const confirmFnStart = app.indexOf("async function confirmDeleteConversation()");
  const confirmFnEnd = app.indexOf("async function loadPastConversationsList()");
  const confirmFnBody = app.slice(confirmFnStart, confirmFnEnd);

  assert.ok(confirmFnBody.includes("itemEl.remove()"), "Must remove card element from DOM immediately");
  assert.ok(confirmFnBody.includes("renderPastChatsList([])"), "Must show empty state if no conversations remain");
  assert.ok(confirmFnBody.includes('confirmBtn.textContent = "Deleting..."'), "Must show in-flight progress");
  assert.ok(confirmFnBody.includes("confirmBtn.disabled = true"), "Must disable button to prevent double-clicks");
});

// ─── Backend Route & Authorization Tests ────────────────────────────────────

test("Backend DELETE /api/ai/conversations/:id deletes child messages first, then conversation", async () => {
  const db = new ConversationalDbAdapter(
    [{ id: "conv-123", user_id: 1, title: "Test Chat" }],
    [{ id: 1, conversation_id: "conv-123", user_id: 1, content: "Hello" }]
  );

  const token = await loginUser(db, patient1);

  const resp = await worker.fetch(new Request("https://dosebuddy.test/api/ai/conversations/conv-123", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  }), createEnv(db));

  assert.equal(resp.status, 200);
  const data: any = await resp.json();
  assert.equal(data.success, true);
  assert.equal(db.conversations.has("conv-123"), false);
  assert.equal(db.messages.length, 0);

  // Verify deletion order: messages first, then conversations
  const msgDelIndex = db.calls.findIndex(([sql]) => sql.includes("DELETE FROM ai_messages"));
  const convDelIndex = db.calls.findIndex(([sql]) => sql.includes("DELETE FROM ai_conversations"));
  assert.ok(msgDelIndex !== -1, "ai_messages must be deleted");
  assert.ok(convDelIndex !== -1, "ai_conversations must be deleted");
  assert.ok(msgDelIndex < convDelIndex, "ai_messages must be deleted before ai_conversations for foreign key integrity");
});

test("Backend DELETE /api/ai/conversations/:id returns 403 on conversation owned by another user", async () => {
  const db = new ConversationalDbAdapter(
    [{ id: "conv-other", user_id: 2, title: "Other User Chat" }],
    [{ id: 1, conversation_id: "conv-other", user_id: 2, content: "Secret" }]
  );

  const tokenUser1 = await loginUser(db, patient1);

  const resp = await worker.fetch(new Request("https://dosebuddy.test/api/ai/conversations/conv-other", {
    method: "DELETE",
    headers: { authorization: `Bearer ${tokenUser1}` }
  }), createEnv(db));

  assert.equal(resp.status, 403);
  const data: any = await resp.json();
  assert.equal(data.success, false);
  assert.equal(data.error, "Unauthorized");
  assert.equal(db.conversations.has("conv-other"), true);
});

test("Backend DELETE /api/ai/conversations/:id is idempotent for missing/already-deleted conversations", async () => {
  const db = new ConversationalDbAdapter([]);

  const token = await loginUser(db, patient1);

  const resp = await worker.fetch(new Request("https://dosebuddy.test/api/ai/conversations/nonexistent-conv", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  }), createEnv(db));

  assert.equal(resp.status, 200);
  const data: any = await resp.json();
  assert.equal(data.success, true);
  assert.equal(data.message, "Conversation deleted");
});
