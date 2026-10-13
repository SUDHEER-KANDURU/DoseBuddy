import { createConnection } from "mysql2/promise";
import bcrypt from "bcryptjs";
import { addLocalDays, canonicalTimeZone, dueOccurrencesAtInstant, resolveLocalOccurrence, zonedParts } from "./scheduling.ts";
import { markOccurrenceMissed, markOccurrenceTaken, transact, upsertOccurrence } from "./dose-occurrences.ts";
import { claimDeliveryAttempt, finalizeDelivery, notificationEventId, obsoleteClaim, occurrenceIsCurrent, releaseUnstartedClaim, startDeliveryDispatch, type DeliveryClaim, type DeliveryOccurrence } from "./notification-delivery.ts";
import { sendWebPush, type PushSubscriptionData } from "./web-push.ts";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  JWT_SECRET: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GROQ_MODEL?: string;
  GEMINI_MODEL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_EMAIL?: string;
  /** Test-only database adapter; Cloudflare bindings never provide this property. */
  TEST_DB_FACTORY?: () => Promise<any>;
}

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

type Json = Record<string, any>;
type User = Json & { id: number; email: string; password_hash: string; role: string; patient_email?: string | null; time_zone?: string | null };

const enc = new TextEncoder(), dec = new TextDecoder(), ACCESS = 900, REFRESH = 604800;
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-max-age": "3600"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" }
  });
const plain = (body: string, status = 200) => new Response(body, { status, headers: cors });
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

function unb64(value: string) {
  const normal = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(normal), c => c.charCodeAt(0));
}

async function key(secret: string) {
  let raw: Uint8Array;
  try {
    raw = unb64(secret);
  } catch {
    raw = enc.encode(secret);
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function jwt(env: Env, claims: Json) {
  const h = b64url(enc.encode('{"alg":"HS256","typ":"JWT"}')),
    p = b64url(enc.encode(JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000) })));
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", await key(env.JWT_SECRET), enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(s)}`;
}

async function claims(env: Env, token: string) {
  const [h, p, s, extra] = token.split(".");
  if (!h || !p || !s || extra) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await key(env.JWT_SECRET), unb64(s), enc.encode(`${h}.${p}`));
    const payload = JSON.parse(dec.decode(unb64(p))) as Json;
    return valid && payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

async function getDbConnection(env: Env) {
  if (env.TEST_DB_FACTORY) return env.TEST_DB_FACTORY();
  return (await createConnection({
    host: env.HYPERDRIVE.host,
    user: env.HYPERDRIVE.user,
    password: env.HYPERDRIVE.password,
    database: env.HYPERDRIVE.database,
    port: env.HYPERDRIVE.port,
    timezone: "Z",
    connectTimeout: 5000,         // 5 second connection timeout
    multipleStatements: false,    // Security: disable multiple statements
    // mysql2's default row parser compiles code with new Function. Cloudflare
    // Workers disallow string-based code generation, so use its interpreted
    // parser for all Hyperdrive results.
    disableEval: true
  })) as any;
}

async function query<T = Json[]>(
  envOrConn: Env | any,
  statement: string,
  values: unknown[] = []
): Promise<[T, unknown]> {
  const queryStart = Date.now();
  
  if (envOrConn && typeof envOrConn.query === "function") {
    try {
      const result = (await envOrConn.query(statement, values)) as [T, unknown];
      const queryTime = Date.now() - queryStart;
      if (queryTime > 1000) {  // Log slow queries over 1 second
        console.warn(`[DB] Slow query took ${queryTime}ms: ${statement.slice(0, 100)}...`);
      }
      return result;
    } catch (error) {
      console.error(`[DB] Query failed after ${Date.now() - queryStart}ms:`, statement.slice(0, 100));
      throw error;
    }
  }
  
  const db = await getDbConnection(envOrConn as Env);
  try {
    const result = (await db.query(statement, values)) as [T, unknown];
    const queryTime = Date.now() - queryStart;
    if (queryTime > 1000) {  // Log slow queries over 1 second
      console.warn(`[DB] Slow query took ${queryTime}ms: ${statement.slice(0, 100)}...`);
    }
    return result;
  } catch (error) {
    console.error(`[DB] Query failed after ${Date.now() - queryStart}ms:`, statement.slice(0, 100));
    throw error;
  } finally {
    await db.end();
  }
}

async function getUser(envOrConn: Env | any, id: number) {
  const [rows] = await query<User[]>(envOrConn, "SELECT * FROM users WHERE id=? LIMIT 1", [id]);
  return rows[0] ?? null;
}

async function userFor(request: Request, env: Env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const c = token ? await claims(env, token) : null;
  return c?.type === "access" && typeof c.userId === "number" ? getUser(env, c.userId) : null;
}

const accessible = (actor: User, target: User) =>
  actor.id === target.id ||
  (actor.role?.toUpperCase() === "CAREGIVER" && actor.patient_email?.toLowerCase() === target.email.toLowerCase());

async function requestBody(request: Request): Promise<{ body: Json; error?: string }> {
  try {
    const raw = await request.text();
    if (!raw || !raw.trim()) {
      return { body: {} };
    }
    let text = raw.trim();
    if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
      text = text.slice(1, -1).trim();
    }
    const parsed = JSON.parse(text);
    return { body: typeof parsed === "object" && parsed !== null ? parsed : {} };
  } catch (e) {
    return { body: {}, error: "Malformed JSON payload" };
  }
}

function medicationCreatePayload(body: Json): { value?: { name: string; dosage: string; instructions: string | null; startDate: string; endDate: string; times: string[] }; error?: string } {
  const calendarDate = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  if (typeof body.name !== "string" || !body.name.trim()) return { error: "Medication name is required" };
  if (typeof body.dosage !== "string" || !body.dosage.trim()) return { error: "Medication dosage is required" };
  if (!calendarDate(body.startDate) || !calendarDate(body.endDate)) return { error: "Start and end dates must use YYYY-MM-DD" };
  if (body.endDate < body.startDate) return { error: "End date cannot be before start date" };
  if (!Array.isArray(body.times) || body.times.length === 0) return { error: "At least one medication time is required" };
  const times: string[] = [];
  for (const value of body.times) {
    if (typeof value !== "string") return { error: "Medication times must use HH:mm" };
    const match = /^(\d{2}):(\d{2})(?::00)?$/.exec(value);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return { error: "Medication times must use HH:mm" };
    times.push(`${match[1]}:${match[2]}`);
  }
  if (new Set(times).size !== times.length) return { error: "Duplicate medication times are not allowed" };
  return {
    value: {
      name: body.name.trim(), dosage: body.dosage.trim(),
      instructions: typeof body.instructions === "string" ? body.instructions : null,
      startDate: body.startDate, endDate: body.endDate, times
    }
  };
}

function medicationSchemaNotReady(error: unknown) {
  const e = error as { code?: unknown; message?: unknown; sqlMessage?: unknown };
  const message = [e.message, e.sqlMessage].filter(value => typeof value === "string").join(" ");
  return e.code === "ER_BAD_FIELD_ERROR" && /\b(active|schedule_version)\b/i.test(message);
}

function timeZoneSchemaNotReady(error: unknown) {
  const e = error as { code?: unknown; message?: unknown; sqlMessage?: unknown };
  const message = [e.message, e.sqlMessage].filter(value => typeof value === "string").join(" ");
  return e.code === "ER_BAD_FIELD_ERROR" && /\btime_zone\b/i.test(message);
}

function logSignupFailure(phase: string, error: unknown) {
  const e = error as {
    name?: unknown;
    code?: unknown;
    errno?: unknown;
    sqlState?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  };
  const safe = (value: unknown) =>
    typeof value === "string"
      ? value
          .replace(/(?:mysql|mysqls):\/\/[^\s]+/gi, "[redacted connection string]")
          .replace(/\$2[aby]\$[^\s]+/g, "[redacted bcrypt hash]")
          .slice(0, 500)
      : undefined;

  console.error(
    JSON.stringify({
      operation: "auth.signup",
      sqlPhase: phase,
      errorType: typeof e.name === "string" ? e.name : "UnknownError",
      mysqlCode: e.code,
      mysqlErrno: e.errno,
      sqlState: e.sqlState,
      mysqlMessage: safe(e.sqlMessage ?? e.message)
    })
  );
}

async function loginBody(env: Env, user: User) {
  const base = { userId: user.id, sub: user.email };
  const dobStr = user.dob ? (typeof user.dob === "string" ? user.dob.slice(0, 10) : new Date(user.dob).toISOString().slice(0, 10)) : null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    patientEmail: user.patient_email,
    phone: user.phone,
    dob: dobStr,
    gender: user.gender,
    emergencyContact: user.emergency_contact,
    acceptedTerms: Boolean(user.accepted_terms),
    timeZone: user.time_zone ?? null,
    accessToken: await jwt(env, { ...base, role: user.role, type: "access", exp: Math.floor(Date.now() / 1000) + ACCESS }),
    refreshToken: await jwt(env, { ...base, type: "refresh", exp: Math.floor(Date.now() / 1000) + REFRESH }),
    expiresIn: ACCESS
  };
}

// ── BMI Helpers ─────────────────────────────────────────────────────────────
function buildBmiResponse(r: Json) {
  const cat = String(r.bmi_category || r.bmiCategory || "NORMAL").toUpperCase();
  const statusMap: Record<string, { status: string; color: string; suggestions: string[]; diet: string[] }> = {
    UNDERWEIGHT: {
      status: "Below Healthy Weight",
      color: "#3b82f6",
      suggestions: [
        "Focus on nutrient-dense foods to gain weight healthily",
        "Include protein-rich foods in every meal",
        "Consider strength training exercises to build muscle mass",
        "Eat more frequently with healthy snacks between meals",
        "Consult a nutritionist for a personalized meal plan"
      ],
      diet: [
        "Increase calorie intake with healthy fats (nuts, avocados, olive oil)",
        "Add protein shakes or smoothies between meals",
        "Include whole grains, lean meats, and dairy products",
        "Eat calorie-dense foods like nut butters and dried fruits",
        "Don't skip meals - aim for 5-6 smaller meals daily"
      ]
    },
    NORMAL: {
      status: "Healthy Weight",
      color: "#22c55e",
      suggestions: [
        "Maintain your current healthy lifestyle",
        "Continue balanced nutrition and regular exercise",
        "Stay hydrated with 8-10 glasses of water daily",
        "Get adequate sleep (7-9 hours) for optimal health",
        "Regular health check-ups to monitor your wellness"
      ],
      diet: [
        "Continue eating a variety of colorful fruits and vegetables",
        "Choose whole grains over refined carbohydrates",
        "Include lean proteins (fish, chicken, legumes)",
        "Limit added sugars and saturated fats",
        "Practice mindful eating and listen to hunger cues"
      ]
    },
    OVERWEIGHT: {
      status: "Above Healthy Weight",
      color: "#f59e0b",
      suggestions: [
        "Gradually increase physical activity to 150 minutes per week",
        "Focus on portion control and mindful eating",
        "Reduce intake of processed and high-calorie foods",
        "Include more vegetables and whole grains in your diet",
        "Consider consulting a healthcare professional for guidance"
      ],
      diet: [
        "Reduce portion sizes gradually",
        "Fill half your plate with vegetables at each meal",
        "Choose lean proteins and limit red meat",
        "Avoid sugary drinks - opt for water or unsweetened beverages",
        "Limit eating out and prepare more meals at home"
      ]
    },
    OBESE: {
      status: "Obesity Range",
      color: "#ef4444",
      suggestions: [
        "Consult a healthcare professional for a comprehensive health plan",
        "Start with small, sustainable lifestyle changes",
        "Focus on gradual weight reduction (0.5-1 kg per week)",
        "Consider working with a registered dietitian",
        "Regular monitoring of blood pressure and blood sugar levels"
      ],
      diet: [
        "Create a structured meal plan with professional guidance",
        "Eliminate processed foods and fast food",
        "Focus on high-fiber foods to increase satiety",
        "Practice meal prepping to avoid unhealthy choices",
        "Keep a food diary to track eating patterns"
      ]
    }
  };
  const info = statusMap[cat] || statusMap.NORMAL;
  return {
    id: r.id,
    userId: r.user_id || r.userId,
    height: Number(r.height),
    weight: Number(r.weight),
    bmiValue: Number(r.bmi_value || r.bmiValue),
    bmiCategory: cat,
    healthStatus: info.status,
    statusColor: info.color,
    healthSuggestions: info.suggestions,
    dietRecommendations: info.diet,
    createdAt: r.created_at || r.createdAt
  };
}

// ── Vitals Helpers ──────────────────────────────────────────────────────────
function classifyBp(sys?: number | null, dia?: number | null) {
  if (sys == null || dia == null) return null;
  if (sys < 90 || dia < 60) return "LOW";
  if (sys < 120 && dia < 80) return "NORMAL";
  if (sys < 130 && dia < 80) return "ELEVATED";
  if (sys < 140 || dia < 90) return "HIGH_STAGE1";
  return "HIGH_STAGE2";
}
function classifySugar(sugar?: number | null) {
  if (sugar == null) return null;
  if (sugar < 70) return "LOW";
  if (sugar <= 140) return "NORMAL";
  if (sugar <= 200) return "ELEVATED";
  return "HIGH";
}
function classifyHeartRate(hr?: number | null) {
  if (hr == null) return null;
  if (hr < 60) return "LOW";
  if (hr <= 100) return "NORMAL";
  return "HIGH";
}
function classifyTemp(temp?: number | null) {
  if (temp == null) return null;
  if (temp < 36.0) return "HYPOTHERMIA";
  if (temp <= 37.5) return "NORMAL";
  if (temp <= 38.5) return "LOW_FEVER";
  return "FEVER";
}

function buildVitalResponse(r: Json) {
  const bpSystolic = r.bp_systolic != null ? Number(r.bp_systolic) : null;
  const bpDiastolic = r.bp_diastolic != null ? Number(r.bp_diastolic) : null;
  const bloodSugar = r.blood_sugar != null ? Number(r.blood_sugar) : null;
  const weight = r.weight != null ? Number(r.weight) : null;
  const heartRate = r.heart_rate != null ? Number(r.heart_rate) : null;
  const temperature = r.temperature != null ? Number(r.temperature) : null;

  return {
    id: r.id,
    userId: r.user_id,
    bpSystolic,
    bpDiastolic,
    bloodSugar,
    weight,
    heartRate,
    temperature,
    notes: r.notes || null,
    recordedAt: r.recorded_at,
    bpStatus: classifyBp(bpSystolic, bpDiastolic),
    sugarStatus: classifySugar(bloodSugar),
    heartRateStatus: classifyHeartRate(heartRate),
    tempStatus: classifyTemp(temperature)
  };
}

function bufferToBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 16384;
  for (let i = 0; i < len; i += chunkSize) {
    const end = Math.min(i + chunkSize, len);
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, end)));
  }
  return btoa(binary);
}

// ── Web Push Notification Functions ─────────────────────────────────────────
function vapidConfig(env: Env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_EMAIL) {
    throw new Error("VAPID credentials not configured");
  }
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_EMAIL.includes(":") ? env.VAPID_EMAIL : `mailto:${env.VAPID_EMAIL}`
  };
}

const mysqlDateTime = (date: Date) => date.toISOString().slice(0, 23).replace("T", " ");
const mysqlDate = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

const PRESCRIPTION_PROMPT = `You are an expert Clinical Pharmacist and Medical Prescription Document Parser specializing in outpatient, inpatient, printed EHR summaries, and doctor prescriptions.

CRITICAL EXTRACTION & ORIENTATION RULES:
1. AUTOMATIC ORIENTATION & MULTI-PAGE UNDERSTANDING:
   - The document or image(s) may be in ANY orientation (0° upright, 90° clockwise, 180° inverted, 270° counter-clockwise, or photographed at an angle).
   - Determine reading orientation independently for each page/document.
   - Read all text in its true visual orientation. All uploaded pages/files belong to ONE SINGLE prescription.
   - EXTRACT EVERY MEDICINE you can read — do not skip medicines because they seem common or redundant.

2. TABLE & SCHEDULE DISSECTION (ROW-TO-COLUMN PRESERVATION):
   - In prescriptions with schedule tables containing columns such as [Medicine] | [Morning] | [Afternoon] | [Evening] | [Night] | [Instructions]:
     * A dosage value ("1", "0.5", "2", "✓", "½") in a column belongs ONLY to the medicine row on that exact same horizontal line.
     * Never shift timing values between rows.
     * Columns with "-", "–", "0", or empty mean that slot is NOT taken (value = 0).
   - Standard slot times:
     * Morning = 08:00
     * Afternoon = 13:00 / 14:00
     * Evening = 18:00
     * Night = 21:00
   - When schedule is written as text (e.g. "1-0-1", "BD", "TDS", "OD", "QID"):
     * OD / Once daily = Morning only (morning:1)
     * BD / BID / Twice daily = Morning + Night (morning:1, night:1)
     * TDS / TID / Three times daily = Morning + Afternoon + Night (morning:1, afternoon:1, night:1)
     * QID / Four times daily = Morning + Afternoon + Evening + Night (morning:1, afternoon:1, evening:1, night:1)
     * 1-0-1 = Morning + Night (morning:1, night:1)
     * 1-1-1 = Morning + Afternoon + Night (morning:1, afternoon:1, night:1)
     * 0-0-1 = Night only (night:1)
     * 1-0-0 = Morning only (morning:1)
     * Morning/Night = morning:1, night:1

3. ZERO HALLUCINATION POLICY:
   - Extract ONLY medications and instructions physically visible in the document.
   - If a medicine name is clearly printed/written, you MUST include it — do not skip readable medicines.
   - If a medicine name is illegible or unreadable, set needsVerification: true and confidence: 0.4.
   - Strip packaging terms like "15'S", "10'S", "TAB", "CAP", "SYR", "INJ" from the clean brand name, but preserve the strength (e.g. "ESOMAC 40MG").
   - Extract generic name if present in parentheses (e.g. "ESOMEPRAZOLE 40MG").
   - Never invent or guess medicine names — only extract what is physically visible.

Return ONLY a valid JSON object matching this schema:
{
  "medicines": [
    {
      "brandName": "string",
      "genericName": "string or empty",
      "strength": "string",
      "dosage": "string",
      "form": "string",
      "morning": 0,
      "afternoon": 0,
      "evening": 0,
      "night": 0,
      "foodInstruction": "string (e.g. Before meal, After meal, Before Breakfast, With food)",
      "startDate": "string or empty",
      "duration": "string",
      "durationDays": 30,
      "confidence": 0.95,
      "nameConfidence": 0.95,
      "strengthConfidence": 0.95,
      "scheduleConfidence": 0.95,
      "durationConfidence": 0.95,
      "needsVerification": false,
      "possibleAlternatives": [],
      "sourceText": "string"
    }
  ],
  "patientName": "string or empty",
  "doctorName": "string or empty",
  "visitDate": "string or empty"
}`;

function extractJsonFromText(rawText: string): any {
  if (!rawText || !rawText.trim()) return null;
  let text = rawText.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const sub = text.substring(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(sub);
      } catch (e2) {
        const cleaned = sub.replace(/,\s*([}\]])/g, "$1");
        try {
          return JSON.parse(cleaned);
        } catch (e3) {}
      }
    }

    const firstBracket = text.indexOf("[");
    const lastBracket = text.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      const sub = text.substring(firstBracket, lastBracket + 1);
      try {
        return JSON.parse(sub);
      } catch (e2) {
        const cleaned = sub.replace(/,\s*([}\]])/g, "$1");
        try {
          return JSON.parse(cleaned);
        } catch (e3) {}
      }
    }
  }
  return null;
}

function normalizePrescriptionResult(rawJson: string) {
  const parsed = extractJsonFromText(rawJson);
  let list: any[] = [];
  if (parsed) {
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (Array.isArray(parsed.medicines)) {
      list = parsed.medicines;
    } else if (Array.isArray(parsed.medications)) {
      list = parsed.medications;
    }
  }

  const normalized = list.map((m: any) => {
    const rawBrand = String(m.brandName || m.name || m.medicineName || m.drug || "").trim();
    const cleanBrand = rawBrand
      .replace(/^(?:TAB\.?|CAP\.?|SYR\.?|INJ\.?|OINT\.?|DRP\.?)\s+/i, "")
      .replace(/\b\d+['’]?[sS]\b/g, "")
      .replace(/\b(?:TAB|CAP|SYR|INJ)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    const genericName = String(m.genericName || "").replace(/^\((.*)\)$/, "$1").trim();
    const strength = String(m.strength || "").trim();
    const form = String(m.form || "Tablet").trim();
    const dosage = String(m.dosage || (form ? `1 ${form}` : "1 Tablet")).trim();
    
    const morning = Number(m.morning || 0);
    const afternoon = Number(m.afternoon || 0);
    const evening = Number(m.evening || 0);
    const night = Number(m.night || 0);

    const times: string[] = [];
    if (Array.isArray(m.times) && m.times.length > 0) {
      m.times.forEach((t: any) => {
        const normT = String(t).trim();
        if (/^\d{2}:\d{2}$/.test(normT)) times.push(normT);
        else if (/^\d:\d{2}$/.test(normT)) times.push("0" + normT);
      });
    }
    if (times.length === 0) {
      if (morning > 0) times.push("08:00");
      if (afternoon > 0) times.push("13:00");
      if (evening > 0) times.push("18:00");
      if (night > 0) times.push("21:00");
    }
    if (times.length === 0) times.push("08:00");

    const scheduleList: { timeOfDay: string; quantity: number; time: string }[] = [];
    if (morning > 0)   scheduleList.push({ timeOfDay: "morning", quantity: morning, time: "08:00" });
    if (afternoon > 0) scheduleList.push({ timeOfDay: "afternoon", quantity: afternoon, time: "13:00" });
    if (evening > 0)   scheduleList.push({ timeOfDay: "evening", quantity: evening, time: "18:00" });
    if (night > 0)     scheduleList.push({ timeOfDay: "night", quantity: night, time: "21:00" });

    const foodInstruction = String(m.foodInstruction || m.food_instruction || m.instructions || "Before meal").trim();

    let durationDays = m.durationDays ? Number(m.durationDays) : (m.duration_days ? Number(m.duration_days) : null);
    let durationStr = String(m.duration || "").trim();
    let durationVal = m.duration_value !== undefined && m.duration_value !== null ? Number(m.duration_value) : null;
    const durationUnit = String(m.duration_unit || "").toLowerCase().trim();

    if (!durationDays && durationVal) {
      if (durationUnit.includes("month")) durationDays = durationVal * 30;
      else if (durationUnit.includes("week")) durationDays = durationVal * 7;
      else if (durationUnit.includes("day")) durationDays = durationVal;
    }
    if (!durationDays && durationStr) {
      const match = durationStr.match(/(\d+)\s*(month|week|day)/i);
      if (match) {
        const num = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        if (unit.startsWith("month")) durationDays = num * 30;
        else if (unit.startsWith("week")) durationDays = num * 7;
        else if (unit.startsWith("day")) durationDays = num;
      }
    }
    if (!durationDays) durationDays = 30;

    const nameConf = typeof m.nameConfidence === "number" ? m.nameConfidence : (typeof m.name_confidence === "number" ? m.name_confidence : (typeof m.confidence === "number" ? m.confidence : 0.9));
    const strengthConf = typeof m.strengthConfidence === "number" ? m.strengthConfidence : (typeof m.strength_confidence === "number" ? m.strength_confidence : nameConf);
    const schedConf = typeof m.scheduleConfidence === "number" ? m.scheduleConfidence : (typeof m.schedule_confidence === "number" ? m.schedule_confidence : nameConf);
    const durConf = typeof m.durationConfidence === "number" ? m.durationConfidence : (typeof m.duration_confidence === "number" ? m.duration_confidence : nameConf);
    const overallConf = typeof m.confidence === "number" ? m.confidence : Math.min(nameConf, strengthConf, schedConf, durConf);

    const needsVerify = Boolean(m.needsVerification || m.needs_confirmation || overallConf < 0.65 || nameConf < 0.65 || !cleanBrand);
    const displayName = cleanBrand ? (strength && !cleanBrand.toLowerCase().includes(strength.toLowerCase()) ? `${cleanBrand} ${strength}` : cleanBrand) : "Unknown Medicine";

    return {
      name: cleanBrand || "Unknown Medicine",
      brandName: cleanBrand,
      genericName: genericName,
      medicineName: displayName,
      strength: strength,
      dosage: dosage,
      form: form,
      morning: morning,
      afternoon: afternoon,
      evening: evening,
      night: night,
      schedule: scheduleList,
      foodInstruction: foodInstruction,
      instructions: foodInstruction,
      startDate: String(m.startDate || "").trim(),
      duration: durationStr || `${durationDays} Days`,
      durationDays: durationDays,
      times: times,
      confidence: Math.round(overallConf * 100) / 100,
      nameConfidence: Math.round(nameConf * 100) / 100,
      strengthConfidence: Math.round(strengthConf * 100) / 100,
      scheduleConfidence: Math.round(schedConf * 100) / 100,
      durationConfidence: Math.round(durConf * 100) / 100,
      needsVerification: needsVerify,
      needs_confirmation: needsVerify,
      possibleAlternatives: Array.isArray(m.possibleAlternatives) ? m.possibleAlternatives : [],
      sourceText: String(m.sourceText || m.source_text || "").trim()
    };
  });

  return {
    medicines: normalized,
    patientName: parsed?.patientName || parsed?.patient_name || "",
    doctorName: parsed?.doctorName || parsed?.doctor_name || "",
    visitDate: parsed?.visitDate || parsed?.visit_date || "",
    disclaimer: "AI-assisted extraction — please verify all medicines, dosage, timing and duration against your prescription before saving.",
    extractedCount: normalized.length
  };
}

function mergeExtractedResults(results: Array<{ medicines: any[]; patientName?: string; doctorName?: string; visitDate?: string }>) {
  const mergedMeds: any[] = [];
  let patientName = "";
  let doctorName = "";
  let visitDate = "";

  function getMedKey(med: any): string {
    const raw = String(med.brandName || med.name || med.medicineName || "").toLowerCase();
    const clean = raw.replace(/[^a-z0-9]/g, "");
    const str = String(med.strength || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return `${clean}__${str}`;
  }

  for (const res of results) {
    if (!patientName && res.patientName) patientName = res.patientName;
    if (!doctorName && res.doctorName) doctorName = res.doctorName;
    if (!visitDate && res.visitDate) visitDate = res.visitDate;

    if (Array.isArray(res.medicines)) {
      for (const med of res.medicines) {
        if (!med.brandName && !med.name && !med.medicineName) continue;
        const key = getMedKey(med);

        const existingIdx = mergedMeds.findIndex(m => {
          const exKey = getMedKey(m);
          if (exKey === key && key !== "__") return true;

          // Fuzzy match on core medicine name if strength matches or is absent
          const nameA = String(m.brandName || m.name || "").toLowerCase().replace(/[^a-z]/g, "");
          const nameB = String(med.brandName || med.name || "").toLowerCase().replace(/[^a-z]/g, "");
          if (nameA && nameB && (nameA === nameB || nameA.includes(nameB) || nameB.includes(nameA))) {
            const strA = String(m.strength || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            const strB = String(med.strength || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            return !strA || !strB || strA === strB;
          }
          return false;
        });

        if (existingIdx !== -1) {
          const existing = mergedMeds[existingIdx];
          // Merge fields, picking non-empty / richer data
          const mergedItem = {
            ...existing,
            brandName: existing.brandName || med.brandName,
            genericName: existing.genericName || med.genericName,
            strength: existing.strength || med.strength,
            dosage: existing.dosage || med.dosage,
            form: existing.form || med.form,
            foodInstruction: (existing.foodInstruction && existing.foodInstruction !== "Before meal") ? existing.foodInstruction : (med.foodInstruction || existing.foodInstruction),
            morning: Boolean(existing.morning || med.morning),
            afternoon: Boolean(existing.afternoon || med.afternoon),
            evening: Boolean(existing.evening || med.evening),
            night: Boolean(existing.night || med.night),
            durationDays: Math.max(existing.durationDays || 30, med.durationDays || 30),
            duration: existing.duration || med.duration,
            confidence: Math.max(existing.confidence || 0, med.confidence || 0),
            nameConfidence: Math.max(existing.nameConfidence || 0, med.nameConfidence || 0),
            sourceText: existing.sourceText || med.sourceText
          };

          const combinedTimes = Array.from(new Set([...(existing.times || []), ...(med.times || [])]));
          mergedItem.times = combinedTimes.length > 0 ? combinedTimes : ["08:00"];
          mergedMeds[existingIdx] = mergedItem;
        } else {
          mergedMeds.push(med);
        }
      }
    }
  }

  return {
    medicines: mergedMeds,
    patientName,
    doctorName,
    visitDate,
    disclaimer: "AI-assisted extraction — please verify all medicines, dosage, timing and duration against your prescription before saving.",
    extractedCount: mergedMeds.length
  };
}

async function parsePrescriptionWithAi(env: Env, base64: string, mimeType: string, textContent?: string) {
  let rawJson = "";

  // 1. Try Gemini Vision / Document understanding if API key is available
  if (env.GEMINI_API_KEY && base64) {
    // gemini-2.0-flash and gemini-1.5-* were shut down June 2026. Use current stable models.
    const models = [env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-2.5-flash-lite"];
    for (const model of models) {
      // Retry once on 503 (transient overload) before trying next model
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: PRESCRIPTION_PROMPT },
                  { inlineData: { mimeType: mimeType || "image/jpeg", data: base64 } }
                ]
              }],
              generationConfig: {
                temperature: 0.0
              }
            })
          });
          if (resp.ok) {
            const data = await resp.json<any>();
            const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (candidate && candidate.trim()) {
              rawJson = candidate.trim();
              console.log(`[Prescription] Gemini ${model} returned ${candidate.length} chars`);
              break;
            } else {
              const finishReason = data.candidates?.[0]?.finishReason || "unknown";
              console.warn(`[Prescription] Gemini ${model} empty candidate. finishReason=${finishReason}`);
              break; // empty candidate won't improve on retry — try next model
            }
          } else if (resp.status === 503 && attempt === 0) {
            console.warn(`[Prescription] Gemini ${model} 503 on attempt ${attempt+1}, retrying...`);
            await new Promise(r => setTimeout(r, 1000));
            continue; // retry once
          } else {
            const errBody = await resp.text().catch(() => "");
            console.warn(`[Prescription] Gemini ${model} HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
            break; // non-retryable error — try next model
          }
        } catch (err: any) {
          if (err?.name === "TimeoutError") {
            console.warn(`[Prescription] Gemini ${model} timed out after 25s`);
          } else {
            console.error(`[Prescription] Gemini model ${model} error:`, err);
          }
          break; // error — try next model
        }
      }
      if (rawJson) break; // got result — stop trying models
    }
  }

  // 2. Fallback to Groq Vision ONLY for images (Groq does not support application/pdf)
  const isImage = (mimeType || "").startsWith("image/");
  if (!rawJson && env.GROQ_API_KEY && base64 && isImage) {
    const visionModels = ["llama-3.2-90b-vision-preview", "llama-3.2-11b-vision-preview"];
    for (const vModel of visionModels) {
      try {
        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.GROQ_API_KEY}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: vModel,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: PRESCRIPTION_PROMPT },
                { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${base64}` } }
              ]
            }],
            temperature: 0.0,
            response_format: { type: "json_object" }
          })
        });
        if (resp.ok) {
          const data = await resp.json<any>();
          const content = data.choices?.[0]?.message?.content;
          if (content && content.trim()) {
            rawJson = content.trim();
            break;
          }
        }
      } catch (err) {
        console.error(`Groq vision model ${vModel} error:`, err);
      }
    }
  }

  // 3. Fallback to Groq Text if text was provided and no vision result
  if (!rawJson && env.GROQ_API_KEY && textContent) {
    try {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GROQ_API_KEY}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: env.GROQ_MODEL || "openai/gpt-oss-20b",
          messages: [
            { role: "system", content: PRESCRIPTION_PROMPT },
            { role: "user", content: `Prescription text:\n${textContent}` }
          ],
          temperature: 0.0,
          response_format: { type: "json_object" }
        })
      });
      if (resp.ok) {
        const data = await resp.json<any>();
        rawJson = data.choices?.[0]?.message?.content?.trim() || "";
      }
    } catch (err) {
      console.error("Groq text extraction error:", err);
    }
  }

  return normalizePrescriptionResult(rawJson);
}

async function parsePrescriptionBatchWithAi(
  env: Env,
  items: Array<{ base64: string; mimeType: string; textContent: string }>
) {
  if (items.length === 0) {
    return normalizePrescriptionResult("");
  }

  const validMedia = items.filter(i => i.base64 && i.base64.trim().length > 0);

  // Unified multi-file/multi-page single call first
  if (env.GEMINI_API_KEY && validMedia.length > 0) {
    // gemini-2.0-flash and gemini-1.5-* were shut down June 2026. Use current stable models.
    const models = [env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-2.5-flash-lite"];
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const parts: any[] = [
            {
              text: PRESCRIPTION_PROMPT + (validMedia.length > 1
                ? `\n\nMULTI-PAGE NOTE: The user has uploaded ${validMedia.length} files/pages belonging to ONE SINGLE prescription. Consolidate medications across all pages, preserve row-level schedule table assignments, deduplicate repeating items, and return one unified JSON result.`
                : "")
            }
          ];

          for (const item of validMedia) {
            parts.push({
              inlineData: {
                mimeType: item.mimeType || "image/jpeg",
                data: item.base64
              }
            });
          }

          const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: { temperature: 0.0 }
            })
          });

          if (resp.ok) {
            const data = await resp.json<any>();
            const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (candidate && candidate.trim()) {
              const unifiedResult = normalizePrescriptionResult(candidate.trim());
              console.log(`[Prescription] Batch Gemini ${model}: ${unifiedResult.medicines?.length ?? 0} medicines extracted`);
              if (unifiedResult.medicines && unifiedResult.medicines.length > 0) {
                return unifiedResult;
              }
            } else {
              const finishReason = data.candidates?.[0]?.finishReason || "unknown";
              console.warn(`[Prescription] Batch Gemini ${model} empty candidate finishReason=${finishReason}`);
            }
            break; // no point retrying an empty/zero result
          } else if (resp.status === 503 && attempt === 0) {
            console.warn(`[Prescription] Batch Gemini ${model} 503, retrying...`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          } else {
            const errBody = await resp.text().catch(() => "");
            console.warn(`[Prescription] Batch Gemini ${model} HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
            break;
          }
        } catch (err: any) {
          if (err?.name === "TimeoutError") {
            console.warn(`[Prescription] Batch Gemini ${model} timed out after 25s`);
          } else {
            console.error(`[Prescription] Batch Gemini ${model} error:`, err);
          }
          break;
        }
      }
    }
  }

  // Fallback: Parse each page/item individually and merge results
  const individualResults = await Promise.all(
    items.map(item => parsePrescriptionWithAi(env, item.base64, item.mimeType, item.textContent))
  );

  return mergeExtractedResults(individualResults);
}

// ── Unified AI Assistant Functions ──────────────────────────────────────

// Urgent symptom patterns for safety detection
const URGENT_PATTERNS = [
  /\b(chest pain|difficulty breathing|can't breathe|trouble breathing)\b/i,
  /\b(severe headache|worst headache|sudden headache)\b/i,
  /\b(facial drooping|face drooping|speech slurred|can't speak)\b/i,
  /\b(weakness|numbness|paralysis)\b.*\b(one side|left side|right side)\b/i,
  /\b(severe allergic reaction|anaphylaxis|throat swelling)\b/i,
  /\b(overdose|took too much|double dose)\b/i,
  /\b(high fever)\b.*\b(stiff neck|confusion|rash)\b/i
];

function containsUrgentSymptoms(message: string): boolean {
  return URGENT_PATTERNS.some(pattern => pattern.test(message));
}

function createUrgentWarningResponse(message: string, conversationId: string, conversationState: any): any {
  const warningMessage = "⚠️ **URGENT MEDICAL ATTENTION NEEDED**\n\n" +
    "Based on your symptoms, you should seek immediate medical care or contact emergency services.\n\n" +
    "🚨 **If this is a medical emergency:**\n" +
    "• Call your local emergency number (911, 112, etc.)\n" +
    "• Go to the nearest emergency room\n" +
    "• Contact your healthcare provider immediately\n\n" +
    "DoseBuddy cannot provide emergency medical assistance. Please seek professional help right away.";

  return {
    messageType: "URGENT_WARNING",
    intent: "EMERGENCY",
    conversationId,
    conversationState,
    message: warningMessage,
    requiresAction: true,
    actionType: "EMERGENCY_GUIDANCE"
  };
}

function detectIntent(message: string, userMedications: any[]): string {
  if (!message || typeof message !== 'string') {
    return "GENERAL";
  }
  
  const lowerMessage = message.toLowerCase().trim();
  const words = lowerMessage.split(/\s+/);
  
  // Handle single-word queries
  if (words.length === 1) {
    const word = words[0];
    
    // Check if it's a known medication name
    const medicineNames = ['zinc', 'aspirin', 'ibuprofen', 'acetaminophen', 'paracetamol', 'vitamins', 'iron', 'calcium'];
    if (medicineNames.includes(word) || userMedications.some(med => med.name?.toLowerCase().includes(word))) {
      return "MEDICINE_INFO";
    }
    
    // Check if it's a symptom
    const symptoms = ['headache', 'pain', 'nausea', 'fever', 'dizzy', 'tired', 'weak', 'sick'];
    if (symptoms.includes(word)) {
      return "SYMPTOM_CHECK";
    }
    
    // Greetings / filler / bare question words stay GENERAL.
    const nonMedicineWords = ['hi', 'hello', 'hey', 'thanks', 'thank', 'yes', 'no', 'ok', 'okay', 'help', 'please', 'what', 'why', 'how', 'who', 'when', 'where'];
    if (nonMedicineWords.includes(word)) {
      return "GENERAL";
    }

    // A single alphabetic token typed on its own is almost always a medicine/
    // supplement NAME the user wants to look up (e.g. "paniclips", "saridon").
    // Route it to MEDICINE_INFO instead of GENERAL; otherwise it dead-ended in the
    // general handler and the AI free-associated on the characters (reading
    // "paniclips" as panic/anxiety). processMedicineInfoIntent handles unknown
    // names gracefully (asks to confirm spelling, no fabrication).
    if (/^[a-z][a-z0-9'\-]*$/.test(word)) {
      return "MEDICINE_INFO";
    }

    // Anything else (punctuation, numerics) stays GENERAL for clarification.
    return "GENERAL";
  }
  
  // Enhanced medication-related query detection
  const medicineKeywords = ['medicine', 'medication', 'drug', 'pill', 'tablet', 'capsule', 'supplement', 'vitamin', 'zinc', 'aspirin', 'ibuprofen', 'acetaminophen', 'paracetamol'];
  const medicineActions = ['info', 'information', 'about', 'what', 'tell', 'explain', 'describe', 'learn'];
  
  const hasMedicineKeyword = medicineKeywords.some(keyword => lowerMessage.includes(keyword));
  const hasMedicineAction = medicineActions.some(action => lowerMessage.includes(action));
  
  // Strong, schedule-specific phrasing classifies as SCHEDULE on its own, even
  // without "take"/"taking" (e.g. "Show me today's medicine schedule"). These
  // triggers are scoped to schedule-specific wording so generic "time"/"when"
  // usage ("what time does ibuprofen peak") is NOT captured here.
  const schedulePhrases = [
    'my schedule', 'medicine schedule', 'medication schedule', 'dose schedule',
    "today's schedule", 'todays schedule', 'review my schedule', 'my medication list schedule'
  ];
  const hasSchedulePhrase = schedulePhrases.some(phrase => lowerMessage.includes(phrase));
  const hasScheduleWord = lowerMessage.includes('schedule');
  const hasShowVerb = ['show', 'see', 'view'].some(v => lowerMessage.includes(v));
  if (hasSchedulePhrase ||
      (hasScheduleWord && (hasShowVerb || lowerMessage.includes('today'))) ||
      lowerMessage.includes('when do i take') || lowerMessage.includes('when should i take')) {
    return "SCHEDULE";
  }
  
  if (hasMedicineKeyword && (hasMedicineAction || lowerMessage.includes('what is') || lowerMessage.includes('tell me'))) {
    return "MEDICINE_INFO";
  }
  
  // Check if message mentions any user medication by name
  if (userMedications.some(med => med.name && lowerMessage.includes(med.name.toLowerCase()))) {
    return "MEDICINE_INFO";
  }
  
  // Enhanced symptom detection - handle complex phrases like "headache body pains"
  const symptomKeywords = ['symptom', 'symptoms', 'pain', 'pains', 'ache', 'aches', 'hurt', 'sore', 'sick', 'nausea', 'dizzy', 'fever', 'headache', 'stomach', 'chest', 'back', 'joint', 'muscle', 'body'];
  const symptomIndicators = ['feel', 'feeling', 'have', 'having', 'experiencing', 'suffering', 'getting', 'been'];
  const temporalIndicators = ['for', 'since', 'from', 'days', 'hours', 'weeks', 'yesterday', 'today', 'ago'];
  
  const hasSymptom = symptomKeywords.some(keyword => lowerMessage.includes(keyword));
  const hasIndicator = symptomIndicators.some(indicator => lowerMessage.includes(indicator));
  const hasTemporal = temporalIndicators.some(temporal => lowerMessage.includes(temporal));
  
  // "headache body pains" or "I have headache" or "feeling pain for 4 days"
  if (hasSymptom && (hasIndicator || hasTemporal || words.length <= 4)) {
    return "SYMPTOM_CHECK";
  }
  
  // Check for side effect concerns
  if (lowerMessage.includes('side effect') || lowerMessage.includes('adverse') || lowerMessage.includes('reaction') ||
      (lowerMessage.includes('cause') && hasMedicineKeyword) ||
      (lowerMessage.includes('after taking') || lowerMessage.includes('from taking'))) {
    return "SIDE_EFFECT";
  }

  // Check for interaction queries
  if ((lowerMessage.includes('interact') || lowerMessage.includes('interaction') || 
       lowerMessage.includes('together') || lowerMessage.includes('combine') || 
       lowerMessage.includes('mix') || lowerMessage.includes('with')) && hasMedicineKeyword) {
    return "INTERACTION";
  }

  // Check for schedule/dosage questions
  if ((lowerMessage.includes('schedule') || lowerMessage.includes('when') || 
       lowerMessage.includes('time') || lowerMessage.includes('dose') || 
       lowerMessage.includes('dosage') || lowerMessage.includes('how often') ||
       lowerMessage.includes('missed') || lowerMessage.includes('miss')) && 
      (lowerMessage.includes('take') || lowerMessage.includes('taking'))) {
    return "SCHEDULE";
  }

  // Check for prescription questions
  if (lowerMessage.includes('prescription') || lowerMessage.includes('prescribed') || 
      lowerMessage.includes('doctor said') || lowerMessage.includes('instructions')) {
    return "PRESCRIPTION";
  }

  // Bare medicine-name query (reached for 2-word messages; single words are
  // handled in the single-word block above): a short alphabetic phrase with no
  // question/greeting/symptom signals is a MEDICINE_INFO lookup rather than a
  // GENERAL fallback. Example: "vitamin d", "saridon tablet". This prevents the
  // AI from free-associating on an unrecognized name.
  const trimmed = lowerMessage.trim();
  const nonMedicineWords = ['hi', 'hello', 'hey', 'thanks', 'thank', 'yes', 'no', 'ok', 'okay', 'help', 'please'];
  const isPlausibleMedicineName =
    words.length >= 1 && words.length <= 2 &&
    /^[a-z][a-z0-9'’\- ]*$/.test(trimmed) &&
    !nonMedicineWords.includes(trimmed) &&
    !hasSymptom && !hasIndicator && !hasTemporal;
  if (isPlausibleMedicineName) {
    return "MEDICINE_INFO";
  }

  return "GENERAL";
}

function extractMedicineName(message: string, userMedications: any[]): string | null {
  // First check if message contains any of user's current medications
  for (const med of userMedications) {
    const medName = med.name || "";
    if (medName && message.toLowerCase().includes(medName.toLowerCase())) {
      return medName;
    }
  }

  // Extract medicine name from natural language
  const patterns = [
    /\babout\s+([\w\s]+?)\s*[.?!]?$/i,
    /\bwhat\s+is\s+([\w\s]+?)\s*[.?!]?$/i,
    /\btell\s+me\s+about\s+([\w\s]+?)\s*[.?!]?$/i,
    /\binformation\s+on\s+([\w\s]+?)\s*[.?!]?$/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

function extractSymptom(message: string): string | null {
  if (!message || typeof message !== 'string') {
    return null;
  }
  
  const lowerMessage = message.toLowerCase();
  const symptomKeywords = [
    "headache", "head ache", "migraine", 
    "fever", "temperature", 
    "nausea", "nauseated", "queasy",
    "pain", "ache", "hurt", "hurting", "sore", 
    "dizzy", "dizziness", "lightheaded",
    "sick", "illness", "unwell",
    "stomach ache", "stomach pain", "abdominal pain",
    "chest pain", "back pain", "joint pain", "muscle pain",
    "body pain", "body aches", "fatigue", "tired", "weakness"
  ];
  
  // Check for compound symptoms like "headache body pains"
  const foundSymptoms = [];
  for (const symptom of symptomKeywords) {
    if (lowerMessage.includes(symptom)) {
      foundSymptoms.push(symptom);
    }
  }
  
  if (foundSymptoms.length > 0) {
    // Return the most specific or first found symptom
    // Prioritize longer/more specific matches
    return foundSymptoms.sort((a, b) => b.length - a.length)[0];
  }
  
  return null;
}

function extractDuration(message: string): { value: number; unit: string; text: string } | null {
  if (!message || typeof message !== 'string') {
    return null;
  }
  
  const lowerMessage = message.toLowerCase();
  
  // Patterns for duration extraction
  const patterns = [
    /(\d+)\s*(day|days)/i,
    /(\d+)\s*(hour|hours|hrs?)/i,
    /(\d+)\s*(week|weeks)/i,
    /(\d+)\s*(month|months)/i,
    /(for|since|from)\s+(\d+)\s*(day|days)/i,
    /(for|since|from)\s+(\d+)\s*(hour|hours|hrs?)/i,
    /(for|since|from)\s+(\d+)\s*(week|weeks)/i,
    /(for|since|from)\s+(\d+)\s*(month|months)/i,
    /past\s+(\d+)\s*(day|days)/i,
    /last\s+(\d+)\s*(day|days)/i
  ];
  
  for (const pattern of patterns) {
    const match = lowerMessage.match(pattern);
    if (match) {
      const value = parseInt(match[1] || match[2], 10);
      const unit = (match[2] || match[3]).toLowerCase();
      
      // Normalize units
      let normalizedUnit = 'days';
      if (unit.startsWith('hour')) normalizedUnit = 'hours';
      else if (unit.startsWith('week')) normalizedUnit = 'weeks';
      else if (unit.startsWith('month')) normalizedUnit = 'months';
      
      return {
        value,
        unit: normalizedUnit,
        text: match[0].trim()
      };
    }
  }
  
  return null;
}

function extractFactsFromMessage(message: string, userMedications: any[]): any {
  const facts: any = {};
  
  // Extract symptom
  const symptom = extractSymptom(message);
  if (symptom) {
    facts.symptom = symptom;
  }
  
  // Extract duration
  const duration = extractDuration(message);
  if (duration) {
    facts.duration = duration.text;
    facts.durationDays = convertToDays(duration.value, duration.unit);
    facts.durationParsed = duration;
  }
  
  // Extract medicine name
  const medicine = extractMedicineName(message, userMedications);
  if (medicine) {
    facts.medicine = medicine;
  }
  
  // Extract severity indicators
  const severityKeywords = ['mild', 'moderate', 'severe', 'intense', 'terrible', 'unbearable', 'slight', 'bad', 'worse'];
  const lowerMessage = message.toLowerCase();
  
  for (const severity of severityKeywords) {
    if (lowerMessage.includes(severity)) {
      facts.severity = severity;
      break;
    }
  }
  
  return facts;
}

function convertToDays(value: number, unit: string): number {
  switch (unit) {
    case 'hours': return Math.round(value / 24 * 10) / 10; // Round to 1 decimal
    case 'days': return value;
    case 'weeks': return value * 7;
    case 'months': return value * 30; // Approximate
    default: return value;
  }
}

function createOption(id: string, text: string, description: string = ""): any {
  const option: any = { 
    id, 
    text,
    value: text  // Frontend expects option.value - use text as the value
  };
  if (description) {
    option.description = description;
  }
  return option;
}

function getActivityType(intent: string): string {
  switch (intent) {
    case "MEDICINE_INFO": return "AI_MEDICINE_INFO";
    case "SYMPTOM_CHECK": return "SYMPTOM_CHECK";
    case "SIDE_EFFECT": return "AI_SIDE_EFFECT_CHECK";
    case "INTERACTION": return "AI_INTERACTION_CHECK";
    case "PRESCRIPTION": return "AI_PRESCRIPTION_HELP";
    case "SCHEDULE": return "AI_SCHEDULE_INQUIRY";
    default: return "AI_HEALTH_ASSISTANCE";
  }
}

async function processMedicineInfoIntent(env: Env, message: string, conversationId: string, conversationState: any, userMedications: any[]): Promise<any> {
  const response: any = {
    intent: "MEDICINE_INFO",
    conversationId
  };

  const medicineName = extractMedicineName(message, userMedications);
  
  // Check if the original message itself is a general medicine name
  const lowerMessage = message.toLowerCase().trim();
  const words = lowerMessage.split(/\s+/);
  const knownMedicines = ['zinc', 'aspirin', 'ibuprofen', 'acetaminophen', 'paracetamol', 'vitamins', 'iron', 'calcium', 'vitamin'];
  
  let finalMedicineName = medicineName;
  
  // If no medicine extracted but the message looks like a general medicine query
  if (!finalMedicineName) {
    // Check if it's a single word that's a known medicine/supplement
    if (words.length === 1 && knownMedicines.some(med => lowerMessage.includes(med))) {
      finalMedicineName = lowerMessage;
    }
    // Check for patterns like "vitamin D", "vitamin C" etc
    else if (words.length === 2 && words[0] === 'vitamin') {
      finalMedicineName = message.trim();
    }
    // Check for simple "what is X" patterns
    else if (words.length >= 3 && (lowerMessage.startsWith('what is ') || lowerMessage.startsWith('what are '))) {
      const potentialMedicine = words.slice(2).join(' ');
      finalMedicineName = potentialMedicine;
    }
    // Single bare word routed here by detectIntent is the medicine name itself.
    else if (words.length === 1 && /^[a-z][a-z0-9'\-]*$/.test(lowerMessage)) {
      finalMedicineName = message.trim();
    }
  }
  
  // Only show personal medication selection if:
  // 1. We couldn't identify any medicine name AND
  // 2. The user has medications AND  
  // 3. The query seems like it's asking about personal medications
  if (!finalMedicineName && userMedications.length > 0) {
    // Check if query is asking about personal medications
    const personalIndicators = ['my medicine', 'my medication', 'my pills', 'medicines i take', 'medications i take', 'medicines am i taking', 'medications am i taking', 'am i taking'];
    const isPersonalQuery = personalIndicators.some(indicator => lowerMessage.includes(indicator));
    
    if (isPersonalQuery) {
      // Ask user to select from their medications
      response.messageType = "QUESTION";
      response.message = "I can help you learn about medicines. Which medicine would you like to know about?";
      response.questionType = "MEDICINE_SELECTION";
      
      const questions = userMedications.map(med => ({
        id: med.id?.toString() || "unknown",
        text: `${med.name} (${med.dosage || "N/A"})`,
        value: med.name
      }));
      
      questions.push({
        id: "custom",
        text: "Other medicine not in my list",
        value: "custom"
      });
      
      response.questions = questions;
      response.conversationState = conversationState;
      return response;
    }
  }
  
  if (!finalMedicineName) {
    // Ask for medicine name - but be more specific about what we're asking
    response.messageType = "QUESTION";
    response.message = "What specific medicine, supplement, or health topic would you like to learn about?";
    response.questionType = "TEXT_INPUT";
    response.placeholder = "Enter medicine name...";
    response.conversationState = conversationState;
    return response;
  }
  
  // Provide medicine information using existing callAi function.
  // Treat the input strictly as the NAME of a medicine/supplement. Do not
  // reinterpret, split, or free-associate on the characters (e.g. do not read
  // an unknown name as unrelated words or symptoms). If the name is not a
  // recognized medicine, say so plainly instead of inventing an unrelated topic.
  const prompt =
    `The following is the NAME of a medicine or supplement the user asked about: "${finalMedicineName}".\n` +
    `Provide concise information about this medicine: what it is, common uses, common side effects, and safety guidance. ` +
    `Treat "${finalMedicineName}" strictly as a medicine/supplement name — do not split it into other words, ` +
    `do not interpret it as a symptom or emotion, and do not answer about an unrelated topic. ` +
    `If you do not recognize "${finalMedicineName}" as a known medicine or supplement, say clearly that you don't ` +
    `recognize it, ask the user to double-check the spelling or provide the brand/generic name, and do not fabricate details. ` +
    `Keep it concise and non-diagnostic, and remind the user to confirm with their pharmacist or healthcare provider.`;
  const aiResponse = await callAi(env, prompt);
  const medicineInfo = await aiResponse.text();
  
  response.messageType = "RESPONSE";
  response.message = medicineInfo;
  response.medicineName = finalMedicineName;
  conversationState.completed = true;
  response.conversationState = conversationState;
  
  return response;
}

// After severity is known, advance the symptom flow: ask about medication
// timing when the user has medications, otherwise produce the final analysis.
// Shared by the "severity" question handler and the first-interaction fast path
// (when symptom + duration + severity were all supplied in one message), so we
// never re-ask a question the user already answered.
async function advanceAfterSeverity(env: Env, response: any, conversationState: any, conversationId: string, userMedications: any[]): Promise<any> {
  if (userMedications.length > 0) {
    conversationState.currentQuestion = "medication-timing";

    response.messageType = "QUESTION";
    response.message = "Did this symptom start before or after you began taking any medicine?";
    response.questionType = "SINGLE_SELECT";

    response.questions = [
      createOption("before", "Before I started any medicine", ""),
      createOption("after-dose", "Soon after taking a dose", ""),
      createOption("hours-after", "Several hours after taking medicine", ""),
      createOption("independent", "It happens even when I don't take medicine", ""),
      createOption("not-sure", "I'm not sure about the timing", ""),
      createOption("custom", "Let me explain the timing", "")
    ];

    response.conversationState = conversationState;
    return response;
  }

  // No medications on file: proceed straight to the final analysis.
  conversationState.completed = true;
  return await generateSymptomAnalysis(env, conversationState, conversationId, userMedications);
}

async function processSymptomCheckIntent(env: Env, message: string, conversationId: string, conversationState: any, userMedications: any[]): Promise<any> {
  const response: any = {
    intent: "SYMPTOM_CHECK",
    conversationId
  };

  // Extract facts from the current message
  const facts = extractFactsFromMessage(message, userMedications);
  
  // Merge facts into conversation state, preserving existing information
  if (!conversationState.extractedFacts) {
    conversationState.extractedFacts = {};
  }
  
  // Update facts without overwriting existing ones unless explicitly contradicted
  Object.keys(facts).forEach(key => {
    conversationState.extractedFacts[key] = facts[key];
  });

  const currentQuestion = conversationState.currentQuestion;
  const extractedFacts = conversationState.extractedFacts;
  
  if (!currentQuestion) {
    // First interaction - extract what we can, then ask for missing info
    const symptom = extractedFacts.symptom || extractSymptom(message);
    const duration = extractedFacts.duration || extractedFacts.durationParsed;
    const severity = extractedFacts.severity;
    
    conversationState.reportedSymptom = symptom || message;

    // If the user already gave symptom + duration + severity in one message
    // (e.g. "I have mild stomach pain since 2 days"), do NOT re-ask what we
    // already know. Advance straight to medication-timing (or the final
    // analysis if they have no medications) so the flow isn't redundant.
    if (symptom && duration && severity) {
      conversationState.severity = severity;
      return advanceAfterSeverity(env, response, conversationState, conversationId, userMedications);
    }
    // If we have both symptom and duration, ask about severity
    else if (symptom && duration) {
      conversationState.currentQuestion = "severity";
      
      const durationText = extractedFacts.duration || `for ${extractedFacts.durationDays} days`;
      response.messageType = "QUESTION";
      response.message = `I understand you've been experiencing ${symptom} ${durationText}. How would you describe the severity?`;
      response.questionType = "SINGLE_SELECT";
      
      response.questions = [
        createOption("mild", "Mild", "Noticeable but manageable"),
        createOption("moderate", "Moderate", "Interfering with normal activities"),
        createOption("severe", "Severe", "Difficult to continue normal activities"),
        createOption("very-severe", "Very severe", "Extremely intense"),
        createOption("custom", "Describe it differently", "")
      ];
    }
    // If we have symptom but no duration, ask about duration
    else if (symptom && !duration) {
      conversationState.currentQuestion = "duration";
      
      response.messageType = "QUESTION";
      response.message = `I understand you're experiencing ${symptom}. How long have you been feeling this way?`;
      response.questionType = "SINGLE_SELECT";
      
      response.questions = [
        createOption("today", "Started today", ""),
        createOption("1-2-days", "1-2 days ago", ""),
        createOption("3-7-days", "3-7 days ago", ""),
        createOption("week-plus", "More than a week ago", ""),
        createOption("not-sure", "I'm not sure", ""),
        createOption("custom", "Other timeframe", "")
      ];
    }
    // If we don't have clear symptom info, ask for clarification
    else {
      conversationState.currentQuestion = "symptom-clarification";
      
      response.messageType = "QUESTION";
      response.message = "I want to help you with your symptoms. Could you describe what you're experiencing?";
      response.questionType = "TEXT_INPUT";
      response.placeholder = "Describe your symptoms...";
    }
    
    response.conversationState = conversationState;
    return response;
  }
  
  if (currentQuestion === "symptom-clarification") {
    // Re-extract facts from the clarification
    const newFacts = extractFactsFromMessage(message, userMedications);
    Object.keys(newFacts).forEach(key => {
      conversationState.extractedFacts[key] = newFacts[key];
    });
    
    conversationState.reportedSymptom = newFacts.symptom || message;
    
    if (newFacts.duration || newFacts.durationParsed) {
      // We now have duration, move to severity
      conversationState.currentQuestion = "severity";
      
      const symptom = newFacts.symptom || "these symptoms";
      const durationText = newFacts.duration || `for ${newFacts.durationDays} days`;
      
      response.messageType = "QUESTION";
      response.message = `I understand you've been experiencing ${symptom} ${durationText}. How would you describe the severity?`;
      response.questionType = "SINGLE_SELECT";
      
      response.questions = [
        createOption("mild", "Mild", "Noticeable but manageable"),
        createOption("moderate", "Moderate", "Interfering with normal activities"),
        createOption("severe", "Severe", "Difficult to continue normal activities"),
        createOption("very-severe", "Very severe", "Extremely intense"),
        createOption("custom", "Describe it differently", "")
      ];
    } else {
      // Still need duration info
      conversationState.currentQuestion = "duration";
      
      const symptom = newFacts.symptom || "these symptoms";
      response.messageType = "QUESTION";
      response.message = `Thank you for clarifying about ${symptom}. How long have you been experiencing this?`;
      response.questionType = "SINGLE_SELECT";
      
      response.questions = [
        createOption("today", "Started today", ""),
        createOption("1-2-days", "1-2 days ago", ""),
        createOption("3-7-days", "3-7 days ago", ""),
        createOption("week-plus", "More than a week ago", ""),
        createOption("not-sure", "I'm not sure", ""),
        createOption("custom", "Other timeframe", "")
      ];
    }
    
    response.conversationState = conversationState;
    return response;
  }
  
  if (currentQuestion === "severity") {
    conversationState.severity = message;
    conversationState.extractedFacts.severity = message;

    return advanceAfterSeverity(env, response, conversationState, conversationId, userMedications);
  }
  
  if (currentQuestion === "duration") {
    conversationState.duration = message;
    
    // Try to extract duration from the response
    const durationFacts = extractDuration(message);
    if (durationFacts) {
      conversationState.extractedFacts.duration = durationFacts.text;
      conversationState.extractedFacts.durationDays = convertToDays(durationFacts.value, durationFacts.unit);
      conversationState.extractedFacts.durationParsed = durationFacts;
    }
    
    // Move to severity question
    conversationState.currentQuestion = "severity";
    
    response.messageType = "QUESTION";
    response.message = "How would you describe the severity of your symptoms?";
    response.questionType = "SINGLE_SELECT";
    
    response.questions = [
      createOption("mild", "Mild", "Noticeable but manageable"),
      createOption("moderate", "Moderate", "Interfering with normal activities"),
      createOption("severe", "Severe", "Difficult to continue normal activities"),
      createOption("very-severe", "Very severe", "Extremely intense"),
      createOption("custom", "Describe it differently", "")
    ];
    
    response.conversationState = conversationState;
    return response;
  }
  
  if (currentQuestion === "medication-timing") {
    conversationState.medicationTiming = message;
    conversationState.completed = true;
    
    // Generate final symptom analysis
    return await generateSymptomAnalysis(env, conversationState, conversationId, userMedications);
  }
  
  // Fallback - should not reach here normally
  conversationState.completed = true;
  return await generateSymptomAnalysis(env, conversationState, conversationId, userMedications);
}

async function generateSymptomAnalysis(env: Env, conversationState: any, conversationId: string, userMedications: any[]): Promise<any> {
  const response: any = {
    intent: "SYMPTOM_CHECK",
    conversationId,
    messageType: "RESPONSE"
  };
  
  const reportedSymptom = conversationState.reportedSymptom || "";
  const severity = conversationState.severity || "";
  const duration = conversationState.duration || "";
  const medicationTiming = conversationState.medicationTiming || "";
  
  // Build context for AI analysis
  let contextBuilder = `Patient reports: ${reportedSymptom}\n`;
  if (severity) contextBuilder += `Severity: ${severity}\n`;
  if (duration) contextBuilder += `Duration: ${duration}\n`;
  if (medicationTiming) contextBuilder += `Timing relative to medications: ${medicationTiming}\n`;
  
  if (userMedications.length > 0) {
    contextBuilder += "Current medications: ";
    const medNames = userMedications.map(med => `${med.name} ${med.dosage || ""}`);
    contextBuilder += medNames.join(", ") + "\n";
  }
  
  const aiResponse = await callAi(env, `Give safe, non-diagnostic guidance for these symptoms: ${contextBuilder}`);
  const analysis = await aiResponse.text();
  
  response.message = analysis;
  conversationState.completed = true;
  response.conversationState = conversationState;
  
  return response;
}

async function processSideEffectIntent(env: Env, message: string, conversationId: string, conversationState: any, userMedications: any[]): Promise<any> {
  const response: any = {
    intent: "SIDE_EFFECT",
    conversationId
  };

  const currentQuestion = conversationState.currentQuestion;
  
  if (!currentQuestion && userMedications.length > 0) {
    conversationState.currentQuestion = "which-medicine";
    
    response.messageType = "QUESTION";
    response.message = "Which medicine do you think might be causing this?";
    response.questionType = "SINGLE_SELECT";
    
    const questions = userMedications.map(med => 
      createOption(med.id?.toString() || "unknown", `${med.name} (${med.dosage || "N/A"})`, "")
    );
    questions.push(createOption("not-sure", "I'm not sure which one", ""));
    questions.push(createOption("all", "It could be any of them", ""));
    
    response.questions = questions;
    response.conversationState = conversationState;
    return response;
  }
  
  // The user has indicated which medicine (or "not sure"/"any"). Produce a real
  // AI-backed, concise answer with safety framing instead of a static deflection.
  let sideEffectContext = `User's side-effect concern: ${message}\n`;
  if (userMedications.length > 0) {
    const medNames = userMedications.map(med => `${med.name} ${med.dosage || ""}`.trim());
    sideEffectContext += `Current medications: ${medNames.join(", ")}\n`;
  }
  const sideEffectPrompt =
    `A patient is concerned about a possible medication side effect. ${sideEffectContext}` +
    `Give a concise (2-4 sentences), non-diagnostic answer about whether this is a commonly reported side effect ` +
    `and what to watch for. Do not diagnose or prescribe. Advise consulting their pharmacist or healthcare provider, ` +
    `and to seek urgent medical care if symptoms are severe or worsening.`;
  const sideEffectResp = await callAi(env, sideEffectPrompt);
  const sideEffectAnalysis = await sideEffectResp.text();
  
  response.messageType = "RESPONSE";
  response.message = sideEffectAnalysis;
  conversationState.completed = true;
  response.conversationState = conversationState;
  
  return response;
}

async function processInteractionIntent(env: Env, message: string, conversationId: string, conversationState: any, userMedications: any[]): Promise<any> {
  const response: any = {
    intent: "INTERACTION",
    conversationId,
    messageType: "RESPONSE"
  };

  let interactionContext = `User's interaction question: ${message}\n`;
  if (userMedications.length > 0) {
    const medNames = userMedications.map(med => `${med.name} ${med.dosage || ""}`.trim());
    interactionContext += `Current medications: ${medNames.join(", ")}\n`;
  }
  const interactionPrompt =
    `A patient is asking about a possible medication interaction. ${interactionContext}` +
    `Give a concise (2-4 sentences), non-diagnostic answer about general interaction considerations. ` +
    `Do not diagnose or prescribe. Recommend confirming with their pharmacist or healthcare provider, ` +
    `who can check their full medication list against reliable interaction databases.`;
  const interactionResp = await callAi(env, interactionPrompt);
  const analysis = await interactionResp.text();
  
  response.message = analysis;
  conversationState.completed = true;
  response.conversationState = conversationState;
  
  return response;
}

async function processScheduleIntent(env: Env, message: string, conversationId: string, conversationState: any, userMedications: any[]): Promise<any> {
  const response: any = {
    intent: "SCHEDULE",
    conversationId,
    messageType: "RESPONSE"
  };

  if (userMedications.length === 0) {
    response.message = "You don't have any medicines scheduled in DoseBuddy yet. " +
      "You can add them using the 'Add Medicine' section to get personalized scheduling help.";
  } else {
    let scheduleInfo = "Here are your current medications in DoseBuddy:\n\n";
    
    for (const med of userMedications) {
      scheduleInfo += `• **${med.name}** (${med.dosage || "N/A"})\n`;
      if (med.times && Array.isArray(med.times)) {
        const timesList = med.times.map((t: any) => t.timeOfDay).filter(Boolean);
        if (timesList.length > 0) {
          scheduleInfo += `  Times: ${timesList.join(", ")}\n`;
        }
      }
      if (med.instructions) {
        scheduleInfo += `  Instructions: ${med.instructions}\n`;
      }
      scheduleInfo += "\n";
    }
    
    scheduleInfo += "For questions about missed doses or timing changes, please consult your healthcare provider.";
    response.message = scheduleInfo;
  }
  
  conversationState.completed = true;
  response.conversationState = conversationState;
  return response;
}

async function processPrescriptionIntent(env: Env, message: string, conversationId: string, conversationState: any): Promise<any> {
  const response: any = {
    intent: "PRESCRIPTION",
    conversationId,
    messageType: "RESPONSE"
  };

  const prescriptionPrompt =
    `A patient has a prescription-related question: ${message}\n` +
    `Give a concise (2-4 sentences), non-diagnostic answer. Do not diagnose or prescribe. ` +
    `Advise them to follow the instructions from their prescribing healthcare provider and pharmacist, ` +
    `and to contact them for clarification on dosage or administration.`;
  const prescriptionResp = await callAi(env, prescriptionPrompt);
  const analysis = await prescriptionResp.text();
  
  response.message = analysis;
  conversationState.completed = true;
  response.conversationState = conversationState;
  
  return response;
}

async function processGeneralHealthIntent(env: Env, message: string, conversationId: string, conversationState: any): Promise<any> {
  const response: any = {
    intent: "GENERAL",
    conversationId,
    messageType: "RESPONSE"
  };

  const generalPrompt =
    `You are DoseBuddy's health assistant. A user sent this message: ${message}\n` +
    `Give a concise (2-4 sentences), helpful, non-diagnostic answer. Do not diagnose or prescribe. ` +
    `If the question is outside medicine information, symptoms, or medication management, briefly guide them ` +
    `and recommend consulting a qualified healthcare professional for personal medical advice.`;
  const generalResp = await callAi(env, generalPrompt);
  const analysis = await generalResp.text();
  
  response.message = analysis;
  conversationState.completed = true;
  response.conversationState = conversationState;
  
  return response;
}

async function processUnifiedChat(env: Env, message: string, conversationId: string, conversationState: any, user: any, userMedications: any[], isOptionSelection: boolean = false): Promise<any> {
  // Initialize conversation state if not provided
  if (!conversationState || typeof conversationState !== "object") {
    conversationState = {};
  }
  
  // Safety check for urgent symptoms
  if (containsUrgentSymptoms(message)) {
    return createUrgentWarningResponse(message, conversationId, conversationState);
  }
  
  // Re-classify every fresh typed message so a stale currentIntent (from a
  // prior turn or quick-action) never routes a new message to the wrong
  // handler. We only keep the stored intent when the user is answering a
  // question that is already in flight (an option selection, or a same-intent
  // follow-up such as "Since yesterday" while a symptom question is open).
  const previousIntent = conversationState.currentIntent;
  const detected = detectIntent(message, userMedications);
  // A follow-up continues the question in flight when it is an option
  // selection, when it classifies as the same intent, or when it carries no
  // recognizable new intent on its own (e.g. "Since yesterday" -> GENERAL).
  // A bare GENERAL message must not hijack an active flow; only a concrete new
  // intent (a symptom report, a medicine query, etc.) breaks out of it.
  const midFlowContinuation = Boolean(conversationState.currentQuestion) &&
    (isOptionSelection || detected === previousIntent || detected === "GENERAL");

  let currentIntent: string;
  if (midFlowContinuation) {
    // Keep answering the question already in progress.
    currentIntent = previousIntent;
  } else {
    currentIntent = detected;
    // This is a fresh, re-classified message (not a mid-flow continuation), so
    // reset the per-flow transient state before dispatching. This guarantees a
    // brand-new message after a "completed" turn (SIDE_EFFECT, SCHEDULE,
    // INTERACTION, etc.) is handled fresh and never dead-ends on the same canned
    // reply. We clear the in-flight question and completion flag for every intent
    // switch; symptom-specific context is additionally cleared when the new intent
    // is NOT SYMPTOM_CHECK so symptom follow-ups ("Since yesterday") still work.
    delete conversationState.currentQuestion;
    delete conversationState.completed;
    if (currentIntent !== "SYMPTOM_CHECK") {
      delete conversationState.reportedSymptom;
      delete conversationState.severity;
      delete conversationState.duration;
      delete conversationState.medicationTiming;
      delete conversationState.extractedFacts;
    }
    conversationState.currentIntent = currentIntent;
  }
  
  // Process based on intent
  switch (currentIntent) {
    case "MEDICINE_INFO":
      return await processMedicineInfoIntent(env, message, conversationId, conversationState, userMedications);
      
    case "SYMPTOM_CHECK":
      return await processSymptomCheckIntent(env, message, conversationId, conversationState, userMedications);
      
    case "SIDE_EFFECT":
      return await processSideEffectIntent(env, message, conversationId, conversationState, userMedications);
      
    case "INTERACTION":
      return await processInteractionIntent(env, message, conversationId, conversationState, userMedications);
      
    case "SCHEDULE":
      return await processScheduleIntent(env, message, conversationId, conversationState, userMedications);
      
    case "PRESCRIPTION":
      return await processPrescriptionIntent(env, message, conversationId, conversationState);
      
    default:
      return await processGeneralHealthIntent(env, message, conversationId, conversationState);
  }
}

async function callAi(env: Env, prompt: string): Promise<Response> {
  // Input validation
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    console.error('Invalid prompt provided to callAi:', prompt);
    return plain("Please provide a valid question or message.");
  }

  const trimmedPrompt = prompt.trim();
  
  // Check if API keys are configured
  const hasGemini = Boolean(env.GEMINI_API_KEY);
  const hasGroq = Boolean(env.GROQ_API_KEY);
  
  if (!hasGemini && !hasGroq) {
    console.error('No AI provider API keys configured');
    return plain("AI health assistant is temporarily unavailable due to configuration issues. Please consult your physician or pharmacist.");
  }

  // 1. Try Gemini models if GEMINI_API_KEY is configured
  if (hasGemini) {
    const models = [
      env.GEMINI_MODEL || "gemini-2.5-flash",
      "gemini-2.5-flash-lite"
    ];
    
    for (const model of models) {
      try {
        console.log(`Attempting Gemini request with model: ${model}`);
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: trimmedPrompt }] }],
              generationConfig: { temperature: 0.2 }
            })
          }
        );
        
        if (resp.ok) {
          const data = await resp.json<any>();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text && text.trim()) {
            console.log(`Gemini ${model} success`);
            return plain(text.trim());
          } else {
            console.warn(`Gemini ${model} returned empty response:`, data);
          }
        } else {
          const errorText = await resp.text();
          console.error(`Gemini ${model} HTTP ${resp.status}: ${errorText}`);
        }
      } catch (err) {
        console.error(`Gemini model ${model} error:`, err);
      }
    }
  }

  // 2. Try Groq models if GROQ_API_KEY is configured
  if (hasGroq) {
    const models = [
      env.GROQ_MODEL || "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-20b"
    ];
    
    for (const model of models) {
      try {
        console.log(`Attempting Groq request with model: ${model}`);
        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.GROQ_API_KEY}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: trimmedPrompt }],
            temperature: 0.2
          })
        });
        
        if (resp.ok) {
          const data = await resp.json<any>();
          const text = data.choices?.[0]?.message?.content;
          if (text && text.trim()) {
            console.log(`Groq ${model} success`);
            return plain(text.trim());
          } else {
            console.warn(`Groq ${model} returned empty response:`, data);
          }
        } else {
          const errorText = await resp.text();
          console.error(`Groq ${model} HTTP ${resp.status}: ${errorText}`);
        }
      } catch (err) {
        console.error(`Groq model ${model} error:`, err);
      }
    }
  }

  // 3. Intelligent fallback responses based on prompt content
  console.warn('All AI providers failed, using intelligent fallback');
  
  // Handle special JSON array requests for health insights
  if (prompt.includes("health insights") || prompt.includes("Patient data") || prompt.includes("JSON array")) {
    const fallbackArray = [
      { title: "Medication Adherence", message: "Keep taking your scheduled doses consistently for optimal health outcomes.", type: "info", icon: "💊" },
      { title: "Stay Consistent", message: "Maintaining a daily routine helps establish strong adherence habits.", type: "success", icon: "⭐" },
      { title: "Health Tracking", message: "Regularly logging your vitals and BMI provides valuable long-term health trends.", type: "info", icon: "📊" },
      { title: "Consult Healthcare Provider", message: "Always discuss medication adjustments with your physician or pharmacist.", type: "warning", icon: "🩺" }
    ];
    return plain(JSON.stringify(fallbackArray));
  }
  
  // Context-aware fallback for different types of queries
  const lowerPrompt = trimmedPrompt.toLowerCase();
  
  if (lowerPrompt.includes('symptom') || lowerPrompt.includes('pain') || lowerPrompt.includes('headache') || lowerPrompt.includes('feeling')) {
    return plain(`I understand you're asking about symptoms, but our AI assistant is temporarily unavailable. For health concerns, please consider consulting your healthcare provider, especially if symptoms persist or worsen.`);
  }
  
  if (lowerPrompt.includes('medicine') || lowerPrompt.includes('medication') || lowerPrompt.includes('drug') || lowerPrompt.includes('zinc')) {
    return plain(`I'd like to help with your medication question, but our AI assistant is temporarily unavailable. Please consult your pharmacist or healthcare provider for accurate medication information and guidance.`);
  }
  
  if (lowerPrompt.includes('side effect') || lowerPrompt.includes('interaction')) {
    return plain(`For questions about medication side effects or interactions, please speak with your pharmacist or healthcare provider immediately, as our AI assistant is temporarily unavailable.`);
  }
  
  // Default fallback
  return plain(`I received your message about "${trimmedPrompt.substring(0, 50)}${trimmedPrompt.length > 50 ? '...' : ''}", but our AI health assistant is temporarily unavailable. Please consult your physician or pharmacist for health-related guidance.`);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Log request start for key endpoints
    if (path.includes('/medications/add') || path.includes('/logs/mark')) {
      console.log(`[Worker] ${request.method} ${path} - Request started`);
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (path === "/" && request.method === "GET") return json({ message: "DoseBuddy API is running" });
      if (path === "/api/health" && request.method === "GET") return json({ status: "UP", service: "DoseBuddy API" });

      // ── Authentication ──────────────────────────────────────────────────
      if (path === "/api/auth/signup" && request.method === "POST") {
        const { body: b, error: parseError } = await requestBody(request);
        if (parseError) return json({ message: "Invalid JSON in request body" }, 400);

        const email = String(b.email ?? "").trim().toLowerCase(),
          password = String(b.password ?? ""),
          name = String(b.name ?? "").trim(),
          role = String(b.role || "PATIENT").toUpperCase(),
          patientEmail = role === "CAREGIVER" ? String(b.patientEmail ?? "").trim().toLowerCase() : null,
          acceptedTerms = b.acceptedTerms !== undefined ? Boolean(b.acceptedTerms) : true,
          // Default a non-null time zone so no user is left NULL; honor the signup body's zone if valid.
          signupZone = canonicalTimeZone(b.timeZone) ?? "UTC";

        if (!email || !password || !name) return json({ message: "Name, email and password are required" }, 400);
        if (b.acceptedTerms === false) return json({ message: "You must accept the Terms & Conditions to create an account" }, 400);
        if (password.length < 8) return json({ message: "Password must be at least 8 characters" }, 400);
        if (role === "CAREGIVER" && !patientEmail) return json({ message: "Patient email is required for caregivers" }, 400);

        const passwordHash = await bcrypt.hash(password, 10);
        let db: any = null;
        let phase = "connect";

        try {
          db = await getDbConnection(env);

          phase = "check_existing_email";
          const [existing] = await query<User[]>(db, "SELECT id FROM users WHERE email=? LIMIT 1", [email]);
          if (existing.length) return json({ message: "Email already in use" }, 409);

          phase = "insert_user";
          const [result] = await query<{ insertId: number }>(
            db,
            "INSERT INTO users (name,email,password_hash,role,patient_email,phone,dob,gender,emergency_contact,accepted_terms,time_zone,accepted_terms_timestamp,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),NOW())",
            [name, email, passwordHash, role, patientEmail, b.phone || null, b.dob || null, b.gender || null, b.emergencyContact || null, acceptedTerms, signupZone]
          );

          phase = "fetch_created_user";
          const [users] = await query<User[]>(db, "SELECT * FROM users WHERE id=? LIMIT 1", [result.insertId]);
          if (!users[0]) throw new Error("Created user record not found");

          return json(await loginBody(env, users[0]));
        } catch (error) {
          logSignupFailure(phase, error);
          throw error;
        } finally {
          if (db) {
            try {
              await db.end();
            } catch (closeErr) {
              console.error("Failed to close DB connection:", closeErr);
            }
          }
        }
      }

      if (path === "/api/auth/login" && request.method === "POST") {
        const { body: b, error: parseError } = await requestBody(request);
        if (parseError) return json({ message: "Invalid JSON in request body" }, 400);

        const email = String(b.email ?? "").trim().toLowerCase(),
          password = String(b.password ?? "");
        if (!email || !password) return json({ message: "Email and password are required" }, 400);
        let db: any = null;
        try {
          db = await getDbConnection(env);
          const [rows] = await query<User[]>(db, "SELECT * FROM users WHERE email=? LIMIT 1", [email]);
        const user = rows[0];
        if (!user) return json({ message: "Invalid email or password" }, 401);
        const match = user.password_hash.startsWith("$2")
          ? await bcrypt.compare(password, user.password_hash)
          : password === user.password_hash;
        if (!match) return json({ message: "Invalid email or password" }, 401);
          if (!user.password_hash.startsWith("$2")) {
            user.password_hash = await bcrypt.hash(password, 10);
            await query(db, "UPDATE users SET password_hash=?,updated_at=NOW() WHERE id=?", [user.password_hash, user.id]);
          }
          return json(await loginBody(env, user));
        } finally {
          if (db) {
            try {
              await db.end();
            } catch (closeErr) {
              console.error("Failed to close DB connection:", closeErr);
            }
          }
        }
      }

      if (path === "/api/auth/refresh" && request.method === "POST") {
        const { body: b, error: parseError } = await requestBody(request);
        if (parseError) return json({ message: "Invalid JSON in request body" }, 400);

        const c = await claims(env, String(b.refreshToken ?? ""));
        if (!c || c.type !== "refresh" || typeof c.userId !== "number") return json({ message: "Invalid or expired refresh token" }, 401);
        const user = await getUser(env, c.userId);
        return user ? json(await loginBody(env, user)) : json({ message: "User not found" }, 401);
      }

      // ── Protected Route Guard ───────────────────────────────────────────
      const actor = await userFor(request, env);
      if (!actor) return json({ message: "Unauthorized" }, 401);

      // ── Debug / AI ──────────────────────────────────────────────────────
      if (path === "/api/debug/db" && request.method === "GET") {
        const [probe] = await query<Json[]>(env, "SELECT 1 AS connected");
        return probe[0]?.connected === 1 ? json({ database: "connected" }) : json({ message: "Database connection check failed" }, 503);
      }

      if (path === "/api/medicine/ai-info" && request.method === "GET") {
        const nameParam = url.searchParams.get("name") || "";
        const userIdParam = url.searchParams.get("userId");
        if (userIdParam && !nameParam.includes("insights") && !nameParam.includes("You are")) {
          try {
            await query(env, "INSERT INTO activities (user_id,type,message,created_at) VALUES (?,'AI_MEDICINE_INFO',?,NOW())", [
              Number(userIdParam),
              `Searched medicine information: ${nameParam.slice(0, 100)}`
            ]);
          } catch {
            // Non-fatal
          }
        }
        const prompt = nameParam.length > 50 || nameParam.includes("insights") || nameParam.includes("You are")
          ? nameParam
          : `Provide concise medication information, uses, common side effects, and safety guidance for: ${nameParam}`;
        return await callAi(env, prompt);
      }

      if (path === "/api/medicine/symptom-check" && request.method === "POST") {
        const { body: b } = await requestBody(request);
        const symptoms = String(b.symptoms ?? "");
        const userId = b.userId;
        if (userId) {
          try {
            await query(env, "INSERT INTO activities (user_id,type,message,created_at) VALUES (?,'SYMPTOM_CHECK',?,NOW())", [
              Number(userId),
              `Performed symptom check: ${symptoms.slice(0, 50)}...`
            ]);
          } catch {
            // Non-fatal
          }
        }
        return await callAi(env, `Give safe, non-diagnostic guidance for these symptoms: ${symptoms}`);
      }

      if (path === "/api/ai/chat" && request.method === "POST") {
        const { body: b } = await requestBody(request);
        const message = String(b.message ?? "").trim();
        const conversationId = String(b.conversationId ?? "");
        const conversationState = b.conversationState || {};
        const isOptionSelection = b.isOptionSelection === true;
        
        if (!message) {
          return json({ success: false, error: "Message is required" }, 400);
        }

        try {
          // Get user's current medications for context
          const today = new Date().toISOString().split("T")[0];
          const [userMedications] = await query<Json[]>(
            env,
            "SELECT m.*,JSON_ARRAYAGG(JSON_OBJECT('id',mt.id,'timeOfDay',TIME_FORMAT(mt.time_of_day,'%H:%i:%s'))) times FROM medications m LEFT JOIN medication_times mt ON mt.medication_id=m.id WHERE m.user_id=? AND m.start_date<=? AND m.end_date>=? GROUP BY m.id",
            [actor.id, today, today]
          );

          const chatResponse = await processUnifiedChat(env, message, conversationId, conversationState, actor, userMedications, isOptionSelection);
          
          // Log activity based on intent
          const intent = chatResponse.intent || "GENERAL";
          const activityType = getActivityType(intent);
          try {
            await query(env, "INSERT INTO activities (user_id,type,message,created_at) VALUES (?,?,?,NOW())", [
              actor.id,
              activityType,
              `AI Chat: ${message.length > 100 ? message.substring(0, 100) + "..." : message}`
            ]);
          } catch {
            // Activity logging failure is non-fatal
          }
          
          return json({ success: true, ...chatResponse });
        } catch (error: any) {
          console.error("[AI Chat] Processing error:", error);
          return json({ success: false, error: "AI service temporarily unavailable. Please try again later." });
        }
      }

      if ((path === "/api/prescription/upload" || path === "/api/prescriptions/upload" || path === "/api/prescription/upload/") && request.method === "POST") {
        const itemsToProcess: Array<{ base64: string; mimeType: string; textContent: string }> = [];

        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          const files: File[] = [];

          const filesList = formData.getAll("files");
          if (filesList && filesList.length > 0) {
            for (const f of filesList) {
              if (f && typeof f !== "string") files.push(f as File);
            }
          }
          const singleFile = formData.get("file");
          if (singleFile && typeof singleFile !== "string" && !files.includes(singleFile as File)) {
            files.push(singleFile as File);
          }

          if (files.length === 0) {
            return json({ message: "No file uploaded" }, 400);
          }

          for (const fileObj of files) {
            const mimeType = fileObj.type || "image/jpeg";
            const buffer = await fileObj.arrayBuffer();
            if (mimeType.startsWith("text/")) {
              const textContent = new TextDecoder().decode(buffer);
              itemsToProcess.push({ base64: "", mimeType, textContent });
            } else {
              const base64 = bufferToBase64(buffer);
              itemsToProcess.push({ base64, mimeType, textContent: "" });
            }
          }
        } else if (contentType.includes("application/json")) {
          const { body: b } = await requestBody(request);
          if (Array.isArray(b.images) && b.images.length > 0) {
            for (const img of b.images) {
              let b64 = String(img.base64 || img.image || "");
              let mime = String(img.mimeType || "image/jpeg");
              if (b64.includes(",")) {
                const parts = b64.split(",");
                const match = parts[0].match(/:(.*?);/);
                if (match) mime = match[1];
                b64 = parts[1];
              }
              const txt = String(img.text || "");
              if (b64 || txt) {
                itemsToProcess.push({ base64: b64, mimeType: mime, textContent: txt });
              }
            }
          } else {
            let b64 = String(b.image || b.base64 || "");
            let mime = String(b.mimeType || "image/jpeg");
            if (b64.includes(",")) {
              const parts = b64.split(",");
              const match = parts[0].match(/:(.*?);/);
              if (match) mime = match[1];
              b64 = parts[1];
            }
            const txt = String(b.text || "");
            if (b64 || txt) {
              itemsToProcess.push({ base64: b64, mimeType: mime, textContent: txt });
            }
          }
        } else {
          return json({ message: "Unsupported content type" }, 400);
        }

        if (itemsToProcess.length === 0) {
          return json({ message: "No image or text data provided for extraction" }, 400);
        }

        console.log(`[Prescription] Processing ${itemsToProcess.length} item(s): ${itemsToProcess.map(i => `${i.mimeType}/${i.base64 ? Math.round(i.base64.length * 0.75 / 1024) + "KB" : "text:" + i.textContent.length + "ch"}`).join(", ")}`);

        const mergedResult = await parsePrescriptionBatchWithAi(env, itemsToProcess);
        return json(mergedResult);
      }

      // ── Medications ─────────────────────────────────────────────────────
      if (path === "/api/medications/add" && request.method === "POST") {
        const { body, error: bodyError } = await requestBody(request);
        if (bodyError) return json({ message: bodyError }, 400);
        const parsed = medicationCreatePayload(body);
        if (parsed.error) return json({ message: parsed.error }, 400);
        const b = parsed.value!;
        let db: any = null;
        try {
          db = await getDbConnection(env);
          await db.beginTransaction();
          let r: { insertId: number };
          let legacySchema = false;
          try {
            [r] = await query<{ insertId: number }>(
              db,
              "INSERT INTO medications (user_id,name,dosage,instructions,start_date,end_date,active,schedule_version) VALUES (?,?,?,?,?,?,1,1)",
              [actor.id, b.name, b.dosage, b.instructions, b.startDate, b.endDate]
            );
          } catch (error) {
            if (!medicationSchemaNotReady(error)) throw error;
            await db.rollback();
            await db.beginTransaction();
            legacySchema = true;
            [r] = await query<{ insertId: number }>(
              db,
              "INSERT INTO medications (user_id,name,dosage,instructions,start_date,end_date) VALUES (?,?,?,?,?,?)",
              [actor.id, b.name, b.dosage, b.instructions, b.startDate, b.endDate]
            );
          }

          for (const time of b.times) {
            await query(db, "INSERT INTO medication_times (medication_id,time_of_day) VALUES (?,?)", [r.insertId, time]);
          }

          await query(
            db,
            "INSERT INTO activities (user_id,type,message,related_entity_type,related_entity_id,created_at) VALUES (?,?,?,?,?,NOW())",
            [actor.id, "MEDICINE_ADDED", `Added new medication: ${b.name} (${b.dosage})`, "MEDICATION", r.insertId]
          );
          await db.commit();

          console.log(`[Medication Add] Medication ${b.name} added successfully${legacySchema ? " (legacy schema; notification scheduling unavailable)" : " (server-side notifications enabled)"}`);
          return plain("Medication added");
        } catch (error) {
          if (db) await db.rollback();
          if (medicationSchemaNotReady(error)) {
            console.error("[Medication Add] Medication schema is missing notification-era columns");
            return json({ message: "Medication schema is not ready. Please contact support." }, 503);
          }
          throw error;
        } finally {
          if (db) {
            try {
              await db.end();
            } catch (closeErr) {
              console.error("Failed to close DB connection:", closeErr);
            }
          }
        }
      }

      const medsId = path.match(/^\/api\/medications\/today\/(\d+)$/),
        medsEmail = path.match(/^\/api\/medications\/today-by-email\/(.+)$/);
      if ((medsId || medsEmail) && request.method === "GET") {
        const target = medsId
          ? await getUser(env, Number(medsId[1]))
          : (await query<User[]>(env, "SELECT * FROM users WHERE email=? LIMIT 1", [decodeURIComponent(medsEmail![1]).toLowerCase()]))[0][0];
        if (!target) return plain(medsId ? "User not found" : "Patient not found", 400);
        if (!accessible(actor, target)) return plain("Access denied", 403);
        const reqDate = url.searchParams.get("date");
        if (reqDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) return json({ message: "date must be in YYYY-MM-DD format" }, 400);
        const targetZone = canonicalTimeZone(target.time_zone);
        // Honor the client-provided ?date=; only derive from the stored zone when no date is sent.
        // A missing/invalid time zone must NOT hide the medication list (it stays available for scheduling).
        const medsDateStr = reqDate ?? (targetZone ? zonedParts(Date.now(), targetZone).date : new Date().toISOString().slice(0, 10));
        const [rows] = await query<Json[]>(
          env,
          "SELECT m.*,JSON_ARRAYAGG(JSON_OBJECT('id',mt.id,'timeOfDay',TIME_FORMAT(mt.time_of_day,'%H:%i:%s'))) times FROM medications m LEFT JOIN medication_times mt ON mt.medication_id=m.id WHERE m.user_id=? AND m.active=1 AND m.start_date<=? AND m.end_date>=? GROUP BY m.id",
          [target.id, medsDateStr, medsDateStr]
        );
        return json(
          rows.map(x => ({
            ...x,
            startDate: x.start_date,
            endDate: x.end_date,
            times: typeof x.times === "string" ? JSON.parse(x.times) : x.times
          }))
        );
      }

      const del = path.match(/^\/api\/medications\/(\d+)$/);
      if (del && request.method === "PUT") {
        const { body: b } = await requestBody(request);
        let db: any = null;
        try {
          db = await getDbConnection(env);
          await db.beginTransaction();
          const [rows] = await query<Json[]>(db, "SELECT * FROM medications WHERE id=? FOR UPDATE", [del[1]]);
          const medication = rows[0];
          if (!medication) { await db.rollback(); return new Response(null, { status: 404, headers: cors }); }
          if (Number(medication.user_id) !== actor.id) { await db.rollback(); return plain("Access denied", 403); }
          const times = Array.isArray(b.times) ? b.times : null;
          await query(db,
            "UPDATE medications SET name=?,dosage=?,instructions=?,start_date=?,end_date=?,active=?,schedule_version=schedule_version+1 WHERE id=?",
            [b.name ?? medication.name, b.dosage ?? medication.dosage, b.instructions ?? medication.instructions,
             b.startDate ?? mysqlDate(medication.start_date), b.endDate ?? mysqlDate(medication.end_date),
             b.active === false ? 0 : Number(medication.active ?? 1), del[1]]);
          if (times) {
            await query(db, "DELETE FROM medication_times WHERE medication_id=?", [del[1]]);
            for (const time of times) await query(db, "INSERT INTO medication_times (medication_id,time_of_day) VALUES (?,?)", [del[1], time]);
          }
          await query(db, "UPDATE push_delivery_attempts SET outcome='OBSOLETE',next_attempt_at=NULL WHERE medication_id=? AND outcome IN ('CLAIMED','RETRY')", [del[1]]);
          await db.commit();
          return plain("Medication updated");
        } catch (error) {
          if (db) await db.rollback();
          throw error;
        } finally {
          if (db) await db.end();
        }
      }

      if (del && request.method === "DELETE") {
        let db: any = null;
        try {
          db = await getDbConnection(env);
          await db.beginTransaction();
          const [rows] = await query<Json[]>(db, "SELECT * FROM medications WHERE id=? FOR UPDATE", [del[1]]);
          if (!rows[0]) { await db.rollback(); return new Response(null, { status: 404, headers: cors }); }
          if (Number(rows[0].user_id) !== actor.id) { await db.rollback(); return plain("Access denied", 403); }
          await query(db, "UPDATE push_delivery_attempts SET outcome='OBSOLETE',next_attempt_at=NULL WHERE medication_id=? AND outcome IN ('CLAIMED','RETRY')", [del[1]]);
          await query(db, "DELETE FROM intake_logs WHERE medication_id=?", [del[1]]);
          await query(db, "DELETE FROM medication_times WHERE medication_id=?", [del[1]]);
          await query(db, "DELETE FROM medications WHERE id=?", [del[1]]);
          await db.commit();
          return new Response(null, { status: 204, headers: cors });
        } catch (error) {
          if (db) await db.rollback();
          throw error;
        } finally {
          if (db) {
            try {
              await db.end();
            } catch (closeErr) {
              console.error("Failed to close DB connection:", closeErr);
            }
          }
        }
      }

      // ── Intake Logs ─────────────────────────────────────────────────────
      const logsToday = path.match(/^\/api\/logs\/today\/(\d+)$/);
      if (logsToday && request.method === "GET") {
        const target = await getUser(env, Number(logsToday[1]));
        if (!target) return json({ message: "User not found" }, 400);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const targetZone = canonicalTimeZone(target.time_zone);
        if (!targetZone) return json([]);
        const currentLocal = zonedParts(Date.now(), targetZone);
        const todayStr = currentLocal.date;

        const [meds] = await query<Json[]>(
          env,
          "SELECT m.id AS med_id, m.name AS med_name, m.dosage, mt.time_of_day FROM medications m JOIN medication_times mt ON mt.medication_id=m.id WHERE m.user_id=? AND m.active=1 AND m.start_date<=? AND m.end_date>=?",
          [target.id, todayStr, todayStr]
        );
        const [logs] = await query<Json[]>(
          env,
          "SELECT id, medication_id, DATE_FORMAT(date,'%Y-%m-%d') AS date, TIME_FORMAT(time,'%H:%i') AS time, status FROM intake_logs WHERE marker_user_id=? AND date=?",
          [target.id, todayStr]
        );

        const logMap = new Map<string, Json>();
        for (const l of logs) {
          logMap.set(`${l.medication_id}_${l.time}`, l);
        }

        const currentHours = currentLocal.hour;
        const currentMins = currentLocal.minute;

        const doses = meds.map(m => {
          const rawTime = String(m.time_of_day || "00:00:00").substring(0, 5);
          const [hStr, mStr] = rawTime.split(":");
          const doseHours = parseInt(hStr, 10);
          const doseMins = parseInt(mStr, 10);
          const isPast = doseHours < currentHours || (doseHours === currentHours && doseMins <= currentMins);

          const foundLog = logMap.get(`${m.med_id}_${rawTime}`);
          let status = "PENDING";
          let logId = null;

          if (foundLog) {
            status = String(foundLog.status).toUpperCase();
            logId = foundLog.id;
          } else if (isPast) {
            status = "PENDING";
          }

          return {
            id: logId,
            date: todayStr,
            time: rawTime,
            medicationId: m.med_id,
            medicationName: m.med_name,
            dosage: m.dosage,
            status
          };
        });

        doses.sort((a, b) => a.time.localeCompare(b.time));
        return json(doses);
      }

      if (path === "/api/logs/mark" && request.method === "POST") {
        const { body: b } = await requestBody(request);
        if (!b.medicationId || !b.date || !b.time) return json({ message: "Missing required fields" }, 400);
        const status = String(b.status || "TAKEN").toUpperCase();
        if (status !== "TAKEN" && status !== "MISSED") return json({ message: "Invalid dose status" }, 400);
        let db: any = null;
        try {
          db = await getDbConnection(env);
          const result = await transact(db, async () => {
            const localTime = String(b.time).substring(0, 5);
            const [medRows] = await query<Json[]>(db,
              "SELECT m.* FROM medications m JOIN medication_times mt ON mt.medication_id=m.id WHERE m.id=? AND m.active=1 AND ? BETWEEN m.start_date AND m.end_date AND TIME_FORMAT(mt.time_of_day,'%H:%i')=? LIMIT 1 FOR UPDATE",
              [b.medicationId, b.date, localTime]);
            const med = medRows[0];
            if (!med) throw new Error("Medication or current schedule not found");
            const owner = await getUser(db, Number(med.user_id));
            if (!owner || !accessible(actor, owner)) throw new Error("Access denied");
            const zone = canonicalTimeZone(owner.time_zone);
            if (!zone) throw new Error("User time zone is not configured");
            const occurrenceId = await upsertOccurrence(db, {
              medicationId: Number(med.id), userId: Number(med.user_id), scheduleVersion: Number(med.schedule_version),
              localDate: b.date, localTime, scheduledAtUtc: mysqlDateTime(resolveLocalOccurrence(b.date, localTime, zone))
            });
            const changed = status === "TAKEN"
              ? await markOccurrenceTaken(db, occurrenceId)
              : await markOccurrenceMissed(db, occurrenceId);
            const [logResult] = await query<{ insertId: number }>(db,
              `INSERT INTO intake_logs (occurrence_id,marker_user_id,medication_id,date,time,status,scheduled_time,taken_time,missed_time,created_at,updated_at)
               VALUES (?,?,?,?,?,?,CONCAT(?,' ',?),IF(?='TAKEN',NOW(),NULL),IF(?='MISSED',NOW(),NULL),NOW(),NOW())
               ON DUPLICATE KEY UPDATE status=IF(VALUES(status)='TAKEN','TAKEN',status),taken_time=IF(VALUES(status)='TAKEN',NOW(),taken_time),missed_time=IF(status='TAKEN',NULL,NOW()),updated_at=NOW(),id=LAST_INSERT_ID(id)`,
              [occurrenceId, actor.id, b.medicationId, b.date, localTime, status, b.date, localTime, status, status]);
            if (changed) {
              const activityMsg = status === "TAKEN"
                ? `Took ${med.name} (${med.dosage}) at ${localTime}`
                : `Missed ${med.name} (${med.dosage}) scheduled for ${localTime}`;
              await query(db, "INSERT INTO activities (user_id,type,message,related_entity_type,related_entity_id,created_at) VALUES (?,?,?,?,?,NOW())",
                [actor.id, status === "TAKEN" ? "DOSE_TAKEN" : "DOSE_MISSED", activityMsg, "INTAKE_LOG", logResult.insertId]);
            }
            return { success: true, logId: logResult.insertId };
          });
          return json(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to mark dose";
          const statusCode = message === "Access denied" ? 403 : 400;
          return json({ message }, statusCode);
        } finally {
          if (db) await db.end();
        }
      }

      if (path === "/api/logs/mark-missed-batch" && request.method === "POST") {
        const { body: b } = await requestBody(request);
        const list = Array.isArray(b) ? b : [];
        let created = 0;
        let db: any = null;
        try {
          db = await getDbConnection(env);
          for (const req of list) {
            if (!req.medicationId || !req.date || !req.time) continue;
            await transact(db, async () => {
              const localTime = String(req.time).substring(0, 5);
              const [meds] = await query<Json[]>(db,
                "SELECT m.* FROM medications m JOIN medication_times mt ON mt.medication_id=m.id WHERE m.id=? AND m.active=1 AND ? BETWEEN m.start_date AND m.end_date AND TIME_FORMAT(mt.time_of_day,'%H:%i')=? LIMIT 1 FOR UPDATE",
                [req.medicationId, req.date, localTime]);
              const med = meds[0];
              if (!med) return;
              const owner = await getUser(db, Number(med.user_id));
              if (!owner || !accessible(actor, owner)) return;
              const zone = canonicalTimeZone(owner.time_zone);
              if (!zone) return;
              const occurrenceId = await upsertOccurrence(db, { medicationId: Number(med.id), userId: Number(med.user_id), scheduleVersion: Number(med.schedule_version), localDate: req.date, localTime, scheduledAtUtc: mysqlDateTime(resolveLocalOccurrence(req.date, localTime, zone)) });
              if (!await markOccurrenceMissed(db, occurrenceId)) return;
              const [ins] = await query<{ insertId: number }>(db,
                "INSERT INTO intake_logs (occurrence_id,marker_user_id,medication_id,date,time,status,scheduled_time,missed_time,created_at,updated_at) VALUES (?,?,?,?,?,'MISSED',CONCAT(?,' ',?),NOW(),NOW(),NOW()) ON DUPLICATE KEY UPDATE status=IF(status='TAKEN','TAKEN','MISSED'),missed_time=IF(status='TAKEN',missed_time,NOW()),id=LAST_INSERT_ID(id)",
                [occurrenceId, actor.id, req.medicationId, req.date, localTime, req.date, localTime]);
              created++;
            });
          }
          return json({ created });
        } finally {
          if (db) await db.end();
        }
      }

      // ── Push Subscriptions ──────────────────────────────────────────────────
      if (path === "/api/user/time-zone" && request.method === "GET") {
        return json({ timeZone: canonicalTimeZone(actor.time_zone) });
      }

      if (path === "/api/user/time-zone" && request.method === "PUT") {
        const { body: b } = await requestBody(request);
        const timeZone = canonicalTimeZone(b.timeZone);
        if (!timeZone) return json({ message: "A valid IANA time zone is required" }, 400);
        try {
          await query(env, "UPDATE users SET time_zone=?,updated_at=NOW() WHERE id=?", [timeZone, actor.id]);
          return json({ timeZone });
        } catch (error) {
          if (!timeZoneSchemaNotReady(error)) throw error;
          // Do not guess UTC/India: this deployment's schema cannot persist a zone,
          // so server scheduling remains unavailable until the additive column exists.
          return json({
            timeZone: null,
            schedulingAvailable: false,
            needsTimeZoneSetup: true,
            message: "Time-zone storage is not available yet; medication reminders cannot be scheduled until setup is completed."
          }, 409);
        }
      }

      if (path === "/api/push/subscribe" && request.method === "POST") {
        const { body: b } = await requestBody(request);
        if (!b.subscription) return json({ message: "Missing subscription data" }, 400);
        const subscriptionZone = b.timeZone === undefined ? null : canonicalTimeZone(b.timeZone);
        if (b.timeZone !== undefined && !subscriptionZone) return json({ message: "Invalid IANA time zone" }, 400);

        try {
          if (subscriptionZone) await query(env, "UPDATE users SET time_zone=?,updated_at=NOW() WHERE id=?", [subscriptionZone, actor.id]);
          // Clean up any existing subscriptions for this user first
          await query(
            env,
            "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
            [actor.id, b.subscription.endpoint]
          );

          // Insert new subscription
          await query(
            env,
            "INSERT INTO push_subscriptions (user_id, endpoint, subscription_data, active, created_at) VALUES (?, ?, ?, 1, NOW())",
            [actor.id, b.subscription.endpoint, JSON.stringify(b.subscription)]
          );

          return json({ success: true, message: "Push subscription registered" });
        } catch (error) {
          console.error("[Push Subscribe] Error:", error);
          return json({ message: "Failed to register push subscription" }, 500);
        }
      }

      if (path === "/api/push/unsubscribe" && request.method === "POST") {
        const { body: b } = await requestBody(request);
        
        try {
          if (b.endpoint) {
            await query(
              env,
              "UPDATE push_subscriptions SET active = 0 WHERE user_id = ? AND endpoint = ?",
              [actor.id, b.endpoint]
            );
          } else {
            // Unsubscribe all for this user
            await query(
              env,
              "UPDATE push_subscriptions SET active = 0 WHERE user_id = ?",
              [actor.id]
            );
          }

          return json({ success: true, message: "Push subscription removed" });
        } catch (error) {
          console.error("[Push Unsubscribe] Error:", error);
          return json({ message: "Failed to remove push subscription" }, 500);
        }
      }

      if (path === "/api/push/vapid-key" && request.method === "GET") {
        if (!env.VAPID_PUBLIC_KEY) {
          return json({ message: "VAPID not configured" }, 500);
        }
        return json({ publicKey: env.VAPID_PUBLIC_KEY });
      }

      const logsHistory = path.match(/^\/api\/logs\/history\/(\d+)$/);
      if (logsHistory && request.method === "GET") {
        const target = await getUser(env, Number(logsHistory[1]));
        if (!target) return json({ message: "User not found" }, 400);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const page = Math.max(0, parseInt(url.searchParams.get("page") || "0", 10));
        const size = Math.min(500, Math.max(1, parseInt(url.searchParams.get("size") || "100", 10)));
        const offset = page * size;

        const [rows] = await query<Json[]>(
          env,
          "SELECT l.id, DATE_FORMAT(l.date,'%Y-%m-%d') AS date, TIME_FORMAT(l.time,'%H:%i') AS time, l.medication_id AS medicationId, m.name AS medicationName, m.dosage, l.status FROM intake_logs l JOIN medications m ON m.id=l.medication_id WHERE l.marker_user_id=? ORDER BY l.date DESC, l.time DESC LIMIT ? OFFSET ?",
          [target.id, size, offset]
        );
        return json(rows);
      }

      const logsSummary = path.match(/^\/api\/logs\/summary(?:\/week)?\/(\d+)$/);
      if (logsSummary && request.method === "GET") {
        const target = await getUser(env, Number(logsSummary[1]));
        if (!target) return json({ message: "User not found" }, 400);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const isWeek = path.includes("/summary/week/");
        const days = isWeek ? 7 : Math.min(3650, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10)));
        const zone = canonicalTimeZone(target.time_zone);
        if (!zone) return json([]);
        const today = zonedParts(Date.now(), zone).date;
        const firstDay = addLocalDays(today, -(days - 1));

        const [logCounts] = await query<Json[]>(
          env,
          "SELECT DATE_FORMAT(date,'%Y-%m-%d') AS day_str, SUM(status='TAKEN') AS taken, SUM(status='MISSED') AS missed FROM intake_logs WHERE marker_user_id=? AND date>=? AND date<=? GROUP BY day_str",
          [target.id, firstDay, today]
        );

        const countMap = new Map<string, { taken: number; missed: number }>();
        for (const c of logCounts) {
          countMap.set(c.day_str, { taken: Number(c.taken || 0), missed: Number(c.missed || 0) });
        }

        const result: Array<{ date: string; taken: number; missed: number }> = [];
        for (let i = days - 1; i >= 0; i--) {
          const dStr = addLocalDays(today, -i);
          const c = countMap.get(dStr) || { taken: 0, missed: 0 };
          result.push({ date: dStr, taken: c.taken, missed: c.missed });
        }

        return json(result);
      }

      const logsStats = path.match(/^\/api\/logs\/adherence\/stats\/(\d+)$/);
      if (logsStats && request.method === "GET") {
        const target = await getUser(env, Number(logsStats[1]));
        if (!target) return json({ message: "User not found" }, 400);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const days = Math.min(3650, Math.max(0, parseInt(url.searchParams.get("days") || "0", 10)));
        const zone = canonicalTimeZone(target.time_zone);
        if (!zone) return json({ total: 0, taken: 0, missed: 0, pending: 0, adherencePercentage: 0, missedToday: 0, missedThisWeek: 0, missedThisMonth: 0, mostMissedMedicine: "-", mostMissedCount: 0 });
        const today = zonedParts(Date.now(), zone).date;
        const filter = days > 0 ? "AND date>=?" : "";

        const [counts] = await query<Json[]>(
          env,
          `SELECT
             COUNT(*) AS total,
             SUM(status='TAKEN') AS taken,
             SUM(status='MISSED') AS missed,
             SUM(date=? AND status='MISSED') AS missedToday,
             SUM(date>=? AND status='MISSED') AS missedThisWeek,
             SUM(date>=? AND status='MISSED') AS missedThisMonth
           FROM intake_logs WHERE marker_user_id=? ${filter}`,
          days > 0 ? [today, addLocalDays(today, -6), addLocalDays(today, -29), target.id, addLocalDays(today, -(days - 1))] : [today, addLocalDays(today, -6), addLocalDays(today, -29), target.id]
        );

        const total = Number(counts[0]?.total || 0);
        const taken = Number(counts[0]?.taken || 0);
        const missed = Number(counts[0]?.missed || 0);
        const completed = taken + missed;
        const adherencePercentage = completed > 0 ? Math.round((taken * 1000.0) / completed) / 10.0 : 0.0;

        const [mostMissedRows] = await query<Json[]>(
          env,
          "SELECT m.name, COUNT(*) AS count FROM intake_logs l JOIN medications m ON m.id=l.medication_id WHERE l.marker_user_id=? AND l.status='MISSED' GROUP BY m.name ORDER BY count DESC LIMIT 1",
          [target.id]
        );

        return json({
          total,
          taken,
          missed,
          pending: 0,
          adherencePercentage,
          missedToday: Number(counts[0]?.missedToday || 0),
          missedThisWeek: Number(counts[0]?.missedThisWeek || 0),
          missedThisMonth: Number(counts[0]?.missedThisMonth || 0),
          mostMissedMedicine: mostMissedRows[0]?.name || "-",
          mostMissedCount: Number(mostMissedRows[0]?.count || 0)
        });
      }

      // ── BMI Records ─────────────────────────────────────────────────────
      if (path === "/api/bmi/calculate" && request.method === "POST") {
        const { body: b } = await requestBody(request);
        const height = Number(b.height);
        const weight = Number(b.weight);
        if (!height || height < 50 || height > 300) return json({ message: "Height must be between 50 and 300 cm" }, 400);
        if (!weight || weight < 20 || weight > 500) return json({ message: "Weight must be between 20 and 500 kg" }, 400);

        const heightM = height / 100.0;
        const rawBmi = weight / (heightM * heightM);
        const bmiValue = Math.round(rawBmi * 10) / 10;
        const category = bmiValue < 18.5 ? "UNDERWEIGHT" : bmiValue < 25.0 ? "NORMAL" : bmiValue < 30.0 ? "OVERWEIGHT" : "OBESE";

        let db: any = null;
        try {
          db = await getDbConnection(env);
          const [ins] = await query<{ insertId: number }>(
            db,
            "INSERT INTO bmi_records (user_id,height,weight,bmi_value,bmi_category,created_at) VALUES (?,?,?,?,?,NOW())",
            [actor.id, height, weight, bmiValue, category]
          );
          await query(
            db,
            "INSERT INTO activities (user_id,type,message,related_entity_type,related_entity_id,created_at) VALUES (?,?,?,?,?,NOW())",
            [actor.id, "BMI_CALCULATED", `BMI calculated: ${bmiValue} (${category})`, "BMI_RECORD", ins.insertId]
          );

          const [rows] = await query<Json[]>(db, "SELECT * FROM bmi_records WHERE id=?", [ins.insertId]);
          return json(buildBmiResponse(rows[0]));
        } finally {
          if (db) await db.end();
        }
      }

      const bmiLatest = path.match(/^\/api\/bmi\/latest\/(\d+)$/);
      if (bmiLatest && request.method === "GET") {
        const target = await getUser(env, Number(bmiLatest[1]));
        if (!target) return json({ message: "User not found" }, 404);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const [rows] = await query<Json[]>(env, "SELECT * FROM bmi_records WHERE user_id=? ORDER BY created_at DESC LIMIT 1", [target.id]);
        if (!rows[0]) return json(null, 200);
        return json(buildBmiResponse(rows[0]));
      }

      const bmiRecent = path.match(/^\/api\/bmi\/recent\/(\d+)$/);
      if (bmiRecent && request.method === "GET") {
        const target = await getUser(env, Number(bmiRecent[1]));
        if (!target) return json({ message: "User not found" }, 404);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10)));
        const [rows] = await query<Json[]>(env, "SELECT * FROM bmi_records WHERE user_id=? ORDER BY created_at DESC LIMIT ?", [target.id, limit]);
        return json(rows.map(buildBmiResponse));
      }

      const bmiHistory = path.match(/^\/api\/bmi\/history\/(\d+)$/);
      if (bmiHistory && request.method === "GET") {
        const target = await getUser(env, Number(bmiHistory[1]));
        if (!target) return json({ message: "User not found" }, 404);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const [rows] = await query<Json[]>(env, "SELECT * FROM bmi_records WHERE user_id=? ORDER BY created_at DESC", [target.id]);
        return json(rows.map(buildBmiResponse));
      }

      // ── Vitals Records ──────────────────────────────────────────────────
      if (path === "/api/vitals/add" && request.method === "POST") {
        const { body: b } = await requestBody(request);
        const sys = b.bpSystolic != null ? Number(b.bpSystolic) : null;
        const dia = b.bpDiastolic != null ? Number(b.bpDiastolic) : null;
        const sugar = b.bloodSugar != null ? Number(b.bloodSugar) : null;
        const weight = b.weight != null ? Number(b.weight) : null;
        const hr = b.heartRate != null ? Number(b.heartRate) : null;
        const temp = b.temperature != null ? Number(b.temperature) : null;

        if (sys == null && dia == null && sugar == null && weight == null && hr == null && temp == null) {
          return json({ message: "At least one vital measurement is required" }, 400);
        }

        let db: any = null;
        try {
          db = await getDbConnection(env);
          const [ins] = await query<{ insertId: number }>(
            db,
            "INSERT INTO vital_records (user_id,bp_systolic,bp_diastolic,blood_sugar,weight,heart_rate,temperature,notes,recorded_at) VALUES (?,?,?,?,?,?,?,?,NOW())",
            [actor.id, sys, dia, sugar, weight, hr, temp, b.notes || null]
          );
          await query(
            db,
            "INSERT INTO activities (user_id,type,message,related_entity_type,related_entity_id,created_at) VALUES (?,?,?,?,?,NOW())",
            [actor.id, "VITALS_LOGGED", "Vitals logged successfully", "VITAL_RECORD", ins.insertId]
          );

          const [rows] = await query<Json[]>(db, "SELECT * FROM vital_records WHERE id=?", [ins.insertId]);
          return json(buildVitalResponse(rows[0]));
        } finally {
          if (db) await db.end();
        }
      }

      const vitalsLatest = path.match(/^\/api\/vitals\/latest\/(\d+)$/);
      if (vitalsLatest && request.method === "GET") {
        const target = await getUser(env, Number(vitalsLatest[1]));
        if (!target) return json({ message: "User not found" }, 404);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const [rows] = await query<Json[]>(env, "SELECT * FROM vital_records WHERE user_id=? ORDER BY recorded_at DESC LIMIT 1", [target.id]);
        if (!rows[0]) return json(null, 200);
        return json(buildVitalResponse(rows[0]));
      }

      const vitalsRecent = path.match(/^\/api\/vitals\/recent\/(\d+)$/);
      if (vitalsRecent && request.method === "GET") {
        const target = await getUser(env, Number(vitalsRecent[1]));
        if (!target) return json({ message: "User not found" }, 404);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10)));
        const [rows] = await query<Json[]>(env, "SELECT * FROM vital_records WHERE user_id=? ORDER BY recorded_at DESC LIMIT ?", [target.id, limit]);
        return json(rows.map(buildVitalResponse));
      }

      const vitalsHistory = path.match(/^\/api\/vitals\/history\/(\d+)$/);
      if (vitalsHistory && request.method === "GET") {
        const target = await getUser(env, Number(vitalsHistory[1]));
        if (!target) return json({ message: "User not found" }, 404);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const [rows] = await query<Json[]>(env, "SELECT * FROM vital_records WHERE user_id=? ORDER BY recorded_at DESC", [target.id]);
        return json(rows.map(buildVitalResponse));
      }

      const vitalsTrend = path.match(/^\/api\/vitals\/trend\/(\d+)$/);
      if (vitalsTrend && request.method === "GET") {
        const target = await getUser(env, Number(vitalsTrend[1]));
        if (!target) return json({ message: "User not found" }, 404);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const period = (url.searchParams.get("period") || "week").toLowerCase();
        const days = period === "month" ? 30 : 7;
        const [rows] = await query<Json[]>(
          env,
          `SELECT * FROM vital_records WHERE user_id=? AND recorded_at>=DATE_SUB(NOW(), INTERVAL ${days} DAY) ORDER BY recorded_at ASC`,
          [target.id]
        );
        return json(rows.map(buildVitalResponse));
      }

      const delVital = path.match(/^\/api\/vitals\/(\d+)$/);
      if (delVital && request.method === "DELETE") {
        const id = Number(delVital[1]);
        const [rows] = await query<Json[]>(env, "SELECT * FROM vital_records WHERE id=?", [id]);
        if (!rows[0]) return new Response(null, { status: 404, headers: cors });
        if (Number(rows[0].user_id) !== actor.id) return plain("Access denied", 403);
        await query(env, "DELETE FROM vital_records WHERE id=?", [id]);
        return new Response(null, { status: 204, headers: cors });
      }

      // ── Streaks ─────────────────────────────────────────────────────────
      const streaksMatch = path.match(/^\/api\/streaks\/(?:recalculate\/)?(\d+)$/);
      if (streaksMatch && (request.method === "GET" || request.method === "POST")) {
        const target = await getUser(env, Number(streaksMatch[1]));
        if (!target) return json({ message: "User not found" }, 404);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const [rows] = await query<Json[]>(env, "SELECT * FROM user_streaks WHERE user_id=? LIMIT 1", [target.id]);
        let streak = rows[0];
        if (!streak) {
          await query(env, "INSERT IGNORE INTO user_streaks (user_id,current_streak,longest_streak,unlocked_badges,updated_at) VALUES (?,0,0,'',NOW())", [target.id]);
          const [created] = await query<Json[]>(env, "SELECT * FROM user_streaks WHERE user_id=? LIMIT 1", [target.id]);
          streak = created[0] || { current_streak: 0, longest_streak: 0, last_perfect_date: null };
        }

        return json({
          currentStreak: Number(streak.current_streak || 0),
          longestStreak: Number(streak.longest_streak || 0),
          lastTakenDate: streak.last_perfect_date || null,
          perfectDaysCount: Number(streak.current_streak || 0),
          completionRate: 100.0
        });
      }

      // ── Activities ──────────────────────────────────────────────────────
      const actRecent = path.match(/^\/api\/activities\/recent\/(\d+)$/);
      if (actRecent && request.method === "GET") {
        const target = await getUser(env, Number(actRecent[1]));
        if (!target) return json({ message: "User not found" }, 400);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10)));
        const [rows] = await query<Json[]>(
          env,
          "SELECT id, user_id AS userId, type, message, related_entity_type AS relatedEntityType, related_entity_id AS relatedEntityId, metadata, created_at AS createdAt FROM activities WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
          [target.id, limit]
        );
        return json(rows);
      }

      const actAll = path.match(/^\/api\/activities\/all\/(\d+)$/);
      if (actAll && request.method === "GET") {
        const target = await getUser(env, Number(actAll[1]));
        if (!target) return json({ message: "User not found" }, 400);
        if (!accessible(actor, target)) return json({ message: "Access denied" }, 403);

        const [rows] = await query<Json[]>(
          env,
          "SELECT id, user_id AS userId, type, message, related_entity_type AS relatedEntityType, related_entity_id AS relatedEntityId, metadata, created_at AS createdAt FROM activities WHERE user_id=? ORDER BY created_at DESC",
          [target.id]
        );
        return json(rows);
      }

      // ── User Profile & Security ─────────────────────────────────────────
      const profile = path.match(/^\/api\/user\/profile\/(\d+)$/);
      if (profile) {
        const target = await getUser(env, Number(profile[1]));
        if (!target) return plain("User not found", 404);
        if (!accessible(actor, target)) return plain("Access denied", 403);
        if (request.method === "GET") {
          const { password_hash, ...safe } = target;
          const dobStr = safe.dob ? (typeof safe.dob === "string" ? safe.dob.slice(0, 10) : new Date(safe.dob).toISOString().slice(0, 10)) : null;
          return json({ ...safe, dob: dobStr, patientEmail: target.patient_email, emergencyContact: target.emergency_contact, acceptedTerms: Boolean(target.accepted_terms), timeZone: target.time_zone ?? null });
        }
        if (request.method === "PUT") {
          const { body: b } = await requestBody(request);
          const dobVal = b.dob ? String(b.dob).slice(0, 10) : null;
          await query(
            env,
            "UPDATE users SET name=?,phone=?,dob=?,gender=?,emergency_contact=?,updated_at=NOW() WHERE id=?",
            [b.name ?? target.name, b.phone ?? null, dobVal, b.gender ?? null, b.emergencyContact ?? null, target.id]
          );
          const { password_hash, ...safe } = (await getUser(env, target.id))!;
          const dobStr = safe.dob ? (typeof safe.dob === "string" ? safe.dob.slice(0, 10) : new Date(safe.dob).toISOString().slice(0, 10)) : null;
          return json({ ...safe, dob: dobStr, patientEmail: safe.patient_email, emergencyContact: safe.emergency_contact, acceptedTerms: Boolean(safe.accepted_terms), timeZone: safe.time_zone ?? null });
        }
      }

      const password = path.match(/^\/api\/user\/change-password\/(\d+)$/);
      if (password && request.method === "POST") {
        if (actor.id !== Number(password[1])) return plain("Access denied", 403);
        const { body: b } = await requestBody(request);
        if (!await bcrypt.compare(String(b.currentPassword ?? ""), actor.password_hash)) return json({ message: "Current password is incorrect" }, 400);
        if (String(b.newPassword ?? "").length < 8) return json({ message: "Password must be at least 8 characters" }, 400);
        await query(env, "UPDATE users SET password_hash=?,updated_at=NOW() WHERE id=?", [await bcrypt.hash(String(b.newPassword), 10), actor.id]);
        return json({ message: "Password changed successfully" });
      }

      return json({ message: "Not found" }, 404);
    } catch (e) {
      const duration = Date.now() - startTime;
      if (path.includes('/medications/add') || path.includes('/logs/mark')) {
        console.error(`[Worker] ${request.method} ${path} - Error after ${duration}ms:`, e instanceof Error ? e.message : "unknown");
      }
      console.error("DoseBuddy Worker error", e instanceof Error ? e.message : "unknown");
      return json({ message: "Internal server error", error: e instanceof Error ? e.message : String(e) }, 500);
    } finally {
      const duration = Date.now() - startTime;
      if (path.includes('/medications/add') || path.includes('/logs/mark')) {
        console.log(`[Worker] ${request.method} ${path} - Completed in ${duration}ms`);
      }
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("[DoseBuddy Cron] Starting zone-aware occurrence processing");
    const now = new Date(event.scheduledTime || Date.now());
    try {
      await this.processDueReminders(env, now);
      await this.processMissedDoses(env, now);
    } catch (error) {
      console.error("[DoseBuddy Cron] Scheduled function error:", error instanceof Error ? error.message : "unknown");
    }
  },

  async processDueReminders(env: Env, now: Date): Promise<void> {
    const [dueRows] = await query<any[]>(env,
      `SELECT m.id AS medication_id,m.user_id,m.name AS medication_name,m.dosage,m.start_date,m.end_date,
              m.schedule_version,u.time_zone,TIME_FORMAT(mt.time_of_day,'%H:%i') AS time_str
       FROM medications m JOIN medication_times mt ON mt.medication_id=m.id JOIN users u ON u.id=m.user_id
       WHERE m.active=1 AND u.time_zone IS NOT NULL`);
    for (const dose of dueOccurrencesAtInstant(dueRows.map(dose => ({
      ...dose,
      start_date: mysqlDate(dose.start_date),
      end_date: mysqlDate(dose.end_date)
    })), now)) {
      const db = await getDbConnection(env);
      try {
        const occurrenceId = await upsertOccurrence(db, {
          medicationId: Number(dose.medication_id), userId: Number(dose.user_id), scheduleVersion: Number(dose.schedule_version),
          localDate: dose.localDate, localTime: dose.localTime, scheduledAtUtc: mysqlDateTime(dose.scheduledAtUtc)
        });
        await this.sendDoseNotification(env, db, {
          ...dose,
          occurrence_id: occurrenceId,
          local_date: dose.localDate,
          time_str: dose.localTime,
          scheduled_at_utc: mysqlDateTime(dose.scheduledAtUtc),
          event_type: "REMINDER"
        });
      } finally {
        await db.end();
      }
    }
  },

  async processMissedDoses(env: Env, now: Date): Promise<void> {
    const cutoff = mysqlDateTime(new Date(now.getTime() - 60 * 60_000));
    const [rows] = await query<any[]>(env,
      `SELECT o.id AS occurrence_id,o.medication_id,o.user_id,o.schedule_version,
              DATE_FORMAT(o.local_date,'%Y-%m-%d') AS local_date,TIME_FORMAT(o.local_time,'%H:%i') AS time_str,
              o.scheduled_at_utc,m.name AS medication_name,m.dosage
       FROM dose_occurrences o JOIN medications m ON m.id=o.medication_id
       WHERE o.state='PENDING' AND o.scheduled_at_utc<=? AND m.active=1
         AND o.schedule_version=m.schedule_version AND o.local_date BETWEEN m.start_date AND m.end_date
         AND EXISTS (SELECT 1 FROM medication_times mt WHERE mt.medication_id=m.id AND TIME_FORMAT(mt.time_of_day,'%H:%i')=TIME_FORMAT(o.local_time,'%H:%i'))`, [cutoff]);
    for (const dose of rows) {
      const db = await getDbConnection(env);
      let transitioned = false;
      try {
        transitioned = await transact(db, async () => {
          if (!await markOccurrenceMissed(db, Number(dose.occurrence_id))) return false;
          const [log] = await query<{ insertId: number }>(db,
            `INSERT INTO intake_logs (occurrence_id,marker_user_id,medication_id,date,time,status,scheduled_time,missed_time,created_at,updated_at)
             VALUES (?,?,?,?,?,'MISSED',?,NOW(),NOW(),NOW())
             ON DUPLICATE KEY UPDATE status=IF(status='TAKEN','TAKEN','MISSED'),missed_time=IF(status='TAKEN',missed_time,NOW()),id=LAST_INSERT_ID(id)`,
            [dose.occurrence_id, dose.user_id, dose.medication_id, dose.local_date, dose.time_str, dose.scheduled_at_utc]);
          await query(db, "INSERT INTO activities (user_id,type,message,related_entity_type,related_entity_id,created_at) VALUES (?,'DOSE_MISSED',?,'INTAKE_LOG',?,NOW())",
            [dose.user_id, `Missed ${dose.medication_name} (${dose.dosage}) scheduled for ${dose.time_str}`, log.insertId]);
          return true;
        });
        if (transitioned) await this.sendDoseNotification(env, db, { ...dose, event_type: "MISSED" });
      } catch (error) {
        console.error(`[DoseBuddy Cron] Failed missed transition for occurrence ${dose.occurrence_id}:`, error instanceof Error ? error.message : "unknown");
      } finally {
        await db.end();
      }
    }

    await this.recoverExpiredClaims(env);
    const [retryRows] = await query<any[]>(env,
      `SELECT DISTINCT o.id AS occurrence_id,o.medication_id,o.user_id,o.schedule_version,
              DATE_FORMAT(o.local_date,'%Y-%m-%d') AS local_date,TIME_FORMAT(o.local_time,'%H:%i') AS time_str,
              o.scheduled_at_utc,m.name AS medication_name,m.dosage,a.event_type
       FROM push_delivery_attempts a JOIN dose_occurrences o ON o.id=a.occurrence_id JOIN medications m ON m.id=o.medication_id
       WHERE a.outcome='RETRY' AND a.next_attempt_at<=NOW()`);
    for (const dose of retryRows) {
      const db = await getDbConnection(env);
      try { await this.sendDoseNotification(env, db, dose); } finally { await db.end(); }
    }
  },

  async recoverExpiredClaims(env: Env): Promise<void> {
    const [attempts] = await query<any[]>(env,
      `SELECT a.event_id,a.subscription_id,a.claim_token,a.claim_version,a.dispatch_started_at,
              o.id AS occurrence_id,o.medication_id,o.user_id,o.schedule_version,
              DATE_FORMAT(o.local_date,'%Y-%m-%d') AS local_date,TIME_FORMAT(o.local_time,'%H:%i') AS time_str,a.event_type
       FROM push_delivery_attempts a JOIN dose_occurrences o ON o.id=a.occurrence_id
       WHERE a.outcome='CLAIMED' AND a.lease_expires_at<=NOW(3)`);
    for (const attempt of attempts) {
      const db = await getDbConnection(env);
      const claim: DeliveryClaim = { eventId: String(attempt.event_id), subscriptionId: Number(attempt.subscription_id), token: String(attempt.claim_token), version: Number(attempt.claim_version) };
      try {
        if (attempt.dispatch_started_at) {
          await finalizeDelivery(db, claim, "UNCERTAIN", undefined, "lease-expired-after-dispatch");
          continue;
        }
        const occurrence: DeliveryOccurrence = {
          occurrenceId: Number(attempt.occurrence_id), medicationId: Number(attempt.medication_id), userId: Number(attempt.user_id),
          scheduleVersion: Number(attempt.schedule_version), localDate: String(attempt.local_date), localTime: String(attempt.time_str).slice(0, 5),
          eventType: String(attempt.event_type) === "MISSED" ? "MISSED" : "REMINDER"
        };
        await db.beginTransaction();
        if (await occurrenceIsCurrent(db, occurrence, true)) await releaseUnstartedClaim(db, claim, "lease-expired-before-dispatch");
        else await obsoleteClaim(db, claim);
        await db.commit();
      } catch (error) {
        try { await db.rollback(); } catch {}
        console.error(`[Web Push] Failed recovering delivery claim ${attempt.event_id}`);
      } finally {
        await db.end();
      }
    }
  },

  async sendDoseNotification(env: Env, db: any, dose: any): Promise<void> {
    const event: DeliveryOccurrence = {
      occurrenceId: Number(dose.occurrence_id), medicationId: Number(dose.medication_id), userId: Number(dose.user_id),
      scheduleVersion: Number(dose.schedule_version), localDate: String(dose.local_date), localTime: String(dose.time_str).slice(0, 5),
      eventType: String(dose.event_type).toUpperCase() === "MISSED" ? "MISSED" : "REMINDER"
    };
    const eventId = notificationEventId(event);
    const [subscriptions] = await query<any[]>(db, "SELECT * FROM push_subscriptions WHERE user_id=? AND active=1", [event.userId]);
    for (const sub of subscriptions) {
      const claim = await claimDeliveryAttempt(db, event, Number(sub.id), dose.scheduled_at_utc);
      if (!claim) continue;
      let dispatchStarted = false;
      try {
        // Persist the recovery boundary first. A failure after this commit must remain
        // UNCERTAIN rather than being automatically sent again.
        await db.beginTransaction();
        if (!await occurrenceIsCurrent(db, event, true)) {
          await obsoleteClaim(db, claim);
          await db.commit();
          continue;
        }
        dispatchStarted = await startDeliveryDispatch(db, claim);
        await db.commit();
        if (!dispatchStarted) continue;

        // Reacquire and retain the medication row lock through provider submission.
        // A mutation that won the interval before this lock is revalidated out; one
        // arriving afterwards blocks until the final outcome has been persisted.
        await db.beginTransaction();
        if (!await occurrenceIsCurrent(db, event, true)) {
          await obsoleteClaim(db, claim);
          await db.commit();
          continue;
        }
        const payload = event.eventType === "REMINDER" ? {
          title: "DoseBuddy - Medication Reminder", body: `Time to take ${dose.medication_name} (${dose.dosage})`,
          icon: "/favicon.ico", badge: "/favicon.ico", tag: `reminder-${eventId}`,
          data: { type: "dose-reminder", doseId: eventId, userId: event.userId, medicationId: event.medicationId, url: "/" },
          timestamp: Date.now(), requireInteraction: true
        } : {
          title: "DoseBuddy - Missed Dose", body: `You missed ${dose.medication_name} (${dose.dosage}) scheduled for ${event.localTime}`,
          icon: "/favicon.ico", badge: "/favicon.ico", tag: `missed-${eventId}`,
          data: { type: "missed-dose", doseId: eventId, userId: event.userId, medicationId: event.medicationId, url: "/" }
        };
        const result = await sendWebPush(JSON.parse(sub.subscription_data) as PushSubscriptionData, payload, vapidConfig(env));
        if (result.expired) {
          await query(db, "UPDATE push_subscriptions SET active=0 WHERE id=?", [sub.id]);
          await finalizeDelivery(db, claim, "EXPIRED", result.status);
        } else if (result.ok) {
          await finalizeDelivery(db, claim, "SENT", result.status);
        } else if (result.retryable) {
          await finalizeDelivery(db, claim, "RETRY", result.status, "provider");
        } else {
          await finalizeDelivery(db, claim, "FAILED", result.status, "provider");
        }
        await db.commit();
      } catch (error) {
        try { await db.rollback(); } catch {}
        // A persisted dispatch boundary means provider acceptance is unknowable.
        try {
          if (dispatchStarted) await finalizeDelivery(db, claim, "UNCERTAIN", undefined, "dispatch-uncertain");
          else await releaseUnstartedClaim(db, claim, "pre-dispatch");
        } catch {}
        console.error(`[Web Push] Delivery failed for event ${eventId}`);
      }
    }
  }
};

export default worker;
