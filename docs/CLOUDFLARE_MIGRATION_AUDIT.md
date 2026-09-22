# DoseBuddy Cloudflare migration audit

Audit source: `DoseBuddy_Backend/src/main/java` and `DoseBuddy_frontend/app.js`, inspected 2026-09-22. This is a source audit, not a claim that every route has been ported.

## Existing contract

All `/api/**` routes except `/api/auth/**`, `/api/health`, and OPTIONS require `Authorization: Bearer <access JWT>`. Spring Security permits any origin and the methods GET, POST, PUT, DELETE, OPTIONS and PATCH. Errors are controller-specific: most use `{ "message": "..." }` for auth/validation; some legacy handlers return a plain string; unauthenticated/forbidden are 401/403.

JWT is HS256 via JJWT. `sub` is the email; access claims are `userId`, `role`, `type: "access"`, `iat`, `exp` (900 s); refresh claims are `userId`, `type: "refresh"`, `iat`, `exp` (604800 s). Passwords use BCrypt (with a one-time legacy plaintext upgrade on login). Auth response contains `id`, `name`, `email`, `role`, `patientEmail`, `phone`, `dob`, `gender`, `emergencyContact`, `acceptedTerms`, `accessToken`, `refreshToken`, and `expiresIn`.

| Route | Method | Request / query | Auth | Source tables / purpose | Frontend caller | Worker status |
|---|---|---|---|---|---|---|
| `/`, `/api/health` | GET | none | public | health response | deployment checks | ported |
| `/api/auth/signup` | POST | SignupRequest: name, email, password, role, patientEmail, phone, dob, gender, emergencyContact, acceptedTerms | public | `users`; creates account | `app.js` signup | ported |
| `/api/auth/login` | POST | email, password | public | `users`; BCrypt/legacy check | `app.js` login | ported |
| `/api/auth/refresh` | POST | refreshToken | public | `users`; issues new tokens | `app.js` refresh | ported |
| `/api/auth/verify-email`, `/resend-otp`, `/forgot-password`, `/reset-password` | POST | frontend calls these; no matching controller exists | public | none in audited source | `app.js` | **unimplemented upstream / not ported** |
| `/api/user/profile/{userId}` | GET, PUT | ProfileUpdateRequest (PUT) | access/caregiver access | `users` | `app.js` profile | ported |
| `/api/user/change-password/{userId}` | POST | ChangePasswordRequest | owner | `users` | `app.js` settings | ported |
| `/api/medications/add` | POST | AddMedicationRequest: name, dosage, instructions, startDate, endDate, times | access | `medications`, `medication_times`, `activities` | `app.js` add/prescription | ported |
| `/api/medications/today/{userId}` | GET | path id | owner/caregiver | `medications`, `medication_times` | dashboard | ported |
| `/api/medications/today-by-email/{email}` | GET | path email | caregiver-aware | same | dashboard | ported |
| `/api/medications/{id}` | DELETE | path id | owner | `intake_logs`, `medication_times`, `medications` | dashboard | ported; transactional behavior remains to add |
| `/api/logs/mark`, `/mark-missed-batch` | POST | MarkDoseRequest / list | owner/caregiver | `intake_logs`, `activities`, `user_streaks` | dashboard/reminders | not ported |
| `/api/logs/history/{userId}`, `/today/{userId}` | GET | page/size as applicable | owner/caregiver | schedules plus `intake_logs` | dashboard/history | not ported |
| `/api/logs/summary/week/{userId}`, `/summary/{userId}`, `/adherence/stats/{userId}` | GET | days where applicable | owner/caregiver | schedules and intake data | reports | not ported |
| `/api/activities/recent/{userId}`, `/all/{userId}`, `/type/{userId}/{type}`, `/since/{userId}`, `/count/{userId}` | GET | limit, since where applicable | owner/caregiver | `activities` | dashboard | not ported |
| `/api/activities/log` | POST | type/message/user/related fields | access | `activities` | no current frontend call found | not ported |
| `/api/activities/clear/{userId}` | DELETE | path id | owner/caregiver | `activities` | no current frontend call found | not ported |
| `/api/bmi/calculate`, `/latest/{userId}`, `/history/{userId}`, `/recent/{userId}` | POST / GET | BmiCalculationRequest; `limit` | owner/caregiver | `bmi_records` | analytics | not ported |
| `/api/vitals/add`, `/latest/{userId}`, `/history/{userId}`, `/recent/{userId}`, `/trend/{userId}`, `/{id}` | POST / GET / DELETE | VitalRecordRequest; `limit`, `period` | owner/caregiver | `vital_records` | vitals/analytics | not ported |
| `/api/streaks/{userId}`, `/recalculate/{userId}` | GET / POST | path id | owner/caregiver | `user_streaks`, schedules/logs | reports | not ported |
| `/api/medicine/ai-info` | GET | name, optional userId | access | Groq → fallback Groq/Gemini | AI panel | Groq primary ported; Gemini fallback pending |
| `/api/medicine/symptom-check` | POST | `{ symptoms }` | access | Groq → fallback Groq/Gemini | AI panel | Groq primary ported; Gemini fallback pending |
| `/api/prescription/upload` | POST multipart | file, optional userId | access | Gemini vision/OCR; PDFBox/POI/Groq | prescription panel | not ported |

## Database model and logic

The audited JPA entities use these unchanged tables: `users`, `medications`, `medication_times`, `intake_logs`, `activities`, `bmi_records`, `vital_records`, and `user_streaks`. The Worker uses parameterized MySQL statements through `env.HYPERDRIVE`; it does not create, alter, or migrate tables.

Notable source behavior still requiring careful parity work: scheduled-dose expansion computes pending/missed doses from active medication times; every intake update recalculates streaks and logs an activity; caregivers may access only the patient email linked on their own account; all reporting derives from that schedule expansion rather than only persisted intake rows.

## External and incompatible features

| Existing feature | Why it cannot be directly copied | Smallest Worker-compatible replacement |
|---|---|---|
| Spring `@Scheduled` missed-dose task (every 5 min) | Workers do not keep a process alive | Cloudflare Cron Trigger invoking a secured internal scheduled route; add only after the scheduled-dose logic is ported |
| PDFBox and Apache POI local parsing | Java libraries/server runtime cannot run in Worker | Client-side extraction where appropriate, or an HTTPS extraction service; preserve privacy review before adding one |
| Multipart prescription image OCR | Current code buffers file and invokes Gemini | Use Worker FormData and Gemini REST vision; persist file only in R2 if retention is required (R2 is optional, not yet configured) |
| Groq/Gemini Java calls | Java SDK/runtime unavailable | Worker `fetch` with `GROQ_API_KEY` / `GEMINI_API_KEY` secrets |
| Render local server / Docker | explicitly out of scope | Worker + Hyperdrive; no Containers or Durable Objects |
| Email via Brevo HTTP | not a Worker incompatibility | direct HTTPS Brevo call with a `BREVO_API_KEY` secret, isolated so failure does not break medication APIs |

## Verification checklist

Before switching Netlify, test every row above against Render and the Worker with the same fixture account: route/method, CORS, status, JSON shape, auth, caregiver authorization, database side effect, invalid input, invalid JWT, and DB failure. Particular acceptance tests: registration, login and token refresh; patient/caregiver medication reads; medication CRUD; marking and automatic misses; dashboard/reports/adherence/streaks; BMI/vitals; both AI paths; prescriptions; and OPTIONS preflight.

## Deployment prerequisites

Create a Hyperdrive configuration pointing to the existing Aiven MySQL database, replace `<HYPERDRIVE_ID>` in `wrangler.jsonc`, then configure Worker secrets: `JWT_SECRET`, `GROQ_API_KEY`, `GEMINI_API_KEY` (and `BREVO_API_KEY` only when email is ported). `GROQ_MODEL` and `GEMINI_MODEL` may be Worker vars/secrets. Do not change `app.js` to a Cloudflare URL until the unported frontend routes are complete and tested.
