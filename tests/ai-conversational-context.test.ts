import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";

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
  medications: any[];
  conversations: Map<string, any> = new Map();
  messages: Array<any> = [];
  simulateMissingTables: boolean = false;

  constructor(medications: any[] = [], simulateMissingTables: boolean = false) {
    this.medications = medications;
    this.simulateMissingTables = simulateMissingTables;
  }

  async query(statement: string, values: unknown[] = []): Promise<any> {
    this.calls.push([statement, values]);

    if (this.simulateMissingTables) {
      if (statement.includes("ai_conversations") || statement.includes("ai_messages")) {
        const err: any = new Error("Table 'dosebuddy.ai_conversations' doesn't exist");
        err.code = "ER_NO_SUCH_TABLE";
        err.errno = 1146;
        throw err;
      }
    }

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
    if (statement.includes("JSON_ARRAYAGG") && statement.includes("FROM medications")) {
      return [this.medications, undefined];
    }

    // AI Conversations table queries
    if (statement.includes("SELECT c.id, c.title, c.active_topic, c.summary, c.created_at, c.updated_at")) {
      const userId = values[0];
      const userConvs = Array.from(this.conversations.values())
        .filter(c => Number(c.user_id) === Number(userId))
        .map(c => ({
          ...c,
          message_count: this.messages.filter(m => m.conversation_id === c.id).length
        }));
      return [userConvs, undefined];
    }

    if (statement.includes("SELECT id, user_id") && statement.includes("FROM ai_conversations WHERE id = ?")) {
      const convId = values[0] as string;
      const conv = this.conversations.get(convId);
      return [conv ? [conv] : [], undefined];
    }

    if (statement.includes("SELECT id, role, content, intent, active_topic, created_at FROM ai_messages WHERE conversation_id = ?")) {
      const convId = values[0] as string;
      const msgs = this.messages.filter(m => m.conversation_id === convId);
      return [msgs, undefined];
    }

    if (statement.includes("INSERT INTO ai_conversations")) {
      const [id, user_id, title, active_topic, summary] = values as [string, number, string, string, string];
      const existing = this.conversations.get(id);
      if (existing) {
        existing.active_topic = active_topic || existing.active_topic;
        existing.summary = summary || existing.summary;
        existing.updated_at = new Date().toISOString();
      } else {
        this.conversations.set(id, {
          id,
          user_id,
          title,
          active_topic,
          summary,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }
      return [{ affectedRows: 1 }, undefined];
    }

    if (statement.includes("INSERT INTO ai_messages")) {
      const [convId, user_id, role, content, intent, active_topic] = values as [string, number, string, string, string, string];
      this.messages.push({
        id: this.messages.length + 1,
        conversation_id: convId,
        user_id,
        role,
        content,
        intent,
        active_topic,
        created_at: new Date().toISOString()
      });
      return [{ affectedRows: 1, insertId: this.messages.length }, undefined];
    }

    if (statement.includes("DELETE FROM ai_conversations WHERE id = ? AND user_id = ?")) {
      const [convId, userId] = values as [string, number];
      const conv = this.conversations.get(convId);
      if (conv && Number(conv.user_id) === Number(userId)) {
        this.conversations.delete(convId);
        this.messages = this.messages.filter(m => m.conversation_id !== convId);
        return [{ affectedRows: 1 }, undefined];
      }
      return [{ affectedRows: 0 }, undefined];
    }

    return [{ affectedRows: 1, insertId: 1 }, undefined];
  }

  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  async end() {}
}

function createEnv(db: ConversationalDbAdapter, extra: Record<string, string> = {}): any {
  return {
    JWT_SECRET: "context-test-secret",
    TEST_DB_FACTORY: async () => db,
    ...extra
  };
}

async function loginUser(db: ConversationalDbAdapter, user = patient1) {
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "password123" })
  }), createEnv(db));
  assert.equal(response.status, 200);
  return (await response.json() as any).accessToken as string;
}

async function sendChat(db: ConversationalDbAdapter, token: string, body: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/ai/chat", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }), createEnv(db, extraEnv));
  const payload = await response.json() as any;
  return { status: response.status, payload };
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario 1: Liv-52 DS follow-up resolution: "so what is the main purpose of using those tablets especially?"
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 1: 'Liv-52 DS' follow-up 'so what is the main purpose of using those tablets especially?'", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db);

  // Turn 1: Ask about one of my medicines (empty schedule)
  const turn1 = await sendChat(db, token, {
    message: "Tell me about one of my medicines",
    conversationId: "conv-liv52"
  });
  assert.equal(turn1.status, 200);
  assert.equal(turn1.payload.intent, "MEDICINE_INFO");
  const state1 = turn1.payload.conversationState;

  // Turn 2: User provides "Liv-52 DS"
  const turn2 = await sendChat(db, token, {
    message: "Liv-52 DS",
    conversationId: "conv-liv52",
    conversationState: state1,
    history: [
      { role: "user", content: "Tell me about one of my medicines" },
      { role: "assistant", content: turn1.payload.message }
    ]
  });
  assert.equal(turn2.status, 200);
  assert.equal(turn2.payload.medicineName?.toLowerCase(), "liv-52 ds");
  const state2 = turn2.payload.conversationState;
  assert.equal(state2.lastMedicineName?.toLowerCase(), "liv-52 ds");
  assert.equal(state2.activeTopic?.toLowerCase(), "liv-52 ds");

  // Turn 3: Follow-up question that previously failed by extracting candidate:
  // "the main purpose of using those tablets especially"
  const turn3 = await sendChat(db, token, {
    message: "so what is the main purpose of using those tablets especially?",
    conversationId: "conv-liv52",
    conversationState: state2,
    history: [
      { role: "user", content: "Tell me about one of my medicines" },
      { role: "assistant", content: turn1.payload.message },
      { role: "user", content: "Liv-52 DS" },
      { role: "assistant", content: turn2.payload.message }
    ]
  });
  assert.equal(turn3.status, 200);
  assert.equal(turn3.payload.intent, "MEDICINE_INFO");
  assert.equal(turn3.payload.medicineName?.toLowerCase(), "liv-52 ds", "Must resolve to Liv-52 DS");
  assert.notEqual(turn3.payload.medicineName, "the main purpose of using those tablets especially");
  assert.notEqual(turn3.payload.messageType, "QUESTION", "Must not ask user for a medicine name again");
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 2: Reference resolution for "does it have side effects?" and "can I take those pills with food?"
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 2: Anaphoric reference resolution for side effects and pill administration", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db);

  const turn1 = await sendChat(db, token, {
    message: "Metformin",
    conversationId: "conv-refs"
  });
  const state1 = turn1.payload.conversationState;

  // Follow-up: does it have side effects?
  const turn2 = await sendChat(db, token, {
    message: "does it have side effects?",
    conversationId: "conv-refs",
    conversationState: state1,
    history: [
      { role: "user", content: "Metformin" },
      { role: "assistant", content: turn1.payload.message }
    ]
  });
  assert.equal(turn2.status, 200);
  assert.equal(turn2.payload.intent, "SIDE_EFFECT");
  assert.equal(turn2.payload.medicineName?.toLowerCase(), "metformin");

  // Follow-up: can I take those pills with food?
  const turn3 = await sendChat(db, token, {
    message: "can I take those pills with food?",
    conversationId: "conv-refs",
    conversationState: turn2.payload.conversationState,
    history: [
      { role: "user", content: "Metformin" },
      { role: "assistant", content: turn1.payload.message },
      { role: "user", content: "does it have side effects?" },
      { role: "assistant", content: turn2.payload.message }
    ]
  });
  assert.equal(turn3.status, 200);
  assert.equal(turn3.payload.medicineName?.toLowerCase(), "metformin");
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 3: Multi-turn retention across 4+ turns
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 3: Multi-turn retention across 4 sequential conversational turns", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db);

  let state: any = {};
  const history: Array<{ role: string; content: string }> = [];

  // Turn 1
  const t1 = await sendChat(db, token, { message: "Amoxicillin", conversationId: "conv-multi" });
  state = t1.payload.conversationState;
  history.push({ role: "user", content: "Amoxicillin" });
  history.push({ role: "assistant", content: t1.payload.message });

  // Turn 2
  const t2 = await sendChat(db, token, { message: "what is the main purpose of taking those capsules?", conversationId: "conv-multi", conversationState: state, history });
  assert.equal(t2.payload.medicineName?.toLowerCase(), "amoxicillin");
  state = t2.payload.conversationState;
  history.push({ role: "user", content: "what is the main purpose of taking those capsules?" });
  history.push({ role: "assistant", content: t2.payload.message });

  // Turn 3
  const t3 = await sendChat(db, token, { message: "are there any common side effects?", conversationId: "conv-multi", conversationState: state, history });
  assert.equal(t3.payload.medicineName?.toLowerCase(), "amoxicillin");
  state = t3.payload.conversationState;
  history.push({ role: "user", content: "are there any common side effects?" });
  history.push({ role: "assistant", content: t3.payload.message });

  // Turn 4
  const t4 = await sendChat(db, token, { message: "how should I take it?", conversationId: "conv-multi", conversationState: state, history });
  assert.equal(t4.payload.medicineName?.toLowerCase(), "amoxicillin");
  assert.equal(t4.payload.conversationState.lastMedicineName?.toLowerCase(), "amoxicillin");
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 4: Rolling summary + verbatim context for long conversations (>8-10 turns)
// ────────────────────────────────────────────────────────────────────
test("Scenario 4: Rolling summary and verbatim context manager for long conversations", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db);

  const longHistory: Array<{ role: string; content: string }> = [];
  for (let i = 1; i <= 10; i++) {
    longHistory.push({ role: "user", content: `Question ${i} about health` });
    longHistory.push({ role: "assistant", content: `Answer ${i} about health` });
  }

  const res = await sendChat(db, token, {
    message: "is it safe to take with water?",
    conversationId: "conv-long",
    conversationState: { lastMedicineName: "Ibuprofen" },
    history: longHistory
  });

  assert.equal(res.status, 200);
  assert.ok(res.payload.conversationState.summary, "Should populate conversation summary for long conversations");
  assert.equal(res.payload.medicineName?.toLowerCase(), "ibuprofen");
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 5: Pronoun follow-up without antecedent asks for clarification
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 5: Follow-up question without prior antecedent asks for clarification without fabricating", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db);

  const res = await sendChat(db, token, {
    message: "what is that medicine used for?",
    conversationId: "conv-no-antecedent"
  });

  assert.equal(res.status, 200);
  assert.equal(res.payload.messageType, "QUESTION");
  assert.ok(
    res.payload.message.toLowerCase().includes("which medicine") ||
    res.payload.message.toLowerCase().includes("what specific medicine"),
    "Must ask which medicine or supplement"
  );
  assert.equal(res.payload.conversationState.waitingForMedicineName, true);
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 6: Clean topic switching between medicines
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 6: Topic switching: Metformin -> Lisinopril switches active antecedent cleanly", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db);

  // Turn 1: Discuss Metformin
  const t1 = await sendChat(db, token, { message: "Metformin", conversationId: "conv-switch" });
  assert.equal(t1.payload.medicineName?.toLowerCase(), "metformin");

  // Turn 2: Explicitly switch topic to Lisinopril
  const t2 = await sendChat(db, token, {
    message: "Lisinopril",
    conversationId: "conv-switch",
    conversationState: t1.payload.conversationState,
    history: [
      { role: "user", content: "Metformin" },
      { role: "assistant", content: t1.payload.message }
    ]
  });
  assert.equal(t2.payload.medicineName?.toLowerCase(), "lisinopril");
  assert.equal(t2.payload.conversationState.lastMedicineName?.toLowerCase(), "lisinopril");

  // Turn 3: Follow-up pronoun must resolve to Lisinopril, not Metformin
  const t3 = await sendChat(db, token, {
    message: "what are its side effects?",
    conversationId: "conv-switch",
    conversationState: t2.payload.conversationState,
    history: [
      { role: "user", content: "Metformin" },
      { role: "assistant", content: t1.payload.message },
      { role: "user", content: "Lisinopril" },
      { role: "assistant", content: t2.payload.message }
    ]
  });
  assert.equal(t3.payload.medicineName?.toLowerCase(), "lisinopril");
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 7: Personal vs General medication distinction
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 7: Clarifies that un-scheduled medicine is not in DoseBuddy schedule", async () => {
  const db = new ConversationalDbAdapter([{ id: 101, name: "Atorvastatin", dosage: "20mg" }]);
  const token = await loginUser(db);

  // User asks about Aspirin (not in their DoseBuddy schedule)
  const res = await sendChat(db, token, {
    message: "when should I take Aspirin?",
    conversationId: "conv-schedule"
  });

  assert.equal(res.status, 200);
  assert.equal(res.payload.intent, "SCHEDULE");
  assert.ok(
    res.payload.message.includes("not in your scheduled medications") ||
    res.payload.message.includes("Atorvastatin"),
    "Must clarify that Aspirin is not in user's saved medications"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 8: Database persistence of conversations & messages
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 8: Conversations and messages are persisted in ai_conversations and ai_messages", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db);

  const res = await sendChat(db, token, {
    message: "Liv-52 DS",
    conversationId: "persisted-conv-1"
  });
  assert.equal(res.status, 200);

  // Check that ai_conversations has an entry
  assert.equal(db.conversations.has("persisted-conv-1"), true);
  const conv = db.conversations.get("persisted-conv-1");
  assert.equal(conv.active_topic?.toLowerCase(), "liv-52 ds");

  // Check that ai_messages recorded both user and assistant turns
  const msgs = db.messages.filter(m => m.conversation_id === "persisted-conv-1");
  assert.equal(msgs.length >= 2, true);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].content, "Liv-52 DS");
  assert.equal(msgs[1].role, "assistant");
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 9: Graceful degradation when tables are missing (optionalTableMissing)
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 9: Gracefully continues without 500 when ai_conversations or ai_messages table is absent", async () => {
  const db = new ConversationalDbAdapter([], true); // simulateMissingTables = true
  const token = await loginUser(db);

  const res = await sendChat(db, token, {
    message: "Zinc",
    conversationId: "conv-missing-table"
  });

  assert.equal(res.status, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.medicineName?.toLowerCase(), "zinc");
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 10: Conversation isolation by user (User A cannot access User B)
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 10: Strict user isolation prevents cross-account conversation inspection", async () => {
  const db = new ConversationalDbAdapter([]);
  const token1 = await loginUser(db, patient1);
  const token2 = await loginUser(db, patient2);

  // Patient 1 creates a conversation
  await sendChat(db, token1, {
    message: "Secret health condition details",
    conversationId: "p1-private-conv"
  });

  // Patient 2 attempts to fetch Patient 1's conversation
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/ai/conversations/p1-private-conv", {
    method: "GET",
    headers: { authorization: `Bearer ${token2}` }
  }), createEnv(db));

  assert.equal(response.status, 404, "Must return 404 not found when user tries to access another user's chat");
  const payload = await response.json() as any;
  assert.equal(payload.success, false);
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 11: Past chats list (GET /api/ai/conversations)
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 11: GET /api/ai/conversations lists conversations for the authenticated user", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db, patient1);

  await sendChat(db, token, { message: "Paracetamol", conversationId: "c1" });
  await sendChat(db, token, { message: "Ibuprofen", conversationId: "c2" });

  const resp = await worker.fetch(new Request("https://dosebuddy.test/api/ai/conversations", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` }
  }), createEnv(db));

  assert.equal(resp.status, 200);
  const data = await resp.json() as any;
  assert.equal(data.success, true);
  assert.equal(Array.isArray(data.conversations), true);
  assert.equal(data.conversations.length, 2);
  const ids = data.conversations.map((c: any) => c.id);
  assert.ok(ids.includes("c1"));
  assert.ok(ids.includes("c2"));
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 12: Delete conversation (DELETE /api/ai/conversations/:id)
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 12: DELETE /api/ai/conversations/:id removes conversation and respects authorization", async () => {
  const db = new ConversationalDbAdapter([]);
  const token1 = await loginUser(db, patient1);
  const token2 = await loginUser(db, patient2);

  await sendChat(db, token1, { message: "Test chat to delete", conversationId: "to-delete-conv" });
  assert.equal(db.conversations.has("to-delete-conv"), true);

  // Unauthorized delete by User 2
  const unauthResp = await worker.fetch(new Request("https://dosebuddy.test/api/ai/conversations/to-delete-conv", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token2}` }
  }), createEnv(db));
  assert.equal(unauthResp.status, 403);
  assert.equal(db.conversations.has("to-delete-conv"), true);

  // Authorized delete by User 1
  const authResp = await worker.fetch(new Request("https://dosebuddy.test/api/ai/conversations/to-delete-conv", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token1}` }
  }), createEnv(db));
  assert.equal(authResp.status, 200);
  assert.equal(db.conversations.has("to-delete-conv"), false);
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 13: New Chat lifecycle: start fresh chat without stale antecedent
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 13: New Chat starts fresh conversation without stale antecedent", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db);

  // Chat 1: Discusses Vitamin D
  const c1 = await sendChat(db, token, { message: "Vitamin D", conversationId: "chat-1" });
  assert.equal(c1.payload.medicineName?.toLowerCase(), "vitamin d");

  // User clicks "New Chat" -> new conversationId, empty state and history
  const c2 = await sendChat(db, token, {
    message: "what is that medicine used for?",
    conversationId: "chat-2",
    conversationState: {},
    history: []
  });
  // Must NOT carry over Vitamin D from chat-1!
  assert.equal(c2.payload.messageType, "QUESTION");
  assert.notEqual(c2.payload.medicineName?.toLowerCase(), "vitamin d");
});

// ────────────────────────────────────────────────────────────────────────────
// Scenario 14: Recoverable error and history preservation on provider failure
// ────────────────────────────────────────────────────────────────────────────
test("Scenario 14: Recoverable error and history preservation when all AI providers fail", async () => {
  const db = new ConversationalDbAdapter([]);
  const token = await loginUser(db);

  // Simulate AI provider failing with 500 error
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes("generativelanguage.googleapis.com") || url.includes("api.groq.com")) {
      return new Response("Simulated provider outage", { status: 500 });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await sendChat(db, token, {
      message: "What are the common symptoms of asthma?",
      conversationId: "conv-err-test"
    }, { GEMINI_API_KEY: "failing-key" });

    // Should return success: false with clear recoverable error message
    assert.equal(res.status, 200);
    assert.equal(res.payload.success, false);
    assert.ok(res.payload.error.includes("temporarily unavailable"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
