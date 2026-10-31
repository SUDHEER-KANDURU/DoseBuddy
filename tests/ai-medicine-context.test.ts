import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";

const patient = {
  id: 1,
  email: "patient@example.test",
  password_hash: "password123",
  name: "Patient",
  role: "PATIENT",
  time_zone: "UTC",
  accepted_terms: 1
};

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

function env(db: ChatDbAdapter, extra: Record<string, string> = {}): any {
  return {
    JWT_SECRET: "ai-chat-test-secret",
    TEST_DB_FACTORY: async () => db,
    ...extra
  };
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

async function chat(db: ChatDbAdapter, token: string, body: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/ai/chat", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env(db, extraEnv));
  const payload = await response.json() as any;
  return { status: response.status, payload };
}

const MEDICINE_FALLBACK = "What specific medicine, supplement, or health topic would you like to learn about?";

test("1. Reproduction: 'Liv-52 DS' followed by 'what is that medicine used for?'", async () => {
  const db = new ChatDbAdapter([]);
  const token = await login(db);

  // Turn 1: User asks "Tell me about one of my medicines"
  const turn1 = await chat(db, token, {
    message: "Tell me about one of my medicines",
    conversationId: "conv-1"
  });
  assert.equal(turn1.status, 200);
  assert.equal(turn1.payload.intent, "MEDICINE_INFO");
  assert.ok(turn1.payload.message.includes("You don't have any medicines saved in DoseBuddy yet"));
  const state1 = turn1.payload.conversationState;

  // Turn 2: User enters "Liv-52 DS"
  const turn2 = await chat(db, token, {
    message: "Liv-52 DS",
    conversationId: "conv-1",
    conversationState: state1,
    history: [
      { role: "user", content: "Tell me about one of my medicines" },
      { role: "assistant", content: turn1.payload.message }
    ]
  });
  assert.equal(turn2.status, 200);
  assert.equal(turn2.payload.intent, "MEDICINE_INFO");
  assert.equal(turn2.payload.medicineName?.toLowerCase(), "liv-52 ds");
  assert.notEqual(turn2.payload.message, MEDICINE_FALLBACK, "Must not ask again for a medicine name");
  const state2 = turn2.payload.conversationState;
  assert.ok(state2.lastMedicineName, "State should preserve lastMedicineName");

  // Turn 3: User enters follow-up "what is that medicine used for?"
  const turn3 = await chat(db, token, {
    message: "what is that medicine used for?",
    conversationId: "conv-1",
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
  assert.equal(turn3.payload.medicineName?.toLowerCase(), "liv-52 ds", "Follow-up must resolve to Liv-52 DS");
  assert.notEqual(turn3.payload.medicineName, "that medicine used for", "Must NOT treat question phrase as medicine name");
});

test("2. Follow-up asking about side effects of previously mentioned product", async () => {
  const db = new ChatDbAdapter([]);
  const token = await login(db);

  // Turn 1: Mention a medicine
  const turn1 = await chat(db, token, {
    message: "Liv-52 DS",
    conversationId: "conv-2"
  });
  const state1 = turn1.payload.conversationState;

  // Turn 2: Ask about side effects using pronoun "it"
  const turn2 = await chat(db, token, {
    message: "does it have side effects?",
    conversationId: "conv-2",
    conversationState: state1,
    history: [
      { role: "user", content: "Liv-52 DS" },
      { role: "assistant", content: turn1.payload.message }
    ]
  });
  assert.equal(turn2.status, 200);
  assert.equal(turn2.payload.intent, "SIDE_EFFECT");
  assert.equal(turn2.payload.medicineName?.toLowerCase(), "liv-52 ds");
});

test("3. Medicine absent from the user's personal medication list provides general info", async () => {
  // User has Aspirin in personal schedule, but asks about Liv-52 DS (absent from schedule)
  const db = new ChatDbAdapter([{ id: 10, name: "Aspirin", dosage: "81mg" }]);
  const token = await login(db);

  const res = await chat(db, token, {
    message: "Liv-52 DS",
    conversationId: "conv-3"
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.intent, "MEDICINE_INFO");
  assert.equal(res.payload.medicineName?.toLowerCase(), "liv-52 ds");
  assert.notEqual(res.payload.message, MEDICINE_FALLBACK);
  // It shouldn't force-select Aspirin from the personal list
  assert.equal(res.payload.messageType, "RESPONSE");
});

test("4. A genuinely ambiguous or unrecognized product asks for clarification without fabricating", async () => {
  const db = new ChatDbAdapter([]);
  const token = await login(db);

  // Random symbols/punctuation or gibberish
  const res = await chat(db, token, {
    message: "??? !!! @#$%",
    conversationId: "conv-4"
  });
  assert.equal(res.status, 200);
  // Should route to general/clarification or ask for specific name
  assert.ok(
    res.payload.intent === "GENERAL" ||
    res.payload.message.includes("What specific medicine") ||
    res.payload.message.includes("Please provide") ||
    res.payload.message.includes("could not recognize")
  );
});

test("5. Missing conversation history or session ID handles pronoun follow-up gracefully", async () => {
  const db = new ChatDbAdapter([]);
  const token = await login(db);

  // Directly ask "what is that medicine used for?" with NO prior state or history
  const res = await chat(db, token, {
    message: "what is that medicine used for?",
    conversationId: "conv-orphan"
    // No conversationState, no history
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.success, true);
  // Must NOT treat "that medicine used for" as a real medicine
  assert.notEqual(res.payload.medicineName, "that medicine used for");
  // Must politely ask which medicine is being referred to
  assert.ok(
    res.payload.message.toLowerCase().includes("which medicine") ||
    res.payload.message.toLowerCase().includes("what medicine") ||
    res.payload.message.toLowerCase().includes("please provide the name") ||
    res.payload.message.toLowerCase().includes("specific medicine")
  );
});

test("6. Prompt construction ensures AI is instructed not to fabricate claims or dosage", async () => {
  const db = new ChatDbAdapter([]);
  const token = await login(db);

  let capturedPrompt = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes("generativelanguage.googleapis.com")) {
      const parsedBody = JSON.parse(init?.body || "{}");
      capturedPrompt = parsedBody.contents?.[0]?.parts?.[0]?.text || "";
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: "Liv-52 DS is a dietary herbal supplement commonly used for liver health support. Important cautions: consult a physician."
            }]
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await chat(db, token, {
      message: "Liv-52 DS",
      conversationId: "conv-prompt-test"
    }, { GEMINI_API_KEY: "test-gemini-key" });

    assert.equal(res.status, 200);
    assert.equal(res.payload.success, true);
    assert.ok(capturedPrompt.includes("Liv-52 DS"));
    // Verify prompt instructs non-diagnostic, no unsupported dosing, no fabricated claims
    assert.ok(
      capturedPrompt.includes("non-diagnostic") ||
      capturedPrompt.includes("do not diagnose") ||
      capturedPrompt.includes("consult")
    );
    assert.ok(
      capturedPrompt.includes("not recognize") ||
      capturedPrompt.includes("fabricate") ||
      capturedPrompt.includes("double-check") ||
      capturedPrompt.includes("spelling")
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
