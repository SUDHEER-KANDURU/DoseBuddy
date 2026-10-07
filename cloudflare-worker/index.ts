import { createConnection } from "mysql2/promise";
import bcrypt from "bcryptjs";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  JWT_SECRET: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GROQ_MODEL?: string;
  GEMINI_MODEL?: string;
}

type Json = Record<string, any>;
type User = Json & { id: number; email: string; password_hash: string; role: string; patient_email?: string | null };

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
  return (await createConnection({
    host: env.HYPERDRIVE.host,
    user: env.HYPERDRIVE.user,
    password: env.HYPERDRIVE.password,
    database: env.HYPERDRIVE.database,
    port: env.HYPERDRIVE.port,
    disableEval: true,
    timezone: "Z",
    connectTimeout: 5000,         // 5 second connection timeout
    acquireTimeout: 5000,         // 5 second acquire timeout
    timeout: 10000,               // 10 second query timeout
    connectionLimit: 10,          // Connection pool limit
    queueLimit: 0,                // No queue limit - fail fast when pool exhausted
    multipleStatements: false     // Security: disable multiple statements
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

async function callAi(env: Env, prompt: string): Promise<Response> {
  // 1. Try Gemini models if GEMINI_API_KEY is configured
  if (env.GEMINI_API_KEY) {
    const models = [
      env.GEMINI_MODEL || "gemini-2.5-flash",
      "gemini-2.5-flash-lite"
    ];
    for (const model of models) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.2 }
            })
          }
        );
        if (resp.ok) {
          const data = await resp.json<any>();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text && text.trim()) {
            return plain(text.trim());
          }
        }
      } catch (err) {
        console.error(`Gemini model ${model} error:`, err);
      }
    }
  }

  // 2. Try Groq models if GROQ_API_KEY is configured
  if (env.GROQ_API_KEY) {
    const models = [
      env.GROQ_MODEL || "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-20b"
    ];
    for (const model of models) {
      try {
        const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.GROQ_API_KEY}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2
          })
        });
        if (resp.ok) {
          const data = await resp.json<any>();
          const text = data.choices?.[0]?.message?.content;
          if (text && text.trim()) {
            return plain(text.trim());
          }
        }
      } catch (err) {
        console.error(`Groq model ${model} error:`, err);
      }
    }
  }

  // 3. Graceful controlled fallback if AI provider is unreachable or unconfigured
  if (prompt.includes("health insights") || prompt.includes("Patient data") || prompt.includes("JSON array")) {
    const fallbackArray = [
      { title: "Medication Adherence", message: "Keep taking your scheduled doses consistently for optimal health outcomes.", type: "info", icon: "💊" },
      { title: "Stay Consistent", message: "Maintaining a daily routine helps establish strong adherence habits.", type: "success", icon: "⭐" },
      { title: "Health Tracking", message: "Regularly logging your vitals and BMI provides valuable long-term health trends.", type: "info", icon: "📊" },
      { title: "Consult Healthcare Provider", message: "Always discuss medication adjustments with your physician or pharmacist.", type: "warning", icon: "🩺" }
    ];
    return plain(JSON.stringify(fallbackArray));
  }

  return plain("AI health assistant is temporarily unavailable. Please consult your physician or pharmacist.");
}

export default {
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
          acceptedTerms = b.acceptedTerms !== undefined ? Boolean(b.acceptedTerms) : true;

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
            "INSERT INTO users (name,email,password_hash,role,patient_email,phone,dob,gender,emergency_contact,accepted_terms,accepted_terms_timestamp,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),NOW())",
            [name, email, passwordHash, role, patientEmail, b.phone || null, b.dob || null, b.gender || null, b.emergencyContact || null, acceptedTerms]
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
        const [rows] = await query<User[]>(env, "SELECT * FROM users WHERE email=? LIMIT 1", [email]);
        const user = rows[0];
        if (!user) return json({ message: "Invalid email or password" }, 401);
        const match = user.password_hash.startsWith("$2")
          ? await bcrypt.compare(password, user.password_hash)
          : password === user.password_hash;
        if (!match) return json({ message: "Invalid email or password" }, 401);
        if (!user.password_hash.startsWith("$2")) {
          user.password_hash = await bcrypt.hash(password, 10);
          await query(env, "UPDATE users SET password_hash=?,updated_at=NOW() WHERE id=?", [user.password_hash, user.id]);
        }
        return json(await loginBody(env, user));
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
        const { body: b } = await requestBody(request);
        let db: any = null;
        try {
          db = await getDbConnection(env);
          const [r] = await query<{ insertId: number }>(
            db,
            "INSERT INTO medications (user_id,name,dosage,instructions,start_date,end_date) VALUES (?,?,?,?,?,?)",
            [actor.id, b.name, b.dosage, b.instructions ?? null, b.startDate, b.endDate]
          );
          for (const time of Array.isArray(b.times) ? b.times : []) {
            await query(db, "INSERT INTO medication_times (medication_id,time_of_day) VALUES (?,?)", [r.insertId, time]);
          }
          await query(
            db,
            "INSERT INTO activities (user_id,type,message,related_entity_type,related_entity_id,created_at) VALUES (?,?,?,?,?,NOW())",
            [actor.id, "MEDICINE_ADDED", `Added new medication: ${b.name} (${b.dosage})`, "MEDICATION", r.insertId]
          );
          return plain("Medication added");
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
        // Accept client-supplied local date to avoid UTC timezone mismatch for users outside UTC.
        const clientDateParam = url.searchParams.get("date");
        const medsDateStr = (clientDateParam && /^\d{4}-\d{2}-\d{2}$/.test(clientDateParam))
          ? clientDateParam
          : new Date().toISOString().split("T")[0];
        const [rows] = await query<Json[]>(
          env,
          "SELECT m.*,JSON_ARRAYAGG(JSON_OBJECT('id',mt.id,'timeOfDay',TIME_FORMAT(mt.time_of_day,'%H:%i:%s'))) times FROM medications m LEFT JOIN medication_times mt ON mt.medication_id=m.id WHERE m.user_id=? AND m.start_date<=? AND m.end_date>=? GROUP BY m.id",
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
      if (del && request.method === "DELETE") {
        let db: any = null;
        try {
          db = await getDbConnection(env);
          const [rows] = await query<Json[]>(db, "SELECT * FROM medications WHERE id=?", [del[1]]);
          if (!rows[0]) return new Response(null, { status: 404, headers: cors });
          if (Number(rows[0].user_id) !== actor.id) return plain("Access denied", 403);
          await query(db, "DELETE FROM intake_logs WHERE medication_id=?", [del[1]]);
          await query(db, "DELETE FROM medication_times WHERE medication_id=?", [del[1]]);
          await query(db, "DELETE FROM medications WHERE id=?", [del[1]]);
          return new Response(null, { status: 204, headers: cors });
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

        // Accept client-supplied local date to avoid UTC timezone mismatch for users outside UTC.
        const clientDateParam = url.searchParams.get("date");
        const todayStr = (clientDateParam && /^\d{4}-\d{2}-\d{2}$/.test(clientDateParam))
          ? clientDateParam
          : new Date().toISOString().split("T")[0];

        const [meds] = await query<Json[]>(
          env,
          "SELECT m.id AS med_id, m.name AS med_name, m.dosage, mt.time_of_day FROM medications m JOIN medication_times mt ON mt.medication_id=m.id WHERE m.user_id=? AND m.start_date<=? AND m.end_date>=?",
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

        // isPast: date is now client-supplied (correct for user's timezone).
        // For the time portion we use UTC hours/minutes from the server since we
        // don't receive a timezone offset from the client. This is display-only.
        const now = new Date();
        const currentHours = now.getUTCHours();
        const currentMins = now.getUTCMinutes();

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
        let db: any = null;
        try {
          db = await getDbConnection(env);
          const [medRows] = await query<Json[]>(db, "SELECT * FROM medications WHERE id=? LIMIT 1", [b.medicationId]);
          const med = medRows[0];
          if (!med) return json({ message: "Medication not found" }, 400);

          const [existing] = await query<Json[]>(
            db,
            "SELECT id FROM intake_logs WHERE marker_user_id=? AND medication_id=? AND date=? AND TIME_FORMAT(time,'%H:%i')=? LIMIT 1",
            [actor.id, b.medicationId, b.date, String(b.time).substring(0, 5)]
          );

          let logId: number;
          if (existing.length > 0) {
            logId = existing[0].id;
            await query(
              db,
              "UPDATE intake_logs SET status=?, taken_time=IF(?='TAKEN',NOW(),NULL), missed_time=IF(?='MISSED',NOW(),NULL), updated_at=NOW() WHERE id=?",
              [status, status, status, logId]
            );
          } else {
            const [insertRes] = await query<{ insertId: number }>(
              db,
              "INSERT INTO intake_logs (marker_user_id,medication_id,date,time,status,scheduled_time,taken_time,missed_time,created_at,updated_at) VALUES (?,?,?,?,?,CONCAT(?,' ',?),IF(?='TAKEN',NOW(),NULL),IF(?='MISSED',NOW(),NULL),NOW(),NOW())",
              [actor.id, b.medicationId, b.date, b.time, status, b.date, b.time, status, status]
            );
            logId = insertRes.insertId;
          }

          const activityMsg =
            status === "TAKEN"
              ? `Took ${med.name} (${med.dosage}) at ${String(b.time).substring(0, 5)}`
              : `Missed ${med.name} (${med.dosage}) scheduled for ${String(b.time).substring(0, 5)}`;
          await query(
            db,
            "INSERT INTO activities (user_id,type,message,related_entity_type,related_entity_id,created_at) VALUES (?,?,?,?,?,NOW())",
            [actor.id, status === "TAKEN" ? "DOSE_TAKEN" : "DOSE_MISSED", activityMsg, "INTAKE_LOG", logId]
          );

          return json({ success: true, logId });
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
            const [existing] = await query<Json[]>(
              db,
              "SELECT id FROM intake_logs WHERE marker_user_id=? AND medication_id=? AND date=? AND TIME_FORMAT(time,'%H:%i')=? LIMIT 1",
              [actor.id, req.medicationId, req.date, String(req.time).substring(0, 5)]
            );
            if (existing.length === 0) {
              const [ins] = await query<{ insertId: number }>(
                db,
                "INSERT INTO intake_logs (marker_user_id,medication_id,date,time,status,scheduled_time,missed_time,created_at,updated_at) VALUES (?,?,?,?,'MISSED',CONCAT(?,' ',?),NOW(),NOW(),NOW())",
                [actor.id, req.medicationId, req.date, req.time, req.date, req.time]
              );
              created++;
            }
          }
          return json({ created });
        } finally {
          if (db) await db.end();
        }
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
        const safeDaysSub = Math.max(0, days - 1);

        const [logCounts] = await query<Json[]>(
          env,
          `SELECT DATE_FORMAT(date,'%Y-%m-%d') AS day_str, SUM(status='TAKEN') AS taken, SUM(status='MISSED') AS missed FROM intake_logs WHERE marker_user_id=? AND date>=DATE_SUB(CURDATE(), INTERVAL ${safeDaysSub} DAY) GROUP BY day_str`,
          [target.id]
        );

        const countMap = new Map<string, { taken: number; missed: number }>();
        for (const c of logCounts) {
          countMap.set(c.day_str, { taken: Number(c.taken || 0), missed: Number(c.missed || 0) });
        }

        const result: Array<{ date: string; taken: number; missed: number }> = [];
        const today = new Date();
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date(today);
          d.setDate(today.getDate() - i);
          const dStr = d.toISOString().split("T")[0];
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
        const safeDaysSub = Math.max(0, days - 1);
        const filter = days > 0 ? `AND date>=DATE_SUB(CURDATE(), INTERVAL ${safeDaysSub} DAY)` : "";
        const params = [target.id];

        const [counts] = await query<Json[]>(
          env,
          `SELECT 
             COUNT(*) AS total,
             SUM(status='TAKEN') AS taken,
             SUM(status='MISSED') AS missed,
             SUM(date=CURDATE() AND status='MISSED') AS missedToday,
             SUM(date>=DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND status='MISSED') AS missedThisWeek,
             SUM(date>=DATE_SUB(CURDATE(), INTERVAL 29 DAY) AND status='MISSED') AS missedThisMonth
           FROM intake_logs WHERE marker_user_id=? ${filter}`,
          params
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
          return json({ ...safe, dob: dobStr, patientEmail: target.patient_email, emergencyContact: target.emergency_contact, acceptedTerms: Boolean(target.accepted_terms) });
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
          return json({ ...safe, dob: dobStr, patientEmail: safe.patient_email, emergencyContact: safe.emergency_contact, acceptedTerms: Boolean(safe.accepted_terms) });
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
  }
};
