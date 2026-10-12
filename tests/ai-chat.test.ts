import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";

const patient = { id: 1, email: "patient@example.test", password_hash: "password123", name: "Patient", role: "PATIENT", time_zone: "UTC", accepted_terms: 1 };

// Fake DB adapter mirroring tests/worker-routes.test.ts. It answers the login
// query and the AI chat handler's medications query with a configurable list.
class ChatDbAdapter {
  calls: Array<[string, unknown[]]> = [];
  medications: any[];

  constructor(medications: any[] = []) {
    this.medications = medications;
  }

  async query(statement: string, values: unknown[] = []): Promise<any> {
    this.calls.push([statement, values]);
    if (statement.includes("FROM users WHERE email=?")) {
      return [[patient], undefined];
    }
    if (statement.includes("FROM users WHERE id=?")) {
      return [[patient], undefined];
    }
    if (statement.includes("JSON_ARRAYAGG") && statement.includes("FROM medications")) {
      return [this.medications, undefined];
    }
    return [{ affectedRows: 1, insertId: 12 }, undefined];
  }
  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  async end() {}
}

function env(db: ChatDbAdapter): any {
  // No GEMINI_API_KEY / GROQ_API_KEY -> callAi returns deterministic canned text.
  return { JWT_SECRET: "ai-chat-test-secret", TEST_DB_FACTORY: async () => db };
}

async function login(db: ChatDbAdapter) {
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: patient.email, password: "password123" })
  }), env(db));
  assert.equal(response.status, 200);
  return (await response.json() as any).accessToken as string;
}

async function chat(db: ChatDbAdapter, token: string, body: Record<string, unknown>) {
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/ai/chat", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env(db));
  const payload = await response.json() as any;
  return { status: response.status, payload };
}

const MEDICINE_FALLBACK = "What specific medicine, supplement, or health topic would you like to learn about?";

test("(1) 'zinc' routes to MEDICINE_INFO and is not the personal-medication question", async () => {
  const db = new ChatDbAdapter();
  const token = await login(db);
  const { status, payload } = await chat(db, token, { message: "zinc", conversationId: "c1" });
  assert.equal(status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.intent, "MEDICINE_INFO");
  assert.equal(payload.medicineName, "zinc");
  assert.notEqual(payload.message, MEDICINE_FALLBACK);
});

test("(2) fresh symptom report routes to SYMPTOM_CHECK, not the medicine fallback", async () => {
  const db = new ChatDbAdapter();
  const token = await login(db);
  const { payload } = await chat(db, token, { message: "I am feeling headache and body pains", conversationId: "c2" });
  assert.equal(payload.intent, "SYMPTOM_CHECK");
  assert.notEqual(payload.message, MEDICINE_FALLBACK);
});

test("(2b) stale currentIntent=MEDICINE_INFO still re-classifies a symptom report as SYMPTOM_CHECK", async () => {
  const db = new ChatDbAdapter();
  const token = await login(db);
  const { payload } = await chat(db, token, {
    message: "I am feeling headache and body pains",
    conversationId: "c2b",
    conversationState: { currentIntent: "MEDICINE_INFO" }
  });
  assert.equal(payload.intent, "SYMPTOM_CHECK");
  assert.notEqual(payload.message, MEDICINE_FALLBACK);
});

test("(3) 'Since yesterday' stays SYMPTOM_CHECK and preserves the reported symptom", async () => {
  const db = new ChatDbAdapter();
  const token = await login(db);
  const first = await chat(db, token, { message: "I am feeling headache and body pains", conversationId: "c3" });
  assert.equal(first.payload.intent, "SYMPTOM_CHECK");
  const state = first.payload.conversationState;
  assert.ok(state, "first turn returns conversationState");
  assert.ok(state.reportedSymptom, "symptom captured on first turn");

  const followUp = await chat(db, token, {
    message: "Since yesterday",
    conversationId: "c3",
    conversationState: state
  });
  assert.equal(followUp.payload.intent, "SYMPTOM_CHECK");
  assert.notEqual(followUp.payload.message, MEDICINE_FALLBACK);
  assert.ok(followUp.payload.conversationState.reportedSymptom, "symptom retained across follow-up");
});

test("(4) 'I also have fever' remains SYMPTOM_CHECK and retains prior symptom context", async () => {
  const db = new ChatDbAdapter();
  const token = await login(db);
  const first = await chat(db, token, { message: "I am feeling headache and body pains", conversationId: "c4" });
  const state1 = first.payload.conversationState;
  const second = await chat(db, token, { message: "Since yesterday", conversationId: "c4", conversationState: state1 });
  const state2 = second.payload.conversationState;

  const third = await chat(db, token, { message: "I also have fever", conversationId: "c4", conversationState: state2 });
  assert.equal(third.payload.intent, "SYMPTOM_CHECK");
  assert.ok(third.payload.conversationState.reportedSymptom, "symptom context retained");
  assert.ok(third.payload.conversationState.extractedFacts, "extracted facts retained");
});

test("(5) 'What medicines am I taking?' uses the authenticated user's actual medications", async () => {
  const meds = [{ id: 7, name: "Lisinopril", dosage: "10mg", times: [{ id: 1, timeOfDay: "08:00:00" }] }];
  const db = new ChatDbAdapter(meds);
  const token = await login(db);
  const { payload } = await chat(db, token, { message: "What medicines am I taking?", conversationId: "c5" });
  assert.equal(payload.intent, "MEDICINE_INFO");
  assert.ok(Array.isArray(payload.questions), "offers the user's medications as options");
  const texts = payload.questions.map((q: any) => q.value);
  assert.ok(texts.includes("Lisinopril"), "lists the user's real medication");
});

test("(6) side-effect question routes to the SIDE_EFFECT handler", async () => {
  const meds = [{ id: 7, name: "Lisinopril", dosage: "10mg", times: [{ id: 1, timeOfDay: "08:00:00" }] }];
  const db = new ChatDbAdapter(meds);
  const token = await login(db);
  const { payload } = await chat(db, token, { message: "Can this medicine cause headaches?", conversationId: "c6" });
  assert.equal(payload.intent, "SIDE_EFFECT");
});

test("(7) a fresh typed symptom report is not overridden by stale intent without isOptionSelection", async () => {
  const db = new ChatDbAdapter();
  const token = await login(db);
  const { payload } = await chat(db, token, {
    message: "I am feeling headache and body pains",
    conversationId: "c7",
    conversationState: { currentIntent: "MEDICINE_INFO" }
    // no isOptionSelection -> must be re-classified
  });
  assert.equal(payload.intent, "SYMPTOM_CHECK");
});

test("(10) with an empty medication list the personal path never fabricates a medicine", async () => {
  const db = new ChatDbAdapter([]);
  const token = await login(db);
  const { payload } = await chat(db, token, { message: "What medicines am I taking?", conversationId: "c10" });
  // No real meds exist, so the handler must not list any invented medicine.
  if (Array.isArray(payload.questions)) {
    const realOptions = payload.questions.filter((q: any) => q.value && q.value !== "custom");
    assert.equal(realOptions.length, 0, "no invented medications offered");
  }
  assert.ok(typeof payload.message === "string" && payload.message.length > 0);
});
