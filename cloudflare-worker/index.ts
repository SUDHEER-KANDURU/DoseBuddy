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
    timezone: "Z"
  })) as any;
}

async function query<T = Json[]>(
  envOrConn: Env | any,
  statement: string,
  values: unknown[] = []
): Promise<[T, unknown]> {
  if (envOrConn && typeof envOrConn.query === "function") {
    return (await envOrConn.query(statement, values)) as [T, unknown];
  }
  const db = await getDbConnection(envOrConn as Env);
  try {
    return (await db.query(statement, values)) as [T, unknown];
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
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    patientEmail: user.patient_email,
    phone: user.phone,
    dob: user.dob,
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

async function callAi(env: Env, prompt: string) {
  if (!env.GROQ_API_KEY) return json({ message: "AI service is not configured" }, 503);
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env.GROQ_MODEL || "openai/gpt-oss-20b", messages: [{ role: "user", content: prompt }] })
  });
  if (!r.ok) return json({ message: "AI service is temporarily unavailable" }, 502);
  const data = await r.json<Json>();
  return plain(String(data.choices?.[0]?.message?.content ?? ""));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url),
      path = url.pathname;

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
        return callAi(env, `Provide concise medication information and safety guidance for: ${url.searchParams.get("name") || ""}`);
      }

      if (path === "/api/medicine/symptom-check" && request.method === "POST") {
        const { body: b } = await requestBody(request);
        return callAi(env, `Give safe, non-diagnostic guidance for these symptoms: ${String(b.symptoms ?? "")}`);
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
        const [rows] = await query<Json[]>(
          env,
          "SELECT m.*,JSON_ARRAYAGG(JSON_OBJECT('id',mt.id,'timeOfDay',TIME_FORMAT(mt.time_of_day,'%H:%i:%s'))) times FROM medications m LEFT JOIN medication_times mt ON mt.medication_id=m.id WHERE m.user_id=? AND m.start_date<=CURDATE() AND m.end_date>=CURDATE() GROUP BY m.id",
          [target.id]
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

        const [meds] = await query<Json[]>(
          env,
          "SELECT m.id AS med_id, m.name AS med_name, m.dosage, mt.time_of_day FROM medications m JOIN medication_times mt ON mt.medication_id=m.id WHERE m.user_id=? AND m.start_date<=CURDATE() AND m.end_date>=CURDATE()",
          [target.id]
        );
        const [logs] = await query<Json[]>(
          env,
          "SELECT id, medication_id, DATE_FORMAT(date,'%Y-%m-%d') AS date, TIME_FORMAT(time,'%H:%i') AS time, status FROM intake_logs WHERE marker_user_id=? AND date=CURDATE()",
          [target.id]
        );

        const logMap = new Map<string, Json>();
        for (const l of logs) {
          logMap.set(`${l.medication_id}_${l.time}`, l);
        }

        const now = new Date();
        const currentHours = now.getHours();
        const currentMins = now.getMinutes();

        const todayStr = now.toISOString().split("T")[0];
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

        const [logCounts] = await query<Json[]>(
          env,
          "SELECT DATE_FORMAT(date,'%Y-%m-%d') AS day_str, SUM(status='TAKEN') AS taken, SUM(status='MISSED') AS missed FROM intake_logs WHERE marker_user_id=? AND date>=DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY day_str",
          [target.id, days - 1]
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

        const days = parseInt(url.searchParams.get("days") || "0", 10);
        const filter = days > 0 ? "AND date>=DATE_SUB(CURDATE(), INTERVAL ? DAY)" : "";
        const params = days > 0 ? [target.id, days - 1] : [target.id];

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
        if (!rows[0]) return json({ message: "No BMI records found" }, 404);
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
        if (!rows[0]) return json({ message: "No vitals records found" }, 404);
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
          "SELECT * FROM vital_records WHERE user_id=? AND recorded_at>=DATE_SUB(NOW(), INTERVAL ? DAY) ORDER BY recorded_at ASC",
          [target.id, days]
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
          return json({ ...safe, patientEmail: target.patient_email, emergencyContact: target.emergency_contact, acceptedTerms: Boolean(target.accepted_terms) });
        }
        if (request.method === "PUT") {
          const { body: b } = await requestBody(request);
          await query(
            env,
            "UPDATE users SET name=?,phone=?,dob=?,gender=?,emergency_contact=?,updated_at=NOW() WHERE id=?",
            [b.name ?? target.name, b.phone ?? null, b.dob ?? null, b.gender ?? null, b.emergencyContact ?? null, target.id]
          );
          const { password_hash, ...safe } = (await getUser(env, target.id))!;
          return json(safe);
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
      console.error("DoseBuddy Worker error", e instanceof Error ? e.message : "unknown");
      return json({ message: "Internal server error" }, 500);
    }
  }
};
