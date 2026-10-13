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

test("(11) 'Show me today's medicine schedule' routes to SCHEDULE", async () => {
  const meds = [{ id: 7, name: "Lisinopril", dosage: "10mg", times: [{ id: 1, timeOfDay: "08:00:00" }] }];
  const db = new ChatDbAdapter(meds);
  const token = await login(db);
  const { payload } = await chat(db, token, { message: "Show me today's medicine schedule", conversationId: "c11" });
  assert.equal(payload.intent, "SCHEDULE");
  assert.ok(typeof payload.message === "string" && payload.message.length > 0, "non-empty schedule message");
});

test("(12) all four welcome-screen starter prompts route to the intended handler", async () => {
  const meds = [{ id: 7, name: "Lisinopril", dosage: "10mg", times: [{ id: 1, timeOfDay: "08:00:00" }] }];
  const cases: Array<[string, string]> = [
    ["Tell me about one of my medicines", "MEDICINE_INFO"],
    ["I'm experiencing some symptoms", "SYMPTOM_CHECK"],
    ["I think I'm having a side effect", "SIDE_EFFECT"],
    ["Show me today's medicine schedule", "SCHEDULE"]
  ];
  let i = 0;
  for (const [message, expected] of cases) {
    const db = new ChatDbAdapter(meds);
    const token = await login(db);
    const { payload } = await chat(db, token, { message, conversationId: `c12-${i++}` });
    assert.equal(payload.intent, expected, `"${message}" should route to ${expected}`);
  }
});

test("(13) after a completed SIDE_EFFECT turn, a new unrelated message re-classifies and does not get stuck", async () => {
  const meds = [{ id: 7, name: "Lisinopril", dosage: "10mg", times: [{ id: 1, timeOfDay: "08:00:00" }] }];
  const db = new ChatDbAdapter(meds);
  const token = await login(db);

  // 1) Enter the side-effect flow -> asks which medicine.
  const first = await chat(db, token, { message: "I think I'm having a side effect", conversationId: "c13" });
  assert.equal(first.payload.intent, "SIDE_EFFECT");
  assert.equal(first.payload.messageType, "QUESTION");
  const stateAfterQuestion = first.payload.conversationState;

  // 2) Answer the "which medicine" question (option selection) -> completes the flow with a real answer.
  const answered = await chat(db, token, {
    message: "Lisinopril",
    conversationId: "c13",
    conversationState: stateAfterQuestion,
    isOptionSelection: true
  });
  assert.equal(answered.payload.intent, "SIDE_EFFECT");
  assert.equal(answered.payload.messageType, "RESPONSE");
  assert.ok(answered.payload.conversationState.completed === true, "side-effect flow completes");
  const stateAfterAnswer = answered.payload.conversationState;

  // 3) A brand-new unrelated message must re-classify, not dead-end on the side-effect handler.
  // (In the keyless test env callAi returns the same generic "unavailable" notice for every
  // prompt, so the meaningful anti-stuck signal is the re-classified intent and the cleared
  // in-flight question state, not the exact AI wording.)
  const next = await chat(db, token, {
    message: "zinc",
    conversationId: "c13",
    conversationState: stateAfterAnswer
  });
  assert.equal(next.payload.intent, "MEDICINE_INFO", "new typed message re-classifies away from SIDE_EFFECT");
  assert.equal(next.payload.medicineName, "zinc", "the new message is handled fresh by the medicine handler");
  assert.notEqual(next.payload.conversationState.currentIntent, "SIDE_EFFECT", "stored intent advances, not stuck");
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
