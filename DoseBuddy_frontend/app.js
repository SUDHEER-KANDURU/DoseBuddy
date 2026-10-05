const API_BASE_URL = (window.APP_CONFIG && window.APP_CONFIG.apiBaseUrl)
    ? window.APP_CONFIG.apiBaseUrl
    : "https://dosebuddy.sudheerkanduru-5588.workers.dev";
const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase)
    ? window.APP_CONFIG.apiBase
    : `${API_BASE_URL}/api`;
const LS_CURRENT_USER_KEY = "dosebuddy_current_user";

const LS_ACCESS_TOKEN_KEY  = "dosebuddy_access_token";
const LS_REFRESH_TOKEN_KEY = "dosebuddy_refresh_token";
const LS_TOKEN_EXPIRES_KEY = "dosebuddy_token_expires"; // epoch ms

/** Store tokens after login/signup/refresh */
function storeTokens(accessToken, refreshToken, expiresInSeconds) {
    localStorage.setItem(LS_ACCESS_TOKEN_KEY,  accessToken);
    localStorage.setItem(LS_REFRESH_TOKEN_KEY, refreshToken);
    // Record absolute expiry time (subtract 30 s buffer for early refresh)
    const expiresAt = Date.now() + (expiresInSeconds - 30) * 1000;
    localStorage.setItem(LS_TOKEN_EXPIRES_KEY, String(expiresAt));
}

/** Clear all auth tokens (called on logout) */
function clearTokens() {
    localStorage.removeItem(LS_ACCESS_TOKEN_KEY);
    localStorage.removeItem(LS_REFRESH_TOKEN_KEY);
    localStorage.removeItem(LS_TOKEN_EXPIRES_KEY);
}

function getAccessToken()  { return localStorage.getItem(LS_ACCESS_TOKEN_KEY); }
function getRefreshToken() { return localStorage.getItem(LS_REFRESH_TOKEN_KEY); }

function isAccessTokenExpired() {
    const expiresAt = parseInt(localStorage.getItem(LS_TOKEN_EXPIRES_KEY) || "0", 10);
    return Date.now() >= expiresAt;
}

// In-flight refresh promise — prevents parallel refresh races
let _refreshPromise = null;

/**
 * Attempt to get a fresh access token using the refresh token.
 * Returns the new access token string, or null if refresh fails.
 */
async function refreshAccessToken() {
    if (_refreshPromise) return _refreshPromise;

    const refreshToken = getRefreshToken();
    if (!refreshToken) return null;

    _refreshPromise = (async () => {
        try {
            const res = await fetch(`${API_BASE}/auth/refresh`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ refreshToken })
            });

            if (!res.ok) {
                // Refresh token is invalid/expired — force logout
                _handleAuthExpiry();
                return null;
            }

            const data = await res.json();
            storeTokens(data.accessToken, data.refreshToken, data.expiresIn);
            return data.accessToken;
        } catch (err) {
            console.error("[Auth] Token refresh failed:", err);
            return null;
        } finally {
            _refreshPromise = null;
        }
    })();

    return _refreshPromise;
}

async function authFetch(url, options = {}) {
    // Refresh proactively if the token is about to expire
    if (isAccessTokenExpired()) {
        const newToken = await refreshAccessToken();
        if (!newToken) {
            _handleAuthExpiry();
            throw new Error("Session expired. Please log in again.");
        }
    }

    const token = getAccessToken();
    const headers = {
        ...(options.headers || {}),
        ...(token ? { "Authorization": `Bearer ${token}` } : {})
    };

    const fetchOptions = { cache: "no-store", ...options, headers };
    let response = await fetch(url, fetchOptions);

    if (response.status === 401) {
        const newToken = await refreshAccessToken();
        if (!newToken) {
            _handleAuthExpiry();
            throw new Error("Session expired. Please log in again.");
        }
        const retryHeaders = { ...headers, "Authorization": `Bearer ${newToken}` };
        response = await fetch(url, { cache: "no-store", ...options, headers: retryHeaders });
    }

    return response;
}

const _jsonCache = new Map();
const _jsonInflight = new Map();

async function fetchJsonCached(url, ttlMs = 15000) {
    const cached = _jsonCache.get(url);
    if (cached && Date.now() - cached.at < ttlMs) return cached.data;
    if (_jsonInflight.has(url)) return _jsonInflight.get(url);

    const request = authFetch(url)
        .then(async res => {
            if (res.status === 404) {
                // Expected empty state for optional resources (e.g. /bmi/latest/:id before first calculation)
                const emptyData = null;
                _jsonCache.set(url, { data: emptyData, at: Date.now() });
                return emptyData;
            }
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            const data = await res.json();
            _jsonCache.set(url, { data, at: Date.now() });
            return data;
        })
        .finally(() => _jsonInflight.delete(url));
    _jsonInflight.set(url, request);
    return request;
}

function invalidateDataCache(...fragments) {
    for (const key of _jsonCache.keys()) {
        if (fragments.some(fragment => key.includes(fragment))) _jsonCache.delete(key);
    }
}

/** Called when refresh token is expired or invalid — logs the user out */
function _handleAuthExpiry() {
    // Guard: only fire the expiry flow if we actually have a session to expire.
    // Prevents false "session expired" toasts during the signup/login flow
    // before currentUser has been fully committed.
    const hadSession = !!currentUser;
    clearTokens();
    currentUser = null;
    saveToLS(LS_CURRENT_USER_KEY, null);
    showAuthView();
    if (hadSession) {
        showToast("Your session has expired. Please log in again.", "warning", 5000);
    }
}

let currentUser = null;
let logs = [];
let medsCache = [];
let medsCacheDate = null;
let _dashboardRenderId = 0;
let _historyRenderId = 0;
let _reportsRenderId = 0;
let _profileFetchedAt = 0;
// ─── Notification deduplication ──────────────────────────────────────────────
// firedReminderKeys   – Set of "userId-medId-YYYY-MM-DD-HH:MM" strings.
//   • Added when triggerDoseNotification fires (medicine-reminder event).
//   • Cleared only on logout or on a genuine calendar-day change.
//   • NEVER cleared just because renderDashboard() ran again.
//
// firedMissedAlertKeys – Set of "missed-userId-medId-YYYY-MM-DD-HH:MM" strings.
//   • Added when the PENDING→MISSED transition sound fires.
//   • Guarantees the missed-dose alert sound plays exactly ONCE per dose per session.
//   • Cleared on logout alongside firedReminderKeys.
//
// _lastScheduledDate – the calendar date string that was current the last time
//   scheduleMedicineReminders() built its timeout list.  Starts as "" (empty
//   string) so the first call does NOT trigger the new-day branch.
const firedReminderKeys    = new Set();
const firedMissedAlertKeys = new Set();
let _lastScheduledDate = "";   // "" means "never scheduled yet"
let _reminderIntervalId = null; // interval ID for checkReminders — cleared on logout
let _lastCheckRemindersLog = 0; // throttle for checkReminders diagnostic log
let weeklyChart = null;

const ACTIVITY_TYPES = {
    MEDICINE_ADDED:        { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/></svg>`, dot: "activity-dot-added",    badge: "badge-blue",   label: "Medicine Added"    },
    DOSE_TAKEN:            { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`, dot: "activity-dot-taken",    badge: "badge-green",  label: "Dose Taken"        },
    DOSE_MISSED:           { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>`, dot: "activity-dot-missed",   badge: "badge-red",    label: "Missed Dose"       },
    DOSE_SCHEDULED:        { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.253M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"/></svg>`, dot: "activity-dot-pending",  badge: "badge-blue",   label: "Dose Scheduled"    },
    BMI_CALCULATED:        { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/></svg>`, dot: "activity-dot-bmi",      badge: "badge-purple", label: "BMI Updated"       },
    SYMPTOM_CHECK:         { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"/></svg>`, dot: "activity-dot-symptom",  badge: "badge-orange", label: "Symptom Check"     },
    AI_MEDICINE_INFO:      { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>`, dot: "activity-dot-ai",       badge: "badge-purple", label: "Medicine Search"   },
    PROFILE_UPDATED:       { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>`, dot: "activity-dot-profile",  badge: "badge-blue",   label: "Profile Updated"   },
    MEDICINE_DELETED:      { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>`, dot: "activity-dot-missed",   badge: "badge-red",    label: "Medicine Removed"  },
    PASSWORD_CHANGED:      { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>`, dot: "activity-dot-profile",  badge: "badge-green",  label: "Security Update"   },
    PRESCRIPTION_UPLOADED: { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg>`, dot: "activity-dot-added",    badge: "badge-blue",   label: "Prescription"      },
    VITALS_LOGGED:         { icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M3 12h2l2-7 3 14 3-10 2 3h6"/></svg>`, dot: "activity-dot-bmi",      badge: "badge-green",  label: "Vitals Logged"     },
};

function formatActivityTime(dateTimeStr) {
    const ts = new Date(dateTimeStr).getTime();
    const now = Date.now();
    const diff = now - ts;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function getActivityDateGroup(dateTimeStr) {
    const d = new Date(dateTimeStr);
    const today = new Date();
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yest.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

async function renderRecentActivity() {
    const container = document.getElementById("recent-activity-list");
    if (!container || !currentUser) return;

    try {
        const response = await authFetch(`${API_BASE}/activities/recent/${currentUser.id}?limit=10`);
        if (!response.ok) {
            throw new Error("Failed to fetch activities");
        }

        const activities = await response.json();

        if (!activities || activities.length === 0) {
            container.innerHTML = `
                <div class="activity-empty">
                    <p class="activity-empty-text">No activity yet. Start by adding a medicine or marking a dose.</p>
                </div>`;
            return;
        }

        let html = "";
        let lastGroup = null;

        activities.forEach(activity => {
            const def = ACTIVITY_TYPES[activity.type] || ACTIVITY_TYPES.DOSE_TAKEN;
            const group = getActivityDateGroup(activity.createdAt);

            if (group !== lastGroup) {
                html += `<div class="activity-date-group">${group}</div>`;
                lastGroup = group;
            }

            const clickable = activity.relatedEntityType ? "activity-item--clickable" : "";
            const viewAttr = getViewForEntityType(activity.relatedEntityType);
            const navAttr = viewAttr ? `data-view="${viewAttr}" role="button" tabindex="0"` : "";

            html += `
                <div class="activity-item ${clickable}" ${navAttr}>
                    <div class="activity-icon-wrap ${def.dot}">
                        <span class="activity-icon-svg" aria-hidden="true">${def.icon}</span>
                    </div>
                    <div class="activity-info">
                        <div class="activity-name">${activity.message}</div>
                        <div class="activity-meta">
                            <span class="activity-type-badge ${def.badge}">${def.label}</span>
                        </div>
                    </div>
                    <div class="activity-time" title="${new Date(activity.createdAt).toLocaleString()}">${formatActivityTime(activity.createdAt)}</div>
                </div>`;
        });

        container.innerHTML = html;

        container.querySelectorAll(".activity-item--clickable").forEach(item => {
            const handler = () => {
                const viewId = item.dataset.view;
                if (!viewId) return;
                switchView(viewId);
                document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
                document.querySelector(`.nav-btn[data-view="${viewId}"]`)?.classList.add("active");
            };
            item.addEventListener("click", handler);
            item.addEventListener("keydown", e => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handler();
                }
            });
        });

    } catch (error) {
        console.error("Error loading activities:", error);
        container.innerHTML = `
            <div class="activity-empty">
                <p class="activity-empty-text">Unable to load activity feed. Please try again later.</p>
            </div>`;
    }
}

async function refreshActivityFeed() {
    await renderRecentActivity();
}

function getViewForEntityType(entityType) {
    const mapping = {
        "MEDICATION": "medicines-view",
        "INTAKE_LOG": "history-view",
        "BMI_RECORD": "bmi-view",
        "USER": "profile-view",
        "PRESCRIPTION": "prescriptions-view"
    };
    return mapping[entityType] || null;
}

function logActivity(type, message, meta) {
}

async function logMissedDoseActivities(meds, todayStr) {
    if (!currentUser || !Array.isArray(meds)) return;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const missedEntries = [];

    meds.forEach(med => {
        if (!Array.isArray(med.times)) return;
        med.times.forEach(timeObj => {
            const timeStr = (timeObj.timeOfDay || "").substring(0, 5);
            if (!timeStr) return;
            const [h, m] = timeStr.split(":").map(Number);
            const doseMinutes = h * 60 + m;
            if (nowMinutes - doseMinutes > 5) {
                const status = getDoseStatus(currentUser.id, med.id, todayStr, timeStr);
                if (status !== "TAKEN" && status !== "MISSED") {
                    missedEntries.push({
                        userId: currentUser.id,
                        medicationId: med.id,
                        date: todayStr,
                        time: timeStr
                    });
                }
            }
        });
    });

    if (missedEntries.length === 0) return;

    try {
        await authFetch(`${API_BASE}/logs/mark-missed-batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(missedEntries),
        });
    } catch (err) {
        console.error("logMissedDoseActivities error:", err);
    }
}

let scheduledTimeouts  = [];   // reminder-fire timeouts — cleared on reschedule
let activeMissTimeouts = [];   // 5-min miss-window timers — NOT cleared on reschedule
let activeReminderAudio = null;
let audioUnlocked = false; // tracks whether browser autoplay has been unblocked


function showToast(message, type = "success", duration = 3000) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", "alert");

    const icons = {
        success: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
        error:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>`,
        warning: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z"/></svg>`,
        info:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/></svg>`
    };

    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-message">${message}</span>
        <button class="toast-close" aria-label="Dismiss">&times;</button>
    `;

    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("toast-visible"));

    const dismiss = () => {
        toast.classList.remove("toast-visible");
        toast.classList.add("toast-hiding");
        setTimeout(() => toast.remove(), 300);
    };

    toast.querySelector(".toast-close").addEventListener("click", dismiss);
    setTimeout(dismiss, duration);
}

document.addEventListener("DOMContentLoaded", () => {
    currentUser = loadFromLS(LS_CURRENT_USER_KEY, null);

    // ── JWT session guard ────────────────────────────────────────────────────
    // A returning user is only considered authenticated if we also have a valid
    // refresh token stored. If the refresh token is missing (cleared on logout
    // or by browser), treat them as logged-out even if the user object is cached.
    if (currentUser && !getRefreshToken()) {
        currentUser = null;
        saveToLS(LS_CURRENT_USER_KEY, null);
    }

    // ── Audio unlock ────────────────────────────────────────────────────────
    // Browsers block audio until the user has interacted with the page.
    // We listen on genuine user-activation events ONLY (NOT scroll) and prime
    // the audio element via a muted play() on the first interaction.  After
    // that, reminder/missed-dose sounds work from setTimeout without being
    // blocked.  See primeAudioElement() for the priming logic.
    function unlockAudio() {
        primeAudioElement();
    }

    ["click", "pointerdown", "touchstart", "keydown"].forEach(evt =>
        document.addEventListener(evt, unlockAudio, { once: false, passive: true })
    );
    setupAuthView();
    setupNav();
    setupMedicineForm();
    setupAiHandlers();
    setupBmiCalculator();
    setupVitals();
    setupHamburgerMenu();
    setupThemeFromStorage();
    setupNotificationsUI();
    setupPrescriptionUpload();
    
    setHamburgerVisible(!!currentUser);

    
    // ── Notification permission: never auto-request on load ─────────────────
    // Modern browsers require a user gesture before showing the permission
    // dialog. Auto-requesting on load is silently ignored or blocked.
    // Instead, we show a non-intrusive banner and let the user opt in.
    if ("Notification" in window) {
        if (Notification.permission === "default") {
            showNotifPermissionBanner();
        }
    }

    if (currentUser) {
        showAppViews();
        switchView("dashboard-view");
        setThemeToggleVisible(true);
        fetchFullProfile(currentUser.id).then(fresh => {
            if (fresh) {
                currentUser = { ...currentUser, ...fresh };
                saveToLS(LS_CURRENT_USER_KEY, currentUser);
                updateUserMenuInfo();
                updateProfileDropdown();
            }
        });
        // Show permission banner for returning users (2 s delay so the page
        // renders first and the banner doesn't flash on load)
        if ("Notification" in window && Notification.permission === "default") {
            setTimeout(() => showNotifPermissionBanner(), 2000);
        }
    } else {
        showAuthView();
        setThemeToggleVisible(false);
    }
    _reminderIntervalId = setInterval(checkReminders, 30000);

    // ── Proactive token refresh ────────────────────────────────────────────
    // Every 60 seconds, check whether the access token is within 60 seconds
    // of expiry and silently refresh it.  This prevents any protected API call
    // from hitting a 401 due to an expired token mid-session.
    setInterval(async () => {
        if (!currentUser || !getRefreshToken()) return;
        if (isAccessTokenExpired()) {
            const newToken = await refreshAccessToken();
            if (!newToken) {
                // Refresh token has also expired — force logout
                _handleAuthExpiry();
            }
        }
    }, 60000);
});

window.addEventListener("beforeunload", () => {
    stopReminderAudio();
});

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        stopReminderAudio();
    }
});

function loadFromLS(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (e) {
        console.error("Error parsing localStorage key:", key, e);
        return fallback;
    }
}

function saveToLS(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function switchView(viewId) {

    // ── Route protection guard ──────────────────────────────────────────────
    // Protected views require an authenticated session (user object + valid
    // refresh token).  If either is missing, force the user to the login screen.
    const protectedViews = [
        "dashboard-view", "add-medicine-view", "reports-view",
        "history-view", "bmi-view", "vitals-view",
        "ai-view", "profile-view", "notifications-view"
    ];
    if (protectedViews.includes(viewId) && (!currentUser || !getRefreshToken())) {
        showAuthView();
        showToast("Please log in to access this page.", "warning", 3000);
        return;
    }

    stopReminderAudio();
    
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    const target = document.getElementById(viewId);
    if (target) target.classList.add("active");

    if (!currentUser) return;

    if (viewId === "dashboard-view") {
        renderDashboard();
    } else if (viewId === "history-view") {
        renderHistory();
    } else if (viewId === "reports-view") {
        renderReports();
    } else if (viewId === "vitals-view") {
        renderVitalsView();
    }
}

function showAuthView() {
    const authView = document.getElementById("auth-view");
    const appShell = document.getElementById("app-shell");

    if (authView) authView.classList.add("active");
    if (appShell) appShell.style.display = "none";

    // Auth view is strictly isolated to light theme
    document.body.classList.remove("dark-mode");

    const notif = document.querySelector(".notification-wrapper");
    if (notif) notif.style.display = "none";

    closeUserMenu();
    setHamburgerVisible(false);
    setThemeToggleVisible(false);

    const menu = document.getElementById("user-menu");
    if (menu) menu.style.display = "";
}

function showAppViews() {
    const authView = document.getElementById("auth-view");
    const appShell = document.getElementById("app-shell");

    if (authView) authView.classList.remove("active");
    if (appShell) appShell.style.display = "";  // let CSS grid handle it

    // Restore dashboard theme preference
    const stored = localStorage.getItem("theme");
    applyTheme(stored === "dark" ? "dark" : "light");

    const notif = document.querySelector(".notification-wrapper");
    if (notif) notif.style.display = "flex";

    updateUserMenuInfo();
    setHamburgerVisible(true);
    setThemeToggleVisible(true);
    updateProfileDropdown();
    setTimeout(startOnboarding, 800);

    const menu = document.getElementById("user-menu");
    if (menu) menu.style.display = "flex";
}

function setupAuthView() {
    // -- Tab switching (Login / Sign Up) ----------------------------------
    const tabs = document.querySelectorAll(".tab-btn");
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            const mode = tab.dataset.mode;
            if (mode === "login") {
                switchToLoginMode();
            } else {
                switchToSignupMode();
            }
        });
    });

    document.getElementById("go-signup-btn")?.addEventListener("click", () => {
        tabs.forEach(t => t.classList.toggle("active", t.dataset.mode === "signup"));
        switchToSignupMode();
    });
    document.getElementById("go-login-btn")?.addEventListener("click", () => {
        tabs.forEach(t => t.classList.toggle("active", t.dataset.mode === "login"));
        switchToLoginMode();
    });

    const loginForm = document.getElementById("login-form");
    loginForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        clearLoginErrors();
        const email = document.getElementById("auth-email").value.trim().toLowerCase();
        const password = document.getElementById("auth-password").value;
        const authError = document.getElementById("auth-error");

        let valid = true;
        if (!email || !email.includes("@")) {
            showFieldError("login-email-error", "Please enter a valid email address.");
            valid = false;
        }
        if (!password || password.length < 6) {
            showFieldError("login-pw-error", "Password must be at least 6 characters.");
            valid = false;
        }
        if (!valid) return;

        const btn = document.getElementById("auth-submit-btn");
        setButtonLoading(btn, true, "Signing in...");
        try {
            await handleLoginApi(email, password, authError);
        } catch (err) {
            console.error(err);
            if (authError) authError.textContent = "Something went wrong. Please try again.";
        } finally {
            setButtonLoading(btn, false, "Sign In");
        }
    });

    setupSignupSteps();

    setupOtpVerification();
    setupForgotPassword();

    setupLegalModals();

    const suDobInput = document.getElementById("su-dob");
    if (suDobInput) {
        suDobInput.max = new Date().toISOString().split("T")[0];
    }

    document.getElementById("su-password")?.addEventListener("input", (e) => {
        updatePasswordStrength(e.target.value, "su-pw-fill", "su-pw-label", "su-pw-strength");
        const confirmVal = document.getElementById("su-confirm-password")?.value;
        const confirmError = document.getElementById("su-confirm-error");
        if (confirmVal && confirmVal === e.target.value) {
            if (confirmError) { confirmError.textContent = ""; confirmError.classList.remove("visible"); }
        }
    });

    document.getElementById("su-confirm-password")?.addEventListener("input", (e) => {
        const pwVal = document.getElementById("su-password")?.value;
        const confirmError = document.getElementById("su-confirm-error");
        if (confirmError && pwVal && e.target.value === pwVal) {
            confirmError.textContent = "";
            confirmError.classList.remove("visible");
        }
    });
}

function switchToLoginMode() {
    document.getElementById("login-header").style.display = "block";
    document.getElementById("signup-header").style.display = "none";
    document.getElementById("login-form").style.display = "block";
    document.getElementById("signup-form").style.display = "none";
    document.getElementById("signup-switch-text").style.display = "none";
    document.getElementById("auth-error").textContent = "";

    const card = document.querySelector(".auth-card");
    if (card) card.classList.remove("auth-card-wide");
}

function switchToSignupMode() {
    document.getElementById("login-header").style.display = "none";
    document.getElementById("signup-header").style.display = "block";
    document.getElementById("login-form").style.display = "none";
    document.getElementById("signup-form").style.display = "block";
    document.getElementById("signup-switch-text").style.display = "block";
    
    const card = document.querySelector(".auth-card");
    if (card) card.classList.add("auth-card-wide");
    
    goToSignupStep(1);
}

function setupSignupSteps() {
    
    document.getElementById("step1-next-btn")?.addEventListener("click", () => {
        if (validateSignupStep1()) goToSignupStep(2);
    });

    document.getElementById("step2-next-btn")?.addEventListener("click", () => {
        if (validateSignupStep2()) goToSignupStep(3);
    });

    document.getElementById("step2-back-btn")?.addEventListener("click", () => goToSignupStep(1));
    document.getElementById("step3-back-btn")?.addEventListener("click", () => goToSignupStep(2));


    document.querySelectorAll(".role-card").forEach(card => {
        card.addEventListener("click", () => {
            document.querySelectorAll(".role-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            const role = card.dataset.role;
            document.getElementById("su-role").value = role;
            const patientGroup = document.getElementById("su-patient-email-group");
            if (patientGroup) {
                patientGroup.style.display = role === "CAREGIVER" ? "block" : "none";
            }
        });
    });


    document.querySelectorAll(".gender-card").forEach(card => {
        card.addEventListener("click", () => {
            document.querySelectorAll(".gender-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            document.getElementById("su-gender").value = card.dataset.value;
        });
    });


    const signupForm = document.getElementById("signup-form");
    signupForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!validateSignupStep3()) return;

        const signupError = document.getElementById("signup-error");
        const submitBtn = document.getElementById("signup-submit-btn");
        setButtonLoading(submitBtn, true, "Creating account...");

        try {
            const phoneCode = document.getElementById("su-phone-code")?.value || "";
            const phoneNum = document.getElementById("su-phone")?.value.trim() || "";
            const phone = phoneNum ? `${phoneCode}${phoneNum}` : "";

            const emergencyCode = document.getElementById("su-emergency-code")?.value || "";
            const emergencyNum = document.getElementById("su-emergency")?.value.trim() || "";
            const emergencyContact = emergencyNum ? `${emergencyCode}${emergencyNum}` : "";

            const body = {
                name: document.getElementById("su-name").value.trim(),
                email: document.getElementById("su-email").value.trim().toLowerCase(),
                password: document.getElementById("su-password").value,
                role: document.getElementById("su-role").value || "PATIENT",
                patientEmail: document.getElementById("su-patient-email")?.value.trim().toLowerCase() || null,
                phone,
                dob: normalizeDateInput(document.getElementById("su-dob")?.value),
                gender: document.getElementById("su-gender")?.value || "",
                emergencyContact,
                acceptedTerms: document.getElementById("su-terms")?.checked || false
            };

            await handleSignupApi(body, signupError);
        } catch (err) {
            console.error(err);
            if (signupError) signupError.textContent = "Something went wrong. Please try again.";
        } finally {
            setButtonLoading(submitBtn, false, "Create Account");
        }
    });

    setupIntlCountryPickers();
}

const INTL_COUNTRIES = [
    { name: "India", code: "IN", dial: "+91" },
    { name: "United States", code: "US", dial: "+1" },
    { name: "United Kingdom", code: "GB", dial: "+44" },
    { name: "Canada", code: "CA", dial: "+1" },
    { name: "Australia", code: "AU", dial: "+61" },
    { name: "United Arab Emirates", code: "AE", dial: "+971" },
    { name: "Singapore", code: "SG", dial: "+65" },
    { name: "Germany", code: "DE", dial: "+49" },
    { name: "France", code: "FR", dial: "+33" },
    { name: "Japan", code: "JP", dial: "+81" },
    { name: "China", code: "CN", dial: "+86" },
    { name: "Brazil", code: "BR", dial: "+55" },
    { name: "South Africa", code: "ZA", dial: "+27" },
    { name: "Malaysia", code: "MY", dial: "+60" },
    { name: "Pakistan", code: "PK", dial: "+92" },
    { name: "Bangladesh", code: "BD", dial: "+880" },
    { name: "Saudi Arabia", code: "SA", dial: "+966" },
    { name: "Qatar", code: "QA", dial: "+974" },
    { name: "Kuwait", code: "KW", dial: "+965" },
    { name: "Oman", code: "OM", dial: "+968" },
    { name: "Bahrain", code: "BH", dial: "+973" },
    { name: "Sri Lanka", code: "LK", dial: "+94" },
    { name: "Nepal", code: "NP", dial: "+977" },
    { name: "New Zealand", code: "NZ", dial: "+64" },
    { name: "Ireland", code: "IE", dial: "+353" },
    { name: "Italy", code: "IT", dial: "+39" },
    { name: "Spain", code: "ES", dial: "+34" },
    { name: "Netherlands", code: "NL", dial: "+31" },
    { name: "Switzerland", code: "CH", dial: "+41" },
    { name: "Sweden", code: "SE", dial: "+46" },
    { name: "Norway", code: "NO", dial: "+47" },
    { name: "Denmark", code: "DK", dial: "+45" },
    { name: "Finland", code: "FI", dial: "+358" },
    { name: "South Korea", code: "KR", dial: "+82" },
    { name: "Indonesia", code: "ID", dial: "+62" },
    { name: "Philippines", code: "PH", dial: "+63" },
    { name: "Thailand", code: "TH", dial: "+66" },
    { name: "Vietnam", code: "VN", dial: "+84" },
    { name: "Mexico", code: "MX", dial: "+52" },
    { name: "Argentina", code: "AR", dial: "+54" },
    { name: "Colombia", code: "CO", dial: "+57" },
    { name: "Chile", code: "CL", dial: "+56" },
    { name: "Peru", code: "PE", dial: "+51" },
    { name: "Egypt", code: "EG", dial: "+20" },
    { name: "Nigeria", code: "NG", dial: "+234" },
    { name: "Kenya", code: "KE", dial: "+254" },
    { name: "Ghana", code: "GH", dial: "+233" },
    { name: "Turkey", code: "TR", dial: "+90" },
    { name: "Greece", code: "GR", dial: "+30" },
    { name: "Portugal", code: "PT", dial: "+351" },
    { name: "Poland", code: "PL", dial: "+48" },
    { name: "Austria", code: "AT", dial: "+43" },
    { name: "Belgium", code: "BE", dial: "+32" },
    { name: "Czech Republic", code: "CZ", dial: "+420" },
    { name: "Hungary", code: "HU", dial: "+36" },
    { name: "Romania", code: "RO", dial: "+40" },
    { name: "Israel", code: "IL", dial: "+972" },
    { name: "Hong Kong", code: "HK", dial: "+852" },
    { name: "Taiwan", code: "TW", dial: "+886" },
    { name: "Afghanistan", code: "AF", dial: "+93" },
    { name: "Albania", code: "AL", dial: "+355" },
    { name: "Algeria", code: "DZ", dial: "+213" },
    { name: "Andorra", code: "AD", dial: "+376" },
    { name: "Angola", code: "AO", dial: "+244" },
    { name: "Armenia", code: "AM", dial: "+374" },
    { name: "Azerbaijan", code: "AZ", dial: "+994" },
    { name: "Bahamas", code: "BS", dial: "+1-242" },
    { name: "Barbados", code: "BB", dial: "+1-246" },
    { name: "Belarus", code: "BY", dial: "+375" },
    { name: "Belize", code: "BZ", dial: "+501" },
    { name: "Benin", code: "BJ", dial: "+229" },
    { name: "Bhutan", code: "BT", dial: "+975" },
    { name: "Bolivia", code: "BO", dial: "+591" },
    { name: "Bosnia and Herzegovina", code: "BA", dial: "+387" },
    { name: "Botswana", code: "BW", dial: "+267" },
    { name: "Brunei", code: "BN", dial: "+673" },
    { name: "Bulgaria", code: "BG", dial: "+359" },
    { name: "Cambodia", code: "KH", dial: "+855" },
    { name: "Cameroon", code: "CM", dial: "+237" },
    { name: "Costa Rica", code: "CR", dial: "+506" },
    { name: "Croatia", code: "HR", dial: "+385" },
    { name: "Cyprus", code: "CY", dial: "+357" },
    { name: "Ecuador", code: "EC", dial: "+593" },
    { name: "Estonia", code: "EE", dial: "+372" },
    { name: "Ethiopia", code: "ET", dial: "+251" },
    { name: "Fiji", code: "FJ", dial: "+679" },
    { name: "Georgia", code: "GE", dial: "+995" },
    { name: "Guatemala", code: "GT", dial: "+502" },
    { name: "Iceland", code: "IS", dial: "+354" },
    { name: "Jamaica", code: "JM", dial: "+1-876" },
    { name: "Jordan", code: "JO", dial: "+962" },
    { name: "Kazakhstan", code: "KZ", dial: "+7" },
    { name: "Latvia", code: "LV", dial: "+371" },
    { name: "Lebanon", code: "LB", dial: "+961" },
    { name: "Lithuania", code: "LT", dial: "+370" },
    { name: "Luxembourg", code: "LU", dial: "+352" },
    { name: "Maldives", code: "MV", dial: "+960" },
    { name: "Malta", code: "MT", dial: "+356" },
    { name: "Mauritius", code: "MU", dial: "+230" },
    { name: "Monaco", code: "MC", dial: "+377" },
    { name: "Morocco", code: "MA", dial: "+212" },
    { name: "Panama", code: "PA", dial: "+507" },
    { name: "Paraguay", code: "PY", dial: "+595" },
    { name: "Serbia", code: "RS", dial: "+381" },
    { name: "Slovakia", code: "SK", dial: "+421" },
    { name: "Slovenia", code: "SI", dial: "+386" },
    { name: "Tanzania", code: "TZ", dial: "+255" },
    { name: "Uganda", code: "UG", dial: "+256" },
    { name: "Ukraine", code: "UA", dial: "+380" },
    { name: "Uruguay", code: "UY", dial: "+598" },
    { name: "Uzbekistan", code: "UZ", dial: "+998" },
    { name: "Zimbabwe", code: "ZW", dial: "+263" }
];

function setupIntlCountryPickers() {
    const pickers = document.querySelectorAll(".intl-country-picker");
    if (pickers.length === 0) return;

    pickers.forEach(picker => {
        const targetId = picker.dataset.target;
        const hiddenInput = document.getElementById(targetId);
        const btn = picker.querySelector(".intl-picker-btn");
        const dropdown = picker.querySelector(".intl-dropdown-menu");
        const searchInput = picker.querySelector(".intl-search-input");
        const listContainer = picker.querySelector(".intl-country-list");

        if (!btn || !dropdown || !listContainer) return;

        let selectedCountry = INTL_COUNTRIES.find(c => c.code === "IN") || INTL_COUNTRIES[0];

        function getFlagImgUrl(code) {
            return `https://flagcdn.com/w40/${code.toLowerCase()}.png`;
        }

        function updateTrigger(c) {
            selectedCountry = c;
            if (hiddenInput) {
                hiddenInput.value = c.dial;
                hiddenInput.dataset.country = c.code;
            }
            const flagSpan = btn.querySelector(".intl-flag-icon");
            const codeSpan = btn.querySelector(".intl-picker-code");
            if (flagSpan) {
                flagSpan.innerHTML = `<img src="${getFlagImgUrl(c.code)}" alt="${c.name}" class="intl-flag-img" onerror="this.style.display='none';">`;
            }
            if (codeSpan) {
                codeSpan.textContent = `${c.code} ${c.dial}`;
            }
        }

        function renderList(filtered) {
            if (filtered.length === 0) {
                listContainer.innerHTML = `<div class="intl-no-results">No countries found</div>`;
                return;
            }

            listContainer.innerHTML = filtered.map((c, i) => {
                const isSelected = c.code === selectedCountry.code;
                return `
                    <div class="intl-country-item ${isSelected ? 'selected' : ''}" data-code="${c.code}" data-index="${i}" role="option" aria-selected="${isSelected}">
                        <span class="intl-flag-icon"><img src="${getFlagImgUrl(c.code)}" alt="${c.name}" class="intl-flag-img" onerror="this.style.display='none';"></span>
                        <span class="intl-country-name">${escapeHtml(c.name)}</span>
                        <span class="intl-country-dial">${c.dial}</span>
                    </div>
                `;
            }).join("");

            listContainer.querySelectorAll(".intl-country-item").forEach(item => {
                item.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const code = item.dataset.code;
                    const found = INTL_COUNTRIES.find(c => c.code === code);
                    if (found) {
                        updateTrigger(found);
                    }
                    closeDropdown();
                });
            });
        }

        function openDropdown() {
            document.querySelectorAll(".intl-dropdown-menu").forEach(d => {
                if (d !== dropdown) d.style.display = "none";
            });
            document.querySelectorAll(".intl-picker-btn").forEach(b => {
                if (b !== btn) b.setAttribute("aria-expanded", "false");
            });

            dropdown.style.display = "flex";
            btn.setAttribute("aria-expanded", "true");
            if (searchInput) {
                searchInput.value = "";
                renderList(INTL_COUNTRIES);
                setTimeout(() => searchInput.focus(), 50);
            }
        }

        function closeDropdown() {
            dropdown.style.display = "none";
            btn.setAttribute("aria-expanded", "false");
        }

        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dropdown.style.display === "flex") {
                closeDropdown();
            } else {
                openDropdown();
            }
        });

        if (searchInput) {
            searchInput.addEventListener("input", (e) => {
                const q = e.target.value.trim().toLowerCase();
                if (!q) {
                    renderList(INTL_COUNTRIES);
                    return;
                }
                const filtered = INTL_COUNTRIES.filter(c => 
                    c.name.toLowerCase().includes(q) || 
                    c.dial.toLowerCase().includes(q) || 
                    c.code.toLowerCase().includes(q)
                );
                renderList(filtered);
            });

            searchInput.addEventListener("keydown", (e) => {
                if (e.key === "Escape") {
                    closeDropdown();
                    btn.focus();
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    const firstItem = listContainer.querySelector(".intl-country-item");
                    if (firstItem) firstItem.click();
                }
            });
        }

        // Initialize default (India)
        updateTrigger(selectedCountry);
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".intl-country-picker")) {
            document.querySelectorAll(".intl-dropdown-menu").forEach(d => d.style.display = "none");
            document.querySelectorAll(".intl-picker-btn").forEach(b => b.setAttribute("aria-expanded", "false"));
        }
    });
}

function goToSignupStep(step) {
    // Update panels
    for (let i = 1; i <= 3; i++) {
        const panel = document.getElementById(`signup-step-${i}`);
        if (panel) panel.style.display = i === step ? "block" : "none";
    }
    document.querySelectorAll(".signup-step").forEach(el => {
        const s = parseInt(el.dataset.step);
        el.classList.toggle("active", s === step);
        el.classList.toggle("completed", s < step);
    });
}

function validateSignupStep1() {
    clearSignupErrors();
    let valid = true;
    const name = document.getElementById("su-name").value.trim();
    const email = document.getElementById("su-email").value.trim();
    const password = document.getElementById("su-password").value;
    const confirmPassword = document.getElementById("su-confirm-password") ? document.getElementById("su-confirm-password").value : "";

    if (!name || name.length < 2) {
        showFieldError("su-name-error", "Please enter your full name (at least 2 characters).");
        valid = false;
    }
    if (!email || !email.includes("@") || !email.includes(".")) {
        showFieldError("su-email-error", "Please enter a valid email address.");
        valid = false;
    }
    if (!password || password.length < 8) {
        showFieldError("su-pw-error", "Password must be at least 8 characters.");
        valid = false;
    }
    if (!confirmPassword) {
        showFieldError("su-confirm-error", "Please confirm your password.");
        valid = false;
    } else if (password !== confirmPassword) {
        showFieldError("su-confirm-error", "Passwords do not match.");
        valid = false;
    }
    return valid;
}

function validateSignupStep2() {
    clearSignupErrors();
    let valid = true;
    const phoneNum = document.getElementById("su-phone")?.value.trim() || "";
    const emergencyNum = document.getElementById("su-emergency")?.value.trim() || "";
    const dob = document.getElementById("su-dob")?.value || "";

    if (phoneNum && !/^\d{7,15}$/.test(phoneNum)) {
        showFieldError("su-phone-error", "Please enter a valid phone number (digits only, 7–15 digits).");
        valid = false;
    }

    if (emergencyNum && !/^\d{7,15}$/.test(emergencyNum)) {
        showFieldError("su-emergency-error", "Please enter a valid emergency contact number.");
        valid = false;
    }

    if (dob) {
        const dobDate = new Date(dob);
        const today = new Date();
        if (dobDate >= today) {
            showFieldError("su-dob-error", "Date of birth must be in the past.");
            valid = false;
        }
        const minDate = new Date();
        minDate.setFullYear(minDate.getFullYear() - 120);
        if (dobDate < minDate) {
            showFieldError("su-dob-error", "Please enter a valid date of birth.");
            valid = false;
        }
    }
    return valid;
}

function validateSignupStep3() {
    clearSignupErrors();
    let valid = true;
    const role = document.getElementById("su-role")?.value || "PATIENT";
    const patientEmail = document.getElementById("su-patient-email")?.value.trim() || "";
    const termsChecked = document.getElementById("su-terms")?.checked;

    if (role === "CAREGIVER") {
        if (!patientEmail || !patientEmail.includes("@")) {
            showFieldError("su-patient-email-error", "Please enter the patient's email address.");
            valid = false;
        }
    }
    if (!termsChecked) {
        showFieldError("su-terms-error", "You must accept the Terms & Conditions to continue.");
        valid = false;
    }
    return valid;
}

function showFieldError(id, message) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = message;
        el.classList.add("visible");
    }
}

function clearLoginErrors() {
    ["login-email-error", "login-pw-error", "auth-error"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = ""; el.classList.remove("visible"); }
    });
}

function clearSignupErrors() {
    ["su-name-error","su-email-error","su-pw-error","su-confirm-error","su-phone-error","su-dob-error",
     "su-emergency-error","su-patient-email-error","su-terms-error","signup-error"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = ""; el.classList.remove("visible"); }
    });
}

function setButtonLoading(btn, loading, text) {
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
        btn.dataset.originalHtml = btn.innerHTML;
        btn.innerHTML = `<span class="btn-spinner"></span>${text}`;
    } else {
        if (btn.dataset.originalHtml) {
            btn.innerHTML = btn.dataset.originalHtml;
        } else {
            btn.textContent = text;
        }
    }
}

function updatePasswordStrength(val, fillId, labelId, wrapId) {
    const wrap = document.getElementById(wrapId);
    const fill = document.getElementById(fillId);
    const lbl  = document.getElementById(labelId);
    if (!wrap || !fill || !lbl) return;

    if (!val) { wrap.style.display = "none"; lbl.textContent = ""; return; }
    wrap.style.display = "flex";

    let score = 0;
    if (val.length >= 8)          score++;
    if (/[A-Z]/.test(val))        score++;
    if (/[0-9]/.test(val))        score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;

    const levels = [
        { pct: "25%",  color: "#ef4444", label: "Weak"   },
        { pct: "50%",  color: "#f59e0b", label: "Fair"   },
        { pct: "75%",  color: "#00A19B", label: "Good"   },
        { pct: "100%", color: "#22c55e", label: "Strong" },
    ];
    const lvl = levels[Math.max(0, score - 1)];
    fill.style.width      = lvl.pct;
    fill.style.background = lvl.color;
    lbl.textContent       = lvl.label;
    lbl.style.color       = lvl.color;
}

function setupLegalModals() {
 
    document.getElementById("open-terms-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById("terms-modal").style.display = "flex";
        document.body.style.overflow = "hidden";
    });


    document.getElementById("open-privacy-signup-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById("privacy-signup-modal").style.display = "flex";
        document.body.style.overflow = "hidden";
    });

   
    document.getElementById("terms-modal-close")?.addEventListener("click", () => {
        document.getElementById("terms-modal").style.display = "none";
        document.body.style.overflow = "";
    });
    document.getElementById("terms-modal-accept-btn")?.addEventListener("click", () => {
        document.getElementById("terms-modal").style.display = "none";
        document.body.style.overflow = "";
        // Auto-check the terms checkbox
        const cb = document.getElementById("su-terms");
        if (cb) cb.checked = true;
        const errEl = document.getElementById("su-terms-error");
        if (errEl) { errEl.textContent = ""; errEl.classList.remove("visible"); }
    });

    document.getElementById("privacy-signup-modal-close")?.addEventListener("click", () => {
        document.getElementById("privacy-signup-modal").style.display = "none";
        document.body.style.overflow = "";
    });
    document.getElementById("privacy-signup-modal-accept-btn")?.addEventListener("click", () => {
        document.getElementById("privacy-signup-modal").style.display = "none";
        document.body.style.overflow = "";
    });

    ["terms-modal", "privacy-signup-modal"].forEach(id => {
        document.getElementById(id)?.addEventListener("click", (e) => {
            if (e.target.id === id) {
                e.target.style.display = "none";
                document.body.style.overflow = "";
            }
        });
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            ["terms-modal", "privacy-signup-modal"].forEach(id => {
                const el = document.getElementById(id);
                if (el && el.style.display !== "none") {
                    el.style.display = "none";
                    document.body.style.overflow = "";
                }
            });
        }
    });
}

async function handleSignupApi(body, errorElem) {
    try {
        const res = await fetch(`${API_BASE}/auth/signup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            if (errorElem) errorElem.textContent = data.message || "Signup failed.";
            return;
        }

        // If the backend requires email verification (OTP)
        if (data.requiresVerification) {
            showOtpVerificationForm(data.email || body.email);
            return;
        }

        if (data.accessToken && data.refreshToken) {
            completeLoginFromResponse(data);
        } else {
            if (errorElem) errorElem.textContent = data.message || "Signup succeeded, but session tokens were missing.";
        }
    } catch (err) {
        console.error("[Signup] Request failed:", err);
        if (errorElem) errorElem.textContent = "Unable to connect to the server. Please check your connection.";
    }
}

// ── Unlock audio using the login button press as the user gesture ─────────────
// The login button click also triggers the document-level unlockAudio listener
// synchronously (priming the element inside the gesture). This function is a
// safety net called after the login await resolves — primeAudioElement() will
// no-op if already unlocked, or attempt a muted priming (always allowed) if not.
function unlockAudioOnLogin() {
    primeAudioElement();
}

async function handleLoginApi(email, password, errorElem) {
    try {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            // If email not verified, show OTP verification form
            if (res.status === 403 && data.requiresVerification) {
                showOtpVerificationForm(data.email || email);
                return;
            }

            if (errorElem) errorElem.textContent = data.message || "Login failed.";
            return;
        }

        completeLoginFromResponse(data);
    } catch (err) {
        console.error("[Login] Request failed:", err);
        if (errorElem) errorElem.textContent = "Unable to connect to the server. Please check your connection.";
    }
}

// ── Complete Login (shared by signup-verify and login) ────────────────────────
function completeLoginFromResponse(user) {
    if (user.accessToken && user.refreshToken) {
        storeTokens(user.accessToken, user.refreshToken, user.expiresIn || 900);
    } else {
        showToast("Login error: no authentication token received.", "error");
        return;
    }

    unlockAudioOnLogin();

    currentUser = user;
    saveToLS(LS_CURRENT_USER_KEY, currentUser);

    // Load this user's persisted in-app notifications and refresh the badge
    loadNotifStore(currentUser.id);
    refreshNotifBadge();

    showAppViews();
    switchView("dashboard-view");
    showToast(`Welcome${currentUser.name ? ", " + currentUser.name : ""}!`, "success", 3000);

    // Restart the checkReminders safety-net interval if it was cleared on logout.
    if (!_reminderIntervalId) {
        _reminderIntervalId = setInterval(checkReminders, 30000);
    }

    if ("Notification" in window && Notification.permission === "default") {
        setTimeout(() => showNotifPermissionBanner(), 2000);
    }

    fetchFullProfile(user.id).then(fullProfile => {
        if (fullProfile) {
            currentUser = { ...currentUser, ...fullProfile };
            saveToLS(LS_CURRENT_USER_KEY, currentUser);
            updateUserMenuInfo();
            updateProfileDropdown();
        }
    }).catch(err => {
        console.warn("[Login] fetchFullProfile failed (non-fatal):", err.message);
    });
}

// ── OTP Verification Flow ────────────────────────────────────────────────────

let pendingOtpEmail = "";

function showOtpVerificationForm(email) {
    pendingOtpEmail = email;
    // Hide all auth forms
    document.getElementById("login-form").style.display = "none";
    document.getElementById("signup-form").style.display = "none";
    document.getElementById("login-header").style.display = "none";
    document.getElementById("signup-header").style.display = "none";
    document.getElementById("signup-switch-text").style.display = "none";
    const fpForm = document.getElementById("forgot-password-form");
    if (fpForm) fpForm.style.display = "none";

    // Show OTP form
    const otpForm = document.getElementById("otp-verify-form");
    otpForm.style.display = "block";
    document.getElementById("otp-subtitle").textContent = `Enter the 6-digit code sent to ${email}`;
    document.getElementById("otp-input").value = "";
    document.getElementById("otp-error").textContent = "";
    document.getElementById("otp-form-error").textContent = "";
    document.getElementById("otp-input").focus();

    const card = document.querySelector(".auth-card");
    if (card) card.classList.remove("auth-card-wide");
}

function hideOtpVerificationForm() {
    document.getElementById("otp-verify-form").style.display = "none";
    document.getElementById("login-form").style.display = "block";
    document.getElementById("login-header").style.display = "block";
    const card = document.querySelector(".auth-card");
    if (card) card.classList.remove("auth-card-wide");
}

function setupOtpVerification() {
    const otpForm = document.getElementById("otp-verify-form");
    if (!otpForm) return;

    otpForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const otp = document.getElementById("otp-input").value.trim();
        const errorElem = document.getElementById("otp-form-error");
        errorElem.textContent = "";

        if (!otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
            document.getElementById("otp-error").textContent = "Please enter a valid 6-digit code.";
            return;
        }

        const btn = document.getElementById("otp-submit-btn");
        btn.disabled = true;
        btn.textContent = "Verifying...";

        try {
            const res = await fetch(`${API_BASE}/auth/verify-email`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: pendingOtpEmail, otp })
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                errorElem.textContent = data.message || "Verification failed.";
                return;
            }

            // Verification successful — data contains login response with tokens
            if (data.accessToken) {
                showToast("Email verified successfully!", "success", 3000);
                completeLoginFromResponse(data);
            } else {
                showToast("Email verified! Please log in.", "success", 3000);
                hideOtpVerificationForm();
            }
        } catch (err) {
            console.error(err);
            errorElem.textContent = "Something went wrong. Please try again.";
        } finally {
            btn.disabled = false;
            btn.textContent = "Verify Email";
        }
    });

    // Resend OTP button
    document.getElementById("resend-otp-btn")?.addEventListener("click", async () => {
        const errorElem = document.getElementById("otp-form-error");
        errorElem.textContent = "";

        try {
            const res = await fetch(`${API_BASE}/auth/resend-otp`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: pendingOtpEmail })
            });
            const data = await res.json().catch(() => ({}));
            showToast(data.message || "OTP resent!", "success", 3000);
        } catch (err) {
            errorElem.textContent = "Failed to resend OTP.";
        }
    });

    // Back to login
    document.getElementById("otp-back-to-login-btn")?.addEventListener("click", () => {
        hideOtpVerificationForm();
    });
}

// ── Forgot Password Flow ─────────────────────────────────────────────────────

let forgotPasswordStep = "email"; // "email" or "reset"
let forgotPasswordEmail = "";

function showForgotPasswordForm() {
    document.getElementById("login-form").style.display = "none";
    document.getElementById("signup-form").style.display = "none";
    document.getElementById("login-header").style.display = "none";
    document.getElementById("signup-header").style.display = "none";
    document.getElementById("signup-switch-text").style.display = "none";
    const otpForm = document.getElementById("otp-verify-form");
    if (otpForm) otpForm.style.display = "none";

    const fpForm = document.getElementById("forgot-password-form");
    fpForm.style.display = "block";

    // Reset to step 1
    forgotPasswordStep = "email";
    document.getElementById("fp-email").value = "";
    document.getElementById("fp-email-group").style.display = "block";
    document.getElementById("fp-otp-section").style.display = "none";
    document.getElementById("fp-submit-btn").textContent = "Send Reset Code";
    document.getElementById("fp-form-error").textContent = "";
    document.getElementById("fp-email-error").textContent = "";

    const card = document.querySelector(".auth-card");
    if (card) card.classList.remove("auth-card-wide");
}

function hideForgotPasswordForm() {
    document.getElementById("forgot-password-form").style.display = "none";
    document.getElementById("login-form").style.display = "block";
    document.getElementById("login-header").style.display = "block";
    const card = document.querySelector(".auth-card");
    if (card) card.classList.remove("auth-card-wide");
}

function setupForgotPassword() {
    document.getElementById("forgot-password-btn")?.addEventListener("click", () => {
        showForgotPasswordForm();
    });

    document.getElementById("fp-back-to-login-btn")?.addEventListener("click", () => {
        hideForgotPasswordForm();
    });

    const fpForm = document.getElementById("forgot-password-form");
    if (!fpForm) return;

    fpForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const errorElem = document.getElementById("fp-form-error");
        errorElem.textContent = "";

        if (forgotPasswordStep === "email") {
            // Step 1: Send OTP to email
            const email = document.getElementById("fp-email").value.trim().toLowerCase();
            if (!email || !email.includes("@")) {
                document.getElementById("fp-email-error").textContent = "Please enter a valid email.";
                return;
            }

            const btn = document.getElementById("fp-submit-btn");
            btn.disabled = true;
            btn.textContent = "Sending...";

            try {
                const res = await fetch(`${API_BASE}/auth/forgot-password`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ email })
                });
                const data = await res.json().catch(() => ({}));

                if (!res.ok) {
                    errorElem.textContent = data.message || "Failed to send reset code.";
                    return;
                }

                // Move to step 2: show OTP + new password fields
                forgotPasswordEmail = email;
                forgotPasswordStep = "reset";
                document.getElementById("fp-email-group").style.display = "none";
                document.getElementById("fp-otp-section").style.display = "block";
                document.getElementById("fp-submit-btn").textContent = "Reset Password";
                showToast("Reset code sent to your email!", "success", 3000);
                document.getElementById("fp-otp").focus();
            } catch (err) {
                errorElem.textContent = "Something went wrong. Please try again.";
            } finally {
                btn.disabled = false;
                if (forgotPasswordStep === "email") btn.textContent = "Send Reset Code";
            }
        } else {
            // Step 2: Verify OTP and reset password
            const otp = document.getElementById("fp-otp").value.trim();
            const newPassword = document.getElementById("fp-new-password").value;
            const confirmPassword = document.getElementById("fp-confirm-password").value;

            let valid = true;
            if (!otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
                document.getElementById("fp-otp-error").textContent = "Enter a valid 6-digit code.";
                valid = false;
            }
            if (!newPassword || newPassword.length < 8) {
                document.getElementById("fp-pw-error").textContent = "Password must be at least 8 characters.";
                valid = false;
            }
            if (newPassword !== confirmPassword) {
                document.getElementById("fp-confirm-error").textContent = "Passwords do not match.";
                valid = false;
            }
            if (!valid) return;

            const btn = document.getElementById("fp-submit-btn");
            btn.disabled = true;
            btn.textContent = "Resetting...";

            try {
                const res = await fetch(`${API_BASE}/auth/reset-password`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        email: forgotPasswordEmail,
                        otp,
                        newPassword
                    })
                });
                const data = await res.json().catch(() => ({}));

                if (!res.ok) {
                    errorElem.textContent = data.message || "Reset failed.";
                    return;
                }

                showToast("Password reset successfully! Please log in.", "success", 4000);
                hideForgotPasswordForm();
            } catch (err) {
                errorElem.textContent = "Something went wrong. Please try again.";
            } finally {
                btn.disabled = false;
                btn.textContent = "Reset Password";
            }
        }
    });
}

async function fetchFullProfile(userId) {
    if (!userId) return null;
    try {
        const res = await authFetch(`${API_BASE}/user/profile/${userId}`);
        if (!res.ok) {
            // 401/403 after retry means auth genuinely failed — don't crash the
            // calling flow, just return null so the caller falls back gracefully.
            console.warn("fetchFullProfile: server returned", res.status);
            return null;
        }
        const profile = await res.json();
        _profileFetchedAt = Date.now();
        return profile;
    } catch (e) {
        // authFetch throws when _handleAuthExpiry fires (session genuinely dead)
        // OR on network failure. Either way, return null — the caller decides
        // whether this is fatal.
        console.warn("fetchFullProfile error (non-fatal during login/signup):", e.message);
        return null;
    }
}


function setupNav() {

    document.querySelectorAll(".nav-btn[data-view]").forEach(btn => {
        btn.addEventListener("click", () => {

            const viewId = btn.dataset.view;

            switchView(viewId);
            closeUserMenu();  // always close sidebar on nav

            document.querySelectorAll(".nav-btn").forEach(link => {
                link.classList.remove("active");
            });

            btn.classList.add("active");
        });
    });

    const menuLogoutBtn = document.getElementById("menu-logout-btn");

    function doLogout() {
        stopReminderAudio(); // Stop any active reminder audio
        currentUser = null;
        saveToLS(LS_CURRENT_USER_KEY, null);
        clearTokens(); // Clear JWT tokens
        // Clear all notification dedup state so the next login starts fresh
        firedReminderKeys.clear();
        firedMissedAlertKeys.clear();
        _lastScheduledDate = "";
        clearScheduledTimeouts();
        clearMissTimeouts(); // Stop any pending 5-min miss-window timers
        // Stop the checkReminders safety-net interval — it is restarted on next login
        if (_reminderIntervalId) { clearInterval(_reminderIntervalId); _reminderIntervalId = null; }
        // Clear in-app notification panel (memory only — localStorage remains for next login)
        notifStore = [];
        refreshNotifBadge();
        medsCache = [];
        medsCacheDate = null;
        showAuthView();
    }

    if (menuLogoutBtn) {
        menuLogoutBtn.addEventListener("click", () => {
            closeUserMenu();
            openModal("modal-logout");
        });
    }
}

function setThemeToggleVisible(show) {
    
}

let userMenuOpen = false;

function setupHamburgerMenu() {
    const hamburgerBtn = document.getElementById("hamburger-btn");
    const overlay = document.getElementById("menu-overlay");

    if (!hamburgerBtn || !overlay) return;

    hamburgerBtn.addEventListener("click", () => {
        if (userMenuOpen) {
            closeUserMenu();
        } else {
            openUserMenu();
        }
    });

    overlay.addEventListener("click", () => {
        closeUserMenu();
    });
}

function setHamburgerVisible(show) {
    const btn = document.getElementById("hamburger-btn");
    if (!btn) return;
    // CSS handles display via media query; JS only hides when logged out
    if (!show) {
        btn.style.display = "none";
    } else {
        btn.style.display = ""; // let CSS media query decide
    }
}

function openUserMenu() {
    const overlay = document.getElementById("menu-overlay");
    const menu = document.getElementById("user-menu");
    if (overlay) overlay.classList.add("open");
    if (menu) menu.classList.add("open");
    userMenuOpen = true;
    updateUserMenuInfo();
}

function closeUserMenu() {
    const overlay = document.getElementById("menu-overlay");
    const menu = document.getElementById("user-menu");
    if (overlay) overlay.classList.remove("open");
    if (menu) menu.classList.remove("open");
    userMenuOpen = false;
}

function updateUserMenuInfo() {
    
    const avatarEl = document.getElementById("nav-user-avatar");
    
    if (avatarEl && currentUser) {
        const displayName = currentUser.name || "User";
        const initial = displayName.trim().charAt(0).toUpperCase() || "U";
        avatarEl.textContent = initial;
    }
}

function setupMedicineForm() {
    const medForm = document.getElementById("medicine-form");
    if (!medForm) return;

    const successText = document.getElementById("med-success");
    const errorText = document.getElementById("med-error");
    const startInput = document.getElementById("med-start-date");
    const endInput = document.getElementById("med-end-date");

    const _now = new Date();
    const todayStr = [
        _now.getFullYear(),
        String(_now.getMonth() + 1).padStart(2, "0"),
        String(_now.getDate()).padStart(2, "0")
    ].join("-");
    if (startInput) { startInput.value = todayStr; startInput.min = todayStr; }
    if (endInput) { endInput.value = todayStr; endInput.min = todayStr; }

    medForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        successText.textContent = "";
        errorText.textContent = "";

        if (!currentUser) {
            errorText.textContent = "Please login first.";
            return;
        }

        if (currentUser.role === "CAREGIVER") {
            errorText.textContent = "Caregivers cannot add medicines. Login as patient.";
            return;
        }

        const name = document.getElementById("med-name").value.trim();
        const dosage = document.getElementById("med-dosage").value.trim();
        const instructions = document.getElementById("med-instructions").value.trim();
        const startDate = startInput.value;
        const endDate = endInput.value;
        const time1 = document.getElementById("time-1").value;
        const time2 = document.getElementById("time-2").value;
        const time3 = document.getElementById("time-3").value;

        if (!name || !dosage || !startDate || !endDate) {
            errorText.textContent = "Please fill all required fields.";
            return;
        }

        if (endDate < startDate) {
            errorText.textContent = "End date cannot be before start date.";
            return;
        }

        const times = [time1, time2, time3].filter(Boolean);
        if (times.length === 0) {
            errorText.textContent = "Please add at least one time.";
            return;
        }

        const uniqueTimes = new Set(times);
        if (uniqueTimes.size !== times.length) {
            errorText.textContent = "Duplicate times are not allowed.";
            return;
        }

        const payload = {
            userId: currentUser.id,
            name,
            dosage,
            instructions,
            startDate,
            endDate,
            times
        };

        try {
            const res = await authFetch(`${API_BASE}/medications/add`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                errorText.textContent = data.message || "Failed to save medicine.";
                return;
            }

            medForm.reset();
            startInput.value = todayStr;
            endInput.value = todayStr;
            successText.textContent = "Medicine saved successfully!";
            setTimeout(() => (successText.textContent = ""), 2000);
            showToast("Medicine saved successfully!", "success");

          
            const firstTime = times[0] || "";

            invalidateDataCache("/medications/", "/logs/summary/", "/logs/adherence/", "/streaks/");
            await renderDashboard();
            await refreshActivityFeed();
        } catch (err) {
            console.error(err);
            errorText.textContent = "Error connecting to server.";
            showToast("Error connecting to server.", "error");
        }
    });
}

/**
 * updateGreeting()
 * Determines the appropriate greeting and today's formatted date
 * based on the user's local browser time, then updates the DOM elements.
 */
function updateGreeting() {
    const now = new Date();
    const hour = now.getHours();

    let greetingText;

    if (hour >= 5 && hour < 12) {
        greetingText = "Good Morning";
    } else if (hour >= 12 && hour < 17) {
        greetingText = "Good Afternoon";
    } else if (hour >= 17 && hour < 21) {
        greetingText = "Good Evening";
    } else {
        greetingText = "Good Night";
    }

    // Format today's date as "Thursday, June 4, 2026"
    const formattedDate = now.toLocaleDateString(undefined, {
        weekday: "long",
        year:    "numeric",
        month:   "long",
        day:     "numeric"
    });

    const greetingEl = document.getElementById("greeting-text");
    if (greetingEl) {
        const name = currentUser && currentUser.name
            ? `, ${currentUser.name.split(" ")[0]}`
            : "";
        greetingEl.textContent = `${greetingText}${name}`;
    }

    const dateEl = document.getElementById("dashboard-date");
    if (dateEl) {
        dateEl.textContent = formattedDate;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  isMedicationActiveToday
//
//  Returns true when a medication should appear in "Today's Medicines":
//    startDate <= todayStr  AND  endDate >= todayStr
//
//  The backend enforces this with the same inclusive query, but we also apply
//  it client-side so the analytics stat-card "Active Medicines" count is always
//  accurate — even if the meds array was populated from a cache or from an
//  endpoint that doesn't filter by date (e.g. a future "all meds" list).
//
//  Same-day medicines (startDate === endDate === today) remain active for the
//  full calendar day and become inactive starting the next day.  This mirrors
//  the JPA query:
//      startDate <= today  AND  endDate >= today
//
//  @param {Object} med        - medication object with startDate / endDate fields
//  @param {string} todayStr   - "YYYY-MM-DD" string for today in LOCAL time
//  @returns {boolean}
// ─────────────────────────────────────────────────────────────────────────────
function isMedicationActiveToday(med, todayStr) {
    if (!med) return false;
    const start = med.startDate || "";
    const end   = med.endDate   || "";
    // Missing dates → treat as active (backward-compat with older records)
    if (!start && !end) return true;
    // String comparison works for ISO "YYYY-MM-DD" format
    if (start && start > todayStr) return false; // hasn't started yet
    if (end   && end   < todayStr) return false; // already expired
    return true;
}

async function renderDashboard() {
    if (!currentUser) return;
    const renderId = ++_dashboardRenderId;

    // Update greeting and date every time the dashboard renders
    updateGreeting();

    const dateElem = document.getElementById("dashboard-date");
    const noMedsMsg = document.getElementById("no-meds-message");
    const tbody = document.getElementById("schedule-body");
    const scheduleTable = document.getElementById("schedule-table");
    const statsElem = document.getElementById("today-stats");

    if (!dateElem || !tbody || !scheduleTable || !noMedsMsg) return;

    const today = new Date();
    // Use LOCAL date (not UTC via toISOString) so the date string matches the
    // user's timezone rather than the UTC offset.  e.g. at 11 PM UTC+5:30 the
    // local date is still "today" even though UTC rolled to the next day.
    const todayStr = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, "0"),
        String(today.getDate()).padStart(2, "0")
    ].join("-");

    let medsUrl;

    if (currentUser.role === "CAREGIVER" && currentUser.patientEmail) {
        medsUrl = `${API_BASE}/medications/today-by-email/${encodeURIComponent(
            currentUser.patientEmail
        )}`;
        // Show patient context in the stats pill, not in the date line
        const patientNote = document.getElementById("caregiver-patient-note");
        if (patientNote) patientNote.textContent = `Patient: ${currentUser.patientEmail}`;
    } else {
        medsUrl = `${API_BASE}/medications/today/${currentUser.id}`;
        const patientNote = document.getElementById("caregiver-patient-note");
        if (patientNote) patientNote.textContent = "";
    }

    // dateElem is already set by updateGreeting(); do not overwrite it here.

    try {
        const [logsRes, medsRes] = await Promise.allSettled([
            fetchJsonCached(`${API_BASE}/logs/today/${currentUser.id}?date=${encodeURIComponent(todayStr)}`, 10000),
            fetchJsonCached(`${medsUrl}?date=${encodeURIComponent(todayStr)}`, 30000)
        ]);
        if (renderId !== _dashboardRenderId) return;

        const todayLogs = (logsRes.status === "fulfilled" && Array.isArray(logsRes.value)) ? logsRes.value : [];
        logs = todayLogs;

        const meds = (medsRes.status === "fulfilled" && Array.isArray(medsRes.value)) ? medsRes.value : [];
        medsCache = meds;
        medsCacheDate = todayStr;

        if (medsRes.status === "rejected") {
            console.error("Failed to fetch medications:", medsRes.reason);
        }

        if (meds.length === 0) {
            tbody.innerHTML = "";
            document.getElementById("totalDoses").textContent = 0;
            document.getElementById("takenDoses").textContent = 0;
            document.getElementById("pendingDoses").textContent = 0;
            document.getElementById("adherence").textContent = "0%";

            noMedsMsg.style.display = "block";
            noMedsMsg.textContent = medsRes.status === "rejected"
                ? "Could not load medicines from server."
                : "No medicines scheduled for today.";
            scheduleTable.style.display = "none";
            if (statsElem) statsElem.textContent = "";
            clearScheduledTimeouts();

            // Load peripheral widgets even when user has 0 scheduled medications
            loadLatestBmi();
            renderRecentActivity();
            renderReports(logs).catch(e => console.warn("[Dashboard] weekly-chart renderReports error:", e));
            return;
        }

        tbody.innerHTML = "";
        noMedsMsg.style.display = "none";
        // On mobile (≤767px) the table is reflowed as cards using display:block
        scheduleTable.style.display = window.innerWidth <= 767 ? "block" : "table";

        const nowMinutes = today.getHours() * 60 + today.getMinutes();
        let totalDoses = 0;
        let takenDoses = 0;
        let missedDoses = 0;

        meds.forEach((med) => {
            if (!Array.isArray(med.times)) return;
            med.times.forEach((timeObj) => {
                totalDoses++;
                const tr = document.createElement("tr");
                tr.dataset.medId = med.id;
                tr.className = `schedule-row med-row-${med.id}`;
                const rawTime = timeObj.timeOfDay || "";
                const displayTime = rawTime.substring(0, 5);
                const doseStatus = getDoseStatus(
                    currentUser.id,
                    med.id,
                    todayStr,
                    displayTime
                );
                if (doseStatus === "TAKEN")  takenDoses++;
                if (doseStatus === "MISSED") missedDoses++;
                const timeCell = document.createElement("td");
                timeCell.textContent = displayTime;
                const nameCell = document.createElement("td");
                nameCell.textContent = med.name;
                const dosageCell = document.createElement("td");
                dosageCell.textContent = med.dosage;
                const instrCell = document.createElement("td");
                instrCell.textContent = med.instructions || "-";
                const statusCell = document.createElement("td");
                const statusSpan = document.createElement("span");
                statusSpan.classList.add("status-pill");
                let isMissed = false;
                const [h, m] = displayTime.split(":").map(Number);
                const timeMinutes = h * 60 + m;
                const diff = timeMinutes - nowMinutes;
                if (doseStatus === "TAKEN") {
                    statusSpan.classList.add("status-taken");
                    statusSpan.textContent = "Taken";
                } else if (doseStatus === "MISSED") {
                    statusSpan.classList.add("status-missed");
                    statusSpan.textContent = "Missed";
                    isMissed = true;
                } else {
                    statusSpan.classList.add("status-pending");
                    if (Math.abs(diff) <= 30) {
                        statusSpan.textContent = "Due now";
                    } else if (diff > 30) {
                        statusSpan.textContent = "Upcoming";
                    } else {
                        statusSpan.textContent = "Missed";
                        isMissed = true;
                    }
                }
                statusCell.appendChild(statusSpan);

                const actionCell = document.createElement("td");
                const btn = document.createElement("button");

                if (doseStatus === "TAKEN" || isMissed) {
                    btn.textContent = doseStatus === "TAKEN" ? "Taken" : "Missed";
                    btn.className = "action-btn action-btn-disabled";
                    btn.disabled = true;
                } else {
                    btn.textContent = "Mark taken";
                    btn.className = "action-btn action-btn-take";
                    btn.addEventListener("click", async () => {
                        await markDoseTaken(
                            currentUser.id,
                            med.id,
                            todayStr,
                            displayTime,
                            med.name
                        );
                        await renderDashboard();
                        await refreshActivityFeed();
                    });
                }

                let deleteBtn = null;

                if (timeObj === med.times[0]) {
                    deleteBtn = document.createElement("button");
                    deleteBtn.textContent = "Delete";
                    deleteBtn.className = "action-btn action-btn-delete";
                    deleteBtn.dataset.medId = med.id;

                    if (currentUser.role && currentUser.role.toUpperCase() === "PATIENT") {
                        deleteBtn.addEventListener("click", async () => {
                            await deleteMedication(med.id);
                        });
                    } else {
                        deleteBtn.disabled = true;
                    }
                }
                const actionWrapper = document.createElement("div");
                actionWrapper.className = "action-cell";
                actionWrapper.appendChild(btn);
                if (deleteBtn) {
                    actionWrapper.appendChild(deleteBtn);
                }
                actionCell.appendChild(actionWrapper);

                tr.appendChild(timeCell);
                tr.appendChild(nameCell);
                tr.appendChild(dosageCell);
                tr.appendChild(instrCell);
                tr.appendChild(statusCell);
                tr.appendChild(actionCell);

                tbody.appendChild(tr);
            });
        });

        const totalElem    = document.getElementById("totalDoses");
        const takenElem    = document.getElementById("takenDoses");
        const pendingElem  = document.getElementById("pendingDoses");
        const adherenceElem = document.getElementById("adherence");

        const pending = Math.max(0, totalDoses - takenDoses - missedDoses);
        const completedDoses = takenDoses + missedDoses;
        const percent = completedDoses === 0 ? 0 : Math.round((takenDoses / completedDoses) * 100);

        if (statsElem && totalDoses > 0) {
            statsElem.textContent =
                `Today: ${totalDoses} doses · ` +
                `${takenDoses} taken · ${missedDoses > 0 ? missedDoses + " missed · " : ""}${pending} pending`;
        }

        if (totalElem)    totalElem.textContent    = totalDoses;
        if (takenElem)    takenElem.textContent    = takenDoses;
        if (pendingElem)  pendingElem.textContent  = pending;
        if (adherenceElem) adherenceElem.textContent = percent + "%";
        updateMissedDoseNotifications(meds, todayStr);
        // Single scheduling call — scheduleMedicineReminders is the sole
        // source of truth for dose-time timeouts.
        scheduleMedicineReminders();

        // Fire-and-forget: this is a write-side-effect (marks past doses missed
        // on the server).  It does NOT need to complete before the dashboard
        // finishes rendering — removing the await cuts one full server RTT from
        // every dashboard open.
        logMissedDoseActivities(meds, todayStr);

        loadLatestBmi();

        renderRecentActivity();
        // renderStreakPanel() REMOVED — renderReports() already calls
        // renderReportsStreak() which calls applyStreakToUI().  Having both
        // fire a POST /streaks/recalculate simultaneously created a race where
        // two concurrent mutations could overwrite each other.
        renderReports(logs).catch(e => console.warn("[Dashboard] weekly-chart renderReports error:", e));
    } catch (err) {
        console.error(err);
        noMedsMsg.style.display = "block";
        noMedsMsg.textContent = "Could not load medicines from server.";
        scheduleTable.style.display = "none";
        clearScheduledTimeouts();
    }
}
function updateMissedDoseNotifications(meds, todayStr) {
    const countEl = document.getElementById("notification-count");
    if (!countEl) return;

    const now        = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const newItems = [];
    meds.forEach(med => {
        // Do not generate notifications for expired medicines
        if (!isMedicationActiveToday(med, todayStr)) return;

        if (!Array.isArray(med.times)) return;
        med.times.forEach(t => {
            const time        = (t.timeOfDay || "").substring(0, 5);
            const [h, m]      = time.split(":").map(Number);
            const doseMinutes = h * 60 + m;
            if (doseMinutes < nowMinutes) {
                const taken = getDoseStatus(currentUser.id, med.id, todayStr, time) === "TAKEN";
                if (!taken) {
                    newItems.push({
                        id:      `missed-${med.id}-${time}`,
                        type:    "missed",
                        title:   `Missed dose: ${med.name}`,
                        desc:    `Scheduled at ${time} — not yet taken`,
                        time:    time,
                        unread:  true,
                        ts:      Date.now(),
                    });
                }
            }
        });
    });

    const existing = notifStore.filter(n => n.type !== "missed");
    notifStore = [...newItems, ...existing].slice(0, 50);
    saveNotifStore(currentUser?.id);

    const unread = notifStore.filter(n => n.unread).length;
    countEl.textContent = unread;
    countEl.style.display = unread > 0 ? "flex" : "none";

    const badge = document.getElementById("notif-unread-badge");
    if (badge) {
        badge.textContent = unread;
        badge.style.display = unread > 0 ? "inline-flex" : "none";
    }
}

async function deleteMedication(medId) {
    if (!confirm("Delete this medicine and all its doses?")) return;

    // 1. Target rows and delete buttons for this specific medicine
    const medRows = document.querySelectorAll(`[data-med-id="${medId}"]`);
    const delBtns = document.querySelectorAll(`button.action-btn-delete[data-med-id="${medId}"]`);

    // 2. Mark ONLY this medicine as deleting without hiding the rest of the list
    delBtns.forEach(btn => {
        btn.disabled = true;
        btn.textContent = "Deleting...";
    });
    medRows.forEach(row => {
        if (row.tagName === "TR") {
            row.style.opacity = "0.5";
            row.style.pointerEvents = "none";
            row.style.transition = "opacity 0.2s ease";
        }
    });

    try {
        const res = await authFetch(`${API_BASE}/medications/${medId}`, {
            method: "DELETE",
        });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            showToast(errData.message || "Failed to delete medicine.", "error");
            // Restore UI state for this medicine
            delBtns.forEach(btn => {
                btn.disabled = false;
                btn.textContent = "Delete";
            });
            medRows.forEach(row => {
                if (row.tagName === "TR") {
                    row.style.opacity = "";
                    row.style.pointerEvents = "";
                }
            });
            return;
        }

        // 3. Optimistically remove the deleted medicine from the rendered table immediately
        medRows.forEach(row => {
            if (row.tagName === "TR") row.remove();
        });

        // 4. Update memory cache optimistically — prevents the deleted med from
        //    re-appearing if scheduleMedicineReminders() or other code re-reads medsCache
        if (Array.isArray(medsCache)) {
            medsCache = medsCache.filter(m => m.id !== medId);
        }

        // Cancel any scheduled reminder for the deleted medicine right away.
        // Note: scheduledTimeouts stores raw IDs without medId metadata, so we
        // cannot cancel selectively. The background renderDashboard() call below
        // will rebuild scheduledTimeouts from the updated medsCache (which no longer
        // contains the deleted med), effectively clearing its reminder.

        invalidateDataCache("/medications/", "/logs/", "/streaks/");

        showToast("Medicine deleted successfully.", "success");

        // 5. Background re-fetch: fire-and-forget so the table NEVER goes blank.
        //    We do NOT await renderDashboard() here — the rows are already removed above.
        //    A quiet background refresh keeps stats/charts in sync without any visible flash.
        setTimeout(() => {
            renderDashboard().catch(e => console.warn("[Delete] Background refresh failed", e));
            refreshActivityFeed().catch(e => console.warn("[Delete] Activity refresh failed", e));
        }, 400);
    } catch (err) {
        console.error("Delete medication error:", err);
        showToast("Failed to delete medicine.", "error");
        delBtns.forEach(btn => {
            btn.disabled = false;
            btn.textContent = "Delete";
        });
        medRows.forEach(row => {
            if (row.tagName === "TR") {
                row.style.opacity = "";
                row.style.pointerEvents = "";
            }
        });
    }
}

async function renderHistory() {
    if (!currentUser) return;
    const renderId = ++_historyRenderId;

    const tbody = document.getElementById("history-body");
    const empty = document.getElementById("history-empty");
    if (!tbody || !empty) return;

    tbody.innerHTML = "";

    try {
        const [res, historyStats] = await Promise.all([
            authFetch(`${API_BASE}/logs/history/${currentUser.id}?page=0&size=100`),
            fetchJsonCached(`${API_BASE}/logs/adherence/stats/${currentUser.id}?days=0`, 10000)
        ]);
        if (!res.ok) throw new Error("Failed to load history");
        const items = await res.json();
        if (renderId !== _historyRenderId) return;

        // Do NOT overwrite the global logs[] here.  The global is the shared
        // source of truth for getDoseStatus() which the dashboard table reads.
        // Overwriting it from renderHistory() creates a race: if the user
        // navigates History → Dashboard quickly, getDoseStatus() would read
        // history-view data and show wrong status pills until renderDashboard()
        // fires its own fetch.  Use a local variable for all History rendering.

        const takenCount = historyStats.takenDoses || 0;
        const missedCount = historyStats.missedDoses || 0;
        const pendingCount = historyStats.pendingDoses || 0;
        const adherencePct = historyStats.adherencePercentage || 0;

        const takenCountEl = document.getElementById("hist-taken-count");
        const missedCountEl = document.getElementById("hist-missed-count");
        const pendingCountEl = document.getElementById("hist-pending-count");
        const adherencePctEl = document.getElementById("hist-adherence-pct");

        if (takenCountEl) takenCountEl.textContent = takenCount;
        if (missedCountEl) missedCountEl.textContent = missedCount;
        if (pendingCountEl) pendingCountEl.textContent = pendingCount;
        if (adherencePctEl) adherencePctEl.textContent = adherencePct + "%";

        if (items.length === 0) {
            empty.style.display = "flex";
            return;
        }
        empty.style.display = "none";

        items.forEach((log) => {
            const tr = document.createElement("tr");

            const statusLower = (log.status || "").toLowerCase();
            if (statusLower === "taken")   tr.classList.add("hist-row-taken");
            if (statusLower === "missed")  {
                tr.classList.add("hist-row-missed");
                tr.style.boxShadow = "0 0 0 1px rgba(239, 68, 68, 0.2)";
            }
            if (statusLower === "pending") tr.classList.add("hist-row-pending");

            const dateTd = document.createElement("td");
            dateTd.textContent = log.date;

            const timeTd = document.createElement("td");
            const timeChip = document.createElement("span");
            timeChip.className = "hist-time-chip";
            timeChip.textContent = log.time;
            timeTd.appendChild(timeChip);

            const nameTd = document.createElement("td");
            nameTd.className = "hist-med-name";
            nameTd.textContent = log.medicineName || "-";

            const doseTd = document.createElement("td");
            doseTd.textContent = log.dosage || "-";

            const statusTd = document.createElement("td");
            const statusPill = document.createElement("span");
            statusPill.className = "status-pill";
            if (statusLower === "taken")        statusPill.classList.add("status-taken");
            else if (statusLower === "missed")  statusPill.classList.add("status-missed");
            else                                statusPill.classList.add("status-pending");
            statusPill.textContent = log.status;
            statusTd.appendChild(statusPill);

            tr.appendChild(dateTd);
            tr.appendChild(timeTd);
            tr.appendChild(nameTd);
            tr.appendChild(doseTd);
            tr.appendChild(statusTd);

            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error(err);
        empty.style.display = "flex";
        empty.querySelector(".history-empty-title").textContent = "Could not load history";
        empty.querySelector(".history-empty-sub").textContent = "Please check your connection and try again.";
    }
}

function getDoseStatus(userId, medId, dateStr, timeStr) {
    const entry = logs.find(
        (l) =>
            (l.medId === medId || l.medicationId === medId) &&
            l.date === dateStr &&
            l.time === timeStr
    );
    if (!entry) return "PENDING";
    const s = (entry.status || "").toUpperCase();
    if (s === "TAKEN")  return "TAKEN";
    if (s === "MISSED") return "MISSED";
    return "PENDING";
}

async function markDoseTaken(userId, medId, dateStr, timeStr, medName = "") {
    stopReminderAudio();

    const body = {
        userId,
        medicationId: medId,
        date: dateStr,
        time: timeStr,
        status: "TAKEN",
    };

    try {
        const res = await authFetch(`${API_BASE}/logs/mark`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            console.error("Failed to save log");
        } else {
            invalidateDataCache("/logs/today/", "/logs/summary/", "/logs/adherence/", "/streaks/");
            if (medName) {
                addNotification(
                    "adherence",
                    `${medName} marked as taken`,
                    `Dose at ${timeStr} recorded for ${dateStr}.`
                );
            }
        }
    } catch (err) {
        console.error(err);
    }
}

async function markDoseMissed(userId, medId, dateStr, timeStr) {
    if (!userId || !medId || !dateStr || !timeStr) return;
    try {
        await authFetch(`${API_BASE}/logs/mark-missed-batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify([{ userId, medicationId: medId, date: dateStr, time: timeStr }]),
        });
        invalidateDataCache("/logs/today/", "/logs/summary/", "/logs/adherence/", "/streaks/");
    } catch (err) {
        console.error("markDoseMissed error:", err);
    }
}

let missedMiniChart = null;

function renderMissedMiniChart(labels, missedValues) {
    const ctx = document.getElementById("missed-mini-chart");
    if (!ctx) return;

    if (missedMiniChart) { missedMiniChart.destroy(); missedMiniChart = null; }
    const existing = Chart.getChart(ctx);
    if (existing) existing.destroy();

    const isDark = document.body.classList.contains("dark-mode");
    const barColor  = isDark ? "rgba(248,113,113,0.55)" : "rgba(220,38,38,0.45)";
    const barBorder = isDark ? "#f87171" : "#dc2626";
    const gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
    const tickColor = isDark ? "#555555" : "#8c8278";

    missedMiniChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "Missed",
                data: missedValues,
                backgroundColor: barColor,
                borderColor: barBorder,
                borderWidth: 1.5,
                borderRadius: 4,
                borderSkipped: false,
            }]
        },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ` ${ctx.parsed.y} missed`
                    }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: tickColor, font: { size: 9 } } },
                y: { beginAtZero: true, ticks: { precision: 0, color: tickColor, font: { size: 9 } }, grid: { color: gridColor } }
            }
        }
    });
}

async function renderReports(preloadedHistory) {
    if (!currentUser) return;
    const renderId = ++_reportsRenderId;

    // ── Determine the active period from the selected tab ─────────────────
    // adashCurrentPeriod is set by setupAnalyticsFilterTabs().
    // Default 7 on first load; "all" for All Time.
    const period      = adashCurrentPeriod; // number of days, or "all"
    const periodDays  = (period === "all" || !period) ? 0 : Number(period);
    const periodLabel = periodDays === 0 ? "All Time" : `Last ${periodDays} Days`;

    // Sync the export dropdown to match the active tab so PDF exports are consistent
    // (dropdown removed — period is now read directly from adashCurrentPeriod in exportReportsPDF)

    const dashEmpty = document.getElementById("reports-empty");
    const dashCtx   = document.getElementById("weekly-chart");
    const rptCtx    = document.getElementById("weekly-chart-reports");
    const rptEmpty  = document.getElementById("reports-empty-page");
    const dashboardIsVisible = document.getElementById("dashboard-view")?.classList.contains("active");
    const reportsIsVisible = document.getElementById("reports-view")?.classList.contains("active");

    // Guard on rptCtx (the reports-view canvas), not dashCtx.
    // dashCtx lives inside dashboard-view and may be hidden when reports is active.
    if (!rptCtx && !dashCtx) return;

    // ── Update the period badge in the reports header ─────────────────────
    const periodBadgeEl = document.getElementById("reports-period-badge");
    if (periodBadgeEl) periodBadgeEl.textContent = periodLabel;

    // Hoisted so the try block can populate them and the finally call below
    // can pass them into renderAnalyticsDashboard(), eliminating duplicate
    // network requests.
    let _rptStats  = undefined;  // adherence/stats response object
    let _rptStreak = undefined;  // recalculated streak DTO

    try {
        // FIX Issue 5 (History slowness) + Issue 8 (Weekly Adherence race condition):
        // When called from renderDashboard(), the logs array is already populated
        // and passed in as preloadedHistory. Reusing it eliminates:
        //   1. The duplicate GET /logs/history fetch (saves one full RTT)
        //   2. The race condition where renderReports fetches history before
        //      logMissedDoseActivities' server write has fully committed
        //
        // When called directly (tab navigation, period change, checkReminders),
        // preloadedHistory is undefined so we fetch fresh data as before.
        const statsApiDays = dashboardIsVisible ? 7 : (periodDays === 0 ? 0 : periodDays);

        const chartDays = dashboardIsVisible ? 7 : (periodDays === 0 ? 90 : periodDays);
        const [dailySummary, stats] = await Promise.all([
            fetchJsonCached(`${API_BASE}/logs/summary/${currentUser.id}?days=${chartDays}`, 10000),
            fetchJsonCached(`${API_BASE}/logs/adherence/stats/${currentUser.id}?days=${statsApiDays}`, 10000)
        ]);
        if (renderId !== _reportsRenderId) return;
        _rptStats = stats;

        // ── Build daily buckets for the chart ─────────────────────────────
        // Determine the date range to display
        const today   = new Date();
        today.setHours(0, 0, 0, 0);
        const buckets = {}; // "YYYY-MM-DD" → { taken:0, missed:0 }
        for (let i = chartDays - 1; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            // Use local year/month/day — NOT toISOString() which returns UTC.
            // In UTC+ timezones toISOString() at local midnight gives the previous
            // calendar day, so bucket keys end up one day behind the local dates
            // stored by the backend (which uses LocalDate = server local date).
            // That mismatch causes every log whose local date > UTC date to be
            // silently dropped by the "if (!buckets[dateKey]) return" guard,
            // producing under-counts (e.g. 4 taken doses showing as 0 or 1).
            const key = [
                d.getFullYear(),
                String(d.getMonth() + 1).padStart(2, "0"),
                String(d.getDate()).padStart(2, "0")
            ].join("-");
            buckets[key] = { taken: 0, missed: 0 };
        }

        dailySummary.forEach(day => {
            const dateKey = (day.date || "").substring(0, 10);
            if (!buckets[dateKey]) return; // outside our display window
            buckets[dateKey].taken = day.takenCount || 0;
            buckets[dateKey].missed = day.missedCount || 0;
        });

        const sortedKeys   = Object.keys(buckets).sort();
        const labels       = sortedKeys.map(k => k.substring(5)); // MM-DD
        const takenValues  = sortedKeys.map(k => buckets[k].taken);
        const missedValues = sortedKeys.map(k => buckets[k].missed);
        const hasData      = takenValues.some(v => v > 0) || missedValues.some(v => v > 0);

        // ── Dashboard mini chart (Weekly Adherence card on dashboard) ──────
        // Only draw onto the dashboard canvas (#weekly-chart) when the
        // dashboard view is actually visible.  Drawing on a hidden canvas
        // causes Chart.js to produce a 0×0 chart AND can throw an error that
        // aborts the rest of renderReports() (including the stat-card writes).
        if (dashboardIsVisible) {
            if (dashEmpty) {
                dashEmpty.style.display = hasData ? "none" : "block";
                if (!hasData) dashEmpty.textContent = "Chart will appear after you mark some doses as taken.";
            }
            if (weeklyChart) { weeklyChart.destroy(); weeklyChart = null; }
            const _existingDash = Chart.getChart(dashCtx);
            if (_existingDash) _existingDash.destroy();
            weeklyChart = new Chart(dashCtx, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        {
                            label: "Taken",
                            data: takenValues,
                            backgroundColor: "rgba(0,161,155,0.18)",
                            borderColor: "#00A19B",
                            borderWidth: 2,
                            borderRadius: 6,
                            borderSkipped: false,
                        },
                        {
                            label: "Missed",
                            data: missedValues,
                            backgroundColor: "rgba(220,38,38,0.15)",
                            borderColor: "#dc2626",
                            borderWidth: 2,
                            borderRadius: 6,
                            borderSkipped: false,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { size: 11 }, color: "#4a4540" } },
                    },
                    scales: {
                        x: { grid: { color: "rgba(0,0,0,0.05)" }, ticks: { color: "#8c8278", maxTicksLimit: 10 } },
                        y: { beginAtZero: true, ticks: { precision: 0, color: "#8c8278" }, grid: { color: "rgba(0,0,0,0.05)" } },
                    },
                },
            });
        }

        // ── Reports page chart ─────────────────────────────────────────────
        if (rptCtx && reportsIsVisible) {
            if (rptEmpty) rptEmpty.style.display = hasData ? "none" : "flex";
            const existing = Chart.getChart(rptCtx);
            if (existing) existing.destroy();
            new Chart(rptCtx, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        {
                            label: "Taken",
                            data: takenValues,
                            backgroundColor: "rgba(0,161,155,0.15)",
                            borderColor: "#00A19B",
                            borderWidth: 2,
                            borderRadius: 8,
                            borderSkipped: false,
                        },
                        {
                            label: "Missed",
                            data: missedValues,
                            backgroundColor: "rgba(220,38,38,0.12)",
                            borderColor: "#dc2626",
                            borderWidth: 2,
                            borderRadius: 8,
                            borderSkipped: false,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { size: 11 }, color: "#4a4540" } },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => ` ${ctx.parsed.y} dose(s) ${ctx.dataset.label.toLowerCase()}`,
                            },
                        },
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: "#8c8278", maxTicksLimit: 10 } },
                        y: { beginAtZero: true, ticks: { precision: 0, color: "#8c8278" }, grid: { color: "rgba(0,0,0,0.05)" } },
                    },
                },
            });
        }

        // ── Stat cards — calculated from the filtered client-side data ──────
        // We compute totals directly from the filtered history so the numbers
        // match the chart exactly for any period.
        const filteredTaken  = stats.takenDoses || 0;
        const filteredMissed = stats.missedDoses || 0;
        const filteredTotal  = stats.totalDoses || 0;
        const filteredAdher  = stats.adherencePercentage || 0;

        // FIX Issue 2: use the statsRes already fetched in parallel at the top
        // of this function. The original code made a second sequential fetch
        // here, doubling the network round-trips and causing the noticeable
        // render delay.
        try {
            if (stats) {
                // Override totals with client-computed values so they always
                // match the chart for the selected period.
                const totalEl  = document.getElementById("rpt-total-doses");
                const takenEl  = document.getElementById("rpt-taken-doses");
                const missedEl = document.getElementById("rpt-missed-doses");
                const adherEl  = document.getElementById("rpt-adherence");

                if (totalEl)  totalEl.textContent  = filteredTotal;
                if (takenEl)  takenEl.textContent   = filteredTaken;
                if (missedEl) missedEl.textContent  = filteredMissed;
                if (adherEl)  adherEl.textContent   = filteredAdher + "%";

                // Missed-doses detail card
                const missedCard        = document.getElementById("missed-doses-card");
                const missedTodayEl     = document.getElementById("missed-today");
                const missedWeekEl      = document.getElementById("missed-week");
                const missedMonthEl     = document.getElementById("missed-month");
                const mostMissedMedEl   = document.getElementById("most-missed-med");
                const mostMissedCountEl = document.getElementById("most-missed-count");
                const missedAlertBanner = document.getElementById("missed-alert-banner");
                const mdsSuccessPanel   = document.getElementById("mds-success-panel");

                if (missedCard && filteredMissed > 0) {
                    missedCard.style.display = "block";
                    // These sub-counts always refer to absolute today/week/month
                    // (they're independent of the selected period).
                    if (missedTodayEl)  missedTodayEl.textContent  = stats.missedToday       || 0;
                    if (missedWeekEl)   missedWeekEl.textContent   = stats.missedThisWeek    || 0;
                    if (missedMonthEl)  missedMonthEl.textContent  = stats.missedThisMonth   || 0;
                    if (mostMissedMedEl) mostMissedMedEl.textContent = stats.mostMissedMedicine || "—";
                    if (mostMissedCountEl) {
                        const cnt = stats.mostMissedCount || 0;
                        mostMissedCountEl.textContent = cnt > 0 ? `${cnt} time${cnt > 1 ? "s" : ""}` : "";
                    }

                    if (missedAlertBanner && mdsSuccessPanel) {
                        if (filteredAdher < 70) {
                            missedAlertBanner.style.display = "flex";
                            mdsSuccessPanel.style.display   = "none";
                            const alertTextEl = document.getElementById("missed-alert-text");
                            if (alertTextEl) {
                                alertTextEl.textContent = filteredAdher < 50
                                    ? `Your adherence is critically low at ${filteredAdher}% for ${periodLabel}. Please consult your healthcare provider and enable stronger reminders.`
                                    : `Your adherence dropped to ${filteredAdher}% for ${periodLabel}. Try enabling reminders or adjusting your medication schedule.`;
                            }
                        } else {
                            missedAlertBanner.style.display = "none";
                            mdsSuccessPanel.style.display   = "flex";
                        }
                    }

                    renderMissedMiniChart(labels, missedValues);

                } else if (missedCard) {
                    missedCard.style.display = "none";
                }
            }
        } catch (statsErr) {
            // Stats detail failed — still show the client-computed totals above
            console.warn("Could not load adherence stats detail:", statsErr);

            const totalEl  = document.getElementById("rpt-total-doses");
            const takenEl  = document.getElementById("rpt-taken-doses");
            const missedEl = document.getElementById("rpt-missed-doses");
            const adherEl  = document.getElementById("rpt-adherence");
            if (totalEl)  totalEl.textContent  = filteredTotal;
            if (takenEl)  takenEl.textContent   = filteredTaken;
            if (missedEl) missedEl.textContent  = filteredMissed;
            if (adherEl)  adherEl.textContent   = filteredAdher + "%";
        }

        // Render streak analytics in reports and capture the recalculated
        // streak so we can pass it into renderAnalyticsDashboard() below,
        // avoiding the stale GET /streaks/{id} call that returns perfectDays=0.
        _rptStreak = await renderReportsStreak();

    } catch (err) {
        console.error("[renderReports]", err);
        if (dashEmpty) { dashEmpty.style.display = "block"; dashEmpty.textContent = "Could not load report data."; }
        if (rptEmpty)  { rptEmpty.style.display  = "flex"; }
        // Do not attempt to render the analytics dashboard when the primary
        // data fetch failed — it would fire 2–4 more network requests against
        // an already-failing network, and render with undefined/empty data.
        return;
    }

    // ── Analytics dashboard extra sections ─────────────────────────────────
    // Pass the already-fetched stats, freshly recalculated streak, AND the
    // current medsCache so renderAnalyticsDashboard() can skip its duplicate
    // /medications/today fetch.  Using medsCache here guarantees the medicine
    // count in the analytics stat cards is identical to what the dashboard
    // already displayed — eliminating the count mismatch (Issue 3) and the
    // flash of wrong medicines (Issue 4) that occurred when the second fetch
    // raced with the first and returned a slightly different result.
    // Pass undefined for medsCache when it hasn't been populated yet (e.g.
    // direct navigation to reports view before the dashboard ever loaded) so
    // renderAnalyticsDashboard falls back to its own fetch gracefully.
    if (reportsIsVisible) {
        const _medsForAnalytics = (medsCache && medsCache.length > 0) ? medsCache : undefined;
        renderAnalyticsDashboard(_rptStats, _rptStreak, _medsForAnalytics, preloadedHistory);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  ANALYTICS DASHBOARD — full implementation
// ═══════════════════════════════════════════════════════════════════

// Track current analytics period (days, or "all")
let adashCurrentPeriod = 7;

// Chart instances for analytics dashboard
let adashDonutChart    = null;
let adashBmiChart      = null;
let adashHrChart       = null;
let adashBpChart       = null;
let adashSugarChart    = null;
let adashWeightChart   = null;
let _analyticsBmiHistory = [];
let _analyticsVitalsHistory = [];

/**
 * Main entry point — called whenever reports view opens or period changes.
 * Fires all data loads in parallel.
 *
 * @param {object|undefined} preloadedStats  - Already-fetched adherence/stats
 *     object from renderReports().  When provided, the duplicate
 *     GET /logs/adherence/stats fetch is skipped entirely and the stat-card
 *     elements that renderReports() already wrote are NOT overwritten.
 * @param {object|undefined} preloadedStreak - Already-recalculated streak DTO
 *     from renderReportsStreak().  When provided, the stale
 *     GET /streaks/{id} fetch (which always returns perfectDaysThisWeek=0)
 *     is replaced with this live recalculated value.
 * @param {Array|undefined} preloadedMeds - Already-fetched today's medications
 *     array.  When provided (e.g. passed from renderDashboard via renderReports),
 *     the duplicate GET /medications/today fetch is skipped — eliminating the
 *     race condition where a second fetch could return a different (stale) set
 *     and briefly show wrong medicines (Issue 4) with an incorrect count (Issue 3).
 * @param {Array|undefined} preloadedTodayLogs - Already-fetched today's intake logs
 *     array. When provided, the duplicate GET /logs/today/{id} fetch is skipped.
 */
async function renderAnalyticsDashboard(preloadedStats, preloadedStreak, preloadedMeds, preloadedTodayLogs) {
    if (!currentUser) return;
    const uid = currentUser.id;

    // Compute local date string the same way renderDashboard() does — avoids UTC mismatch.
    const _analyticsToday = new Date();
    const _analyticsTodayStr = [
        _analyticsToday.getFullYear(),
        String(_analyticsToday.getMonth() + 1).padStart(2, "0"),
        String(_analyticsToday.getDate()).padStart(2, "0")
    ].join("-");

    // FIX Issue 3 & 4: When called from renderReports() → renderDashboard(),
    // medsCache is already populated with the definitive today's-medicines set.
    // Skipping the duplicate /medications/today fetch prevents:
    //   • Issue 3 — wrong count: two fetches can return different active-med
    //     sets if an add/delete races between the two requests.
    //   • Issue 4 — random medicines appear then disappear: the second
    //     independent fetch could return a slightly different array (e.g. a
    //     medicine just deleted still in flight), causing a flash of wrong data
    //     before the UI settles.
    const needMeds = preloadedMeds === undefined;
    const needTodayLogs = preloadedTodayLogs === undefined;

    // Issue #10 fix: Caregivers see medicine data for their linked patient,
    // not for their own account.  Apply the same URL logic that renderDashboard()
    // uses so the Analytics medicine count and donut always match the dashboard.
    const _analyticsMedsUrl = (currentUser.role === "CAREGIVER" && currentUser.patientEmail)
        ? `${API_BASE}/medications/today-by-email/${encodeURIComponent(currentUser.patientEmail)}?date=${encodeURIComponent(_analyticsTodayStr)}`
        : `${API_BASE}/medications/today/${uid}?date=${encodeURIComponent(_analyticsTodayStr)}`;

    // When called from renderReports(), stats and streak are already available.
    // Skip those two fetches to avoid duplicate network requests and stat-card
    // overwrites.  For the remaining four endpoints fire them in parallel as before.
    const parallelFetches = [
        needMeds ? authFetch(_analyticsMedsUrl) : Promise.resolve(null),
        needTodayLogs ? fetchJsonCached(`${API_BASE}/logs/today/${uid}?date=${encodeURIComponent(_analyticsTodayStr)}`, 10000).catch(() => null) : Promise.resolve(null),
        fetchJsonCached(`${API_BASE}/bmi/recent/${uid}?limit=100`, 10000).catch(() => null),
        fetchJsonCached(`${API_BASE}/vitals/recent/${uid}?limit=100`, 10000).catch(() => null)
    ];

    const [
        medsResult,
        todayLogsResult,
        bmiHistResult,
        vitalsHistResult
    ] = await Promise.allSettled(parallelFetches);

    // Also fetch stats and streak when NOT called from renderReports()
    // (e.g. direct navigation to analytics-view, period tab changes).
    // Fire them in parallel with each other when both are needed.
    let statsResult, streakResult;
    const needStats  = preloadedStats  === undefined;
    const needStreak = preloadedStreak === undefined;

    if (needStats && needStreak) {
        // Both needed — fetch in parallel
        [statsResult, streakResult] = await Promise.all([
            authFetch(`${API_BASE}/logs/adherence/stats/${uid}`),
            authFetch(`${API_BASE}/streaks/recalculate/${uid}`, { method: "POST" })
        ]);
    } else if (needStats) {
        statsResult  = await authFetch(`${API_BASE}/logs/adherence/stats/${uid}`);
    } else if (needStreak) {
        // Use the recalculate endpoint so perfectDaysThisWeek/Month are correct.
        streakResult = await authFetch(`${API_BASE}/streaks/recalculate/${uid}`, { method: "POST" });
    }

    // Helper: safely extract JSON from a fetch response
    async function safeJson(res, fallback) {
        try {
            if (!res || !res.ok) return fallback;
            return await res.json();
        } catch (e) {
            return fallback;
        }
    }

    // Helper: safely extract JSON from a settled fetch result
    async function settled(result, fallback) {
        try {
            if (result.status !== "fulfilled" || !result.value) return fallback;
            const res = result.value;
            if (res && typeof res.json === "function") {
                if (!res.ok) return fallback;
                return await res.json();
            }
            return res !== null && res !== undefined ? res : fallback;
        } catch (e) {
            return fallback;
        }
    }

    const rawBmi = await settled(bmiHistResult, []);
    const rawVitals = await settled(vitalsHistResult, []);

    const meds       = preloadedMeds !== undefined ? preloadedMeds : await settled(medsResult, []);
    const todayLogs  = preloadedTodayLogs !== undefined ? preloadedTodayLogs : await settled(todayLogsResult, []);
    const bmiHistory = (Array.isArray(rawBmi) ? rawBmi : []).slice().reverse();
    const vitalsHist = (Array.isArray(rawVitals) ? rawVitals : []).slice().reverse();
    _analyticsBmiHistory = bmiHistory;
    _analyticsVitalsHistory = vitalsHist;

    // Use preloaded values when available; otherwise parse the fetched responses.
    const stats  = preloadedStats  !== undefined ? preloadedStats  : await safeJson(statsResult,  {});
    const streak = preloadedStreak !== undefined ? preloadedStreak : await safeJson(streakResult, {});

    // ── 1. Stat cards ──────────────────────────────────────────────────────
    // Each render step is individually guarded so one DOM error can't
    // cascade and blank out the rest of the page.
    // Pass skipReportCards=true when we were called from renderReports() so
    // adashRenderStatCards does NOT overwrite the period-filtered values that
    // renderReports() already wrote into rpt-taken-doses / rpt-missed-doses /
    // rpt-adherence.
    const _skipRptCards = preloadedStats !== undefined;
    try { adashRenderStatCards(meds, stats, todayLogs, bmiHistory, vitalsHist, _skipRptCards); }
    catch (e) { console.warn("[Analytics] stat cards error:", e); }

    // ── 2. Health Score ────────────────────────────────────────────────────
    try { adashRenderHealthScore(stats, bmiHistory, vitalsHist); }
    catch (e) { console.warn("[Analytics] health score error:", e); }

    // ── 3. Medicine Consumption Donut ──────────────────────────────────────
    try { adashRenderDonut(stats, todayLogs, meds); }
    catch (e) { console.warn("[Analytics] donut error:", e); }

    // ── 4. BMI Trend chart ─────────────────────────────────────────────────
    try { adashRenderBmiChart(bmiHistory); }
    catch (e) { console.warn("[Analytics] BMI chart error:", e); }

    // ── 5. Vitals charts ───────────────────────────────────────────────────
    try { adashRenderVitalsCharts(vitalsHist, adashCurrentVitalsPeriod || "week"); }
    catch (e) { console.warn("[Analytics] vitals chart error:", e); }

    // ── 6. AI Health Insights — runs independently, never blocks steps 1-5 ─
    // adashRenderAiInsights is async and has its own full try/catch with
    // rule-based fallback.  We intentionally do not await it here.
    try { adashRenderAiInsights(stats, bmiHistory, vitalsHist, streak); }
    catch (e) { console.warn("[Analytics] AI insights launch error:", e); }
}

// ── 1. Stat Cards ─────────────────────────────────────────────────────────────
/**
 * @param {boolean} skipReportCards - When true, skip writing rpt-taken-doses,
 *   rpt-missed-doses, and rpt-adherence.  These elements are owned by
 *   renderReports() which writes period-filtered values; overwriting them
 *   here with all-time backend stats would break the period filter UI.
 */
function adashRenderStatCards(meds, stats, todayLogs, bmiHistory, vitalsHist, skipReportCards) {
    // Medications
    const totalMeds = meds.length;

    // "Active" means: today's date is within [startDate, endDate] inclusive.
    // The backend already filters meds via startDate<=today AND endDate>=today,
    // so every med in this array should technically be active.  We re-check
    // client-side using the same inclusive logic so the count is accurate even
    // if the array was sourced from a slightly stale cache.
    const _now      = new Date();
    const todayStr  = [
        _now.getFullYear(),
        String(_now.getMonth() + 1).padStart(2, "0"),
        String(_now.getDate()).padStart(2, "0")
    ].join("-"); // local "YYYY-MM-DD"
    const activeMeds = meds.filter(m => isMedicationActiveToday(m, todayStr)).length;

    setText("adash-total-meds", totalMeds);
    setText("adash-active-meds", activeMeds);
    setText("adash-total-meds-sub", "All time");
    setText("adash-active-meds-sub", "Currently taking");

    // Doses
    const taken  = stats.takenDoses  || 0;
    const missed = stats.missedDoses || 0;
    const adher  = stats.adherencePercentage || 0;

    // Only write the report-card dose elements when we are NOT in the
    // reports-path call (i.e. skipReportCards is false/undefined).
    // When called from renderReports(), these elements already contain
    // period-filtered values; overwriting with all-time backend totals
    // would break the period filter display.
    if (!skipReportCards) {
        setText("rpt-taken-doses", taken);
        setText("rpt-missed-doses", missed);
        setText("rpt-adherence", adher + "%");
    }

    // Adherence trend text
    const takenTrend = document.getElementById("adash-taken-trend");
    if (takenTrend) takenTrend.textContent = adher >= 80 ? "Good progress" : adher >= 60 ? "On track" : "Needs work";

    const missedTrend = document.getElementById("adash-missed-trend");
    if (missedTrend) {
        missedTrend.textContent = missed === 0 ? "Normal" : missed <= 3 ? "Low" : "Needs attention";
        missedTrend.className = "adash-sc-trend " + (missed === 0 ? "adash-trend-up" : "adash-trend-down");
    }

    // Today's doses
    // FIX Issue 3: todayLogs.length is the count of LOG RECORDS (only created
    // when a dose is marked TAKEN or MISSED). This is always less than the total
    // scheduled doses, causing the Analytics "Today's Doses" card to show a
    // smaller denominator than the Dashboard (which counts schedule slots).
    // Fix: compute the total scheduled doses from the meds array (same source
    // as the Dashboard) so both views use the same denominator.
    const todayTaken  = todayLogs.filter(l => l.status === "TAKEN").length;
    const todayMissed = todayLogs.filter(l => l.status === "MISSED").length;
    // Total dose slots scheduled for today (from the medicine schedule)
    const todayScheduled = Array.isArray(meds)
        ? meds.reduce((sum, m) => sum + (Array.isArray(m.times) ? m.times.length : 0), 0)
        : todayLogs.length; // fallback if meds not available
    const todayTotal = todayScheduled > 0 ? todayScheduled : todayLogs.length;
    setText("adash-today-doses", todayTaken + "/" + todayTotal);
    setText("adash-today-sub", todayTotal > 0 ? `${todayTaken} taken of ${todayTotal}` : "No doses today");

    // BMI
    const latestBmi = bmiHistory.length > 0 ? bmiHistory[bmiHistory.length - 1] : null;
    if (latestBmi) {
        setText("adash-current-bmi", latestBmi.bmiValue ? latestBmi.bmiValue.toFixed(1) : "—");
        const catInfo = getBmiCategoryInfo(latestBmi.bmiCategory || determineBmiCategory(latestBmi.bmiValue));
        const bmiCatEl = document.getElementById("adash-bmi-category");
        if (bmiCatEl) {
            bmiCatEl.textContent = catInfo.icon + " " + catInfo.label;
            bmiCatEl.className = "adash-sc-trend";
        }
    } else {
        setText("adash-current-bmi", "—");
        setText("adash-bmi-category", "Not tracked");
    }

    // Vitals logged
    setText("adash-vitals-logged", vitalsHist.length);
    setText("adash-vitals-sub", vitalsHist.length > 0 ? "Records in history" : "No records yet");
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

// ── 2. Health Score ───────────────────────────────────────────────────────────
function adashRenderHealthScore(stats, bmiHistory, vitalsHist) {
    // Adherence score = adherencePercentage (already 0-100)
    const adherScore = Math.min(100, Math.round(stats.adherencePercentage || 0));

    // BMI score: 100 for Normal, scaled for others
    let bmiScore = 50; // default if no data
    const latestBmi = bmiHistory.length > 0 ? bmiHistory[bmiHistory.length - 1] : null;
    if (latestBmi) {
        const bmiVal = latestBmi.bmiValue || 0;
        if (bmiVal >= 18.5 && bmiVal < 25)      bmiScore = 100;
        else if (bmiVal >= 25 && bmiVal < 27.5)  bmiScore = 80;
        else if (bmiVal >= 17 && bmiVal < 18.5)  bmiScore = 80;
        else if (bmiVal >= 27.5 && bmiVal < 30)  bmiScore = 65;
        else if (bmiVal >= 15 && bmiVal < 17)    bmiScore = 60;
        else if (bmiVal >= 30 && bmiVal < 35)    bmiScore = 50;
        else                                     bmiScore = 35;
    }

    // Vitals score: based on how many vitals are in normal range
    let vitalsScore = 50; // default if no data
    if (vitalsHist.length > 0) {
        const latest = vitalsHist[vitalsHist.length - 1];
        let checks = 0, passed = 0;
        if (latest.heartRate) {
            checks++;
            if (latest.heartRate >= 60 && latest.heartRate <= 100) passed++;
        }
        if (latest.bpSystolic && latest.bpDiastolic) {
            checks++;
            if (latest.bpSystolic <= 130 && latest.bpDiastolic <= 85) passed++;
        }
        if (latest.bloodSugar) {
            checks++;
            if (latest.bloodSugar >= 70 && latest.bloodSugar <= 140) passed++;
        }
        if (checks > 0) vitalsScore = Math.round((passed / checks) * 100);
        else vitalsScore = 70; // has records but no specific values to check
    }

    // Overall: weighted average (adherence 50%, BMI 30%, vitals 20%)
    const overall = Math.round((adherScore * 0.5) + (bmiScore * 0.3) + (vitalsScore * 0.2));

    // Animate circular gauge
    const circumference = 314; // 2 * π * 50
    const offset = circumference - (overall / 100) * circumference;
    const circFill = document.getElementById("adash-circ-fill");
    const circScore = document.getElementById("adash-overall-score");

    if (circFill) {
        circFill.style.strokeDashoffset = offset;
        // Color the ring based on score
        if (overall >= 80)      circFill.style.stroke = "#2da44e";
        else if (overall >= 65) circFill.style.stroke = "#00A19B";
        else if (overall >= 50) circFill.style.stroke = "#d97706";
        else                    circFill.style.stroke = "#dc2626";
    }

    // Animate score counter
    if (circScore) animateCounter(circScore, 0, overall, 1200);

    // Score badge
    const badge = document.getElementById("adash-score-badge");
    if (badge) {
        if (overall >= 80)      { badge.textContent = "Excellent"; badge.className = "adash-score-badge score-excellent"; }
        else if (overall >= 65) { badge.textContent = "Good";      badge.className = "adash-score-badge score-good"; }
        else if (overall >= 50) { badge.textContent = "Fair";      badge.className = "adash-score-badge score-fair"; }
        else                    { badge.textContent = "Needs Attention"; badge.className = "adash-score-badge score-poor"; }
    }

    // Score bars
    setTimeout(() => {
        setScoreBar("adash-bar-adherence", "adash-val-adherence", adherScore);
        setScoreBar("adash-bar-bmi",        "adash-val-bmi",       bmiScore);
        setScoreBar("adash-bar-vitals",     "adash-val-vitals",    vitalsScore);
    }, 200);
}

function setScoreBar(barId, valId, score) {
    const bar = document.getElementById(barId);
    const val = document.getElementById(valId);
    if (bar) bar.style.width = score + "%";
    if (val) val.textContent = score;
}

function animateCounter(el, from, to, duration) {
    const start = performance.now();
    function step(timestamp) {
        const progress = Math.min((timestamp - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.round(from + (to - from) * eased);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

// ── 3. Medicine Consumption Donut ─────────────────────────────────────────────
// FIX Issue 2: The original function used stats.takenDoses/missedDoses/pendingDoses
// which are ALL-TIME backend totals — not today's consumption. This made the donut
// show historically-skewed numbers unrelated to the current day.
// Now accepts todayLogs (today's actual log records) and meds (today's schedule)
// to compute a meaningful "today" breakdown:
//   taken  = logs with status TAKEN today
//   missed = logs with status MISSED today
//   pending = scheduled doses that have no log record yet (or are still in future)
function adashRenderDonut(stats, todayLogs, meds) {
    const ctx = document.getElementById("adash-donut-chart");
    if (!ctx) return;

    // Build today's dose breakdown from the actual log records + schedule.
    // todayLogs comes from GET /logs/today/{id} — only created when a dose
    // is marked TAKEN or MISSED. Pending = scheduled - logged.
    let taken   = 0;
    let missed  = 0;
    let pending = 0;

    if (Array.isArray(todayLogs) && Array.isArray(meds) && meds.length > 0) {
        // Use today's actual log records + schedule for an accurate breakdown.
        // This path runs even when todayLogs is empty (all doses still pending).
        taken  = todayLogs.filter(l => (l.status || "").toUpperCase() === "TAKEN").length;
        missed = todayLogs.filter(l => (l.status || "").toUpperCase() === "MISSED").length;
        const totalScheduled = meds.reduce((sum, m) => sum + (Array.isArray(m.times) ? m.times.length : 0), 0);
        pending = Math.max(0, totalScheduled - taken - missed);
    } else if (stats) {
        // Fallback: use backend stats when meds/todayLogs are unavailable
        taken   = stats.takenDoses   || 0;
        missed  = stats.missedDoses  || 0;
        pending = stats.pendingDoses || 0;
    }

    // Update legend values
    setText("adash-dl-taken",   taken);
    setText("adash-dl-missed",  missed);
    setText("adash-dl-pending", pending);

    if (adashDonutChart) { adashDonutChart.destroy(); adashDonutChart = null; }
    const existing = Chart.getChart(ctx);
    if (existing) existing.destroy();

    const isDark = document.body.classList.contains("dark-mode");

    const total = taken + missed + pending;
    if (total === 0) {
        // Show placeholder
        adashDonutChart = new Chart(ctx, {
            type: "doughnut",
            data: {
                labels: ["No data"],
                datasets: [{ data: [1], backgroundColor: [isDark ? "#2a2a2a" : "#e8e3dc"], borderWidth: 0 }]
            },
            options: {
                responsive: true, maintainAspectRatio: true,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                cutout: "72%"
            }
        });
        return;
    }

    adashDonutChart = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: ["Taken", "Missed", "Pending"],
            datasets: [{
                data: [taken, missed, pending],
                backgroundColor: ["#00A19B", "#dc2626", "#d97706"],
                borderColor: isDark ? "#111" : "#f5f1ec",
                borderWidth: 3,
                hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const pct = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0;
                            return ` ${ctx.label}: ${ctx.parsed} (${pct}%)`;
                        }
                    }
                }
            },
            cutout: "72%",
            animation: { animateRotate: true, duration: 1000 }
        }
    });
}

// ── 4. BMI Trend Chart ────────────────────────────────────────────────────────
function adashRenderBmiChart(bmiHistory) {
    const ctx      = document.getElementById("adash-bmi-chart");
    const emptyEl  = document.getElementById("adash-bmi-empty");
    const catRow   = document.getElementById("adash-bmi-cat-row");

    if (!ctx) return;

    if (adashBmiChart) { adashBmiChart.destroy(); adashBmiChart = null; }
    const existing = Chart.getChart(ctx);
    if (existing) existing.destroy();

    if (!bmiHistory || bmiHistory.length === 0) {
        ctx.style.display = "none";
        if (emptyEl) emptyEl.style.display = "flex";
        if (catRow)  catRow.style.display  = "none";
        return;
    }

    ctx.style.display = "";
    if (emptyEl) emptyEl.style.display = "none";
    if (catRow)  catRow.style.display  = "flex";

    // Show BMI category pills
    const latestBmi = bmiHistory[bmiHistory.length - 1];
    if (latestBmi) {
        const cat = latestBmi.bmiCategory || determineBmiCategory(latestBmi.bmiValue);
        ["underweight","normal","overweight","obese"].forEach(c => {
            const el = document.getElementById(`adash-bmi-cat-${c}`);
            if (el) {
                el.classList.toggle("adash-bmi-cat-active",
                    cat.toUpperCase() === c.toUpperCase() ||
                    (c === "normal" && cat.toUpperCase() === "NORMAL_WEIGHT") ||
                    (c === "obese"  && cat.toUpperCase() === "OBESE")
                );
            }
        });
    }

    // Filter by current period
    // FIX Issue 4 (BMI Trend not rendering): The BmiResponseDto field is
    // "createdAt" (set from record.getCreatedAt() in BmiService).  The old
    // code passed "calculatedAt" which doesn't exist on the DTO, so every
    // record's dateStr was "" and the string comparison "" >= cutoffStr was
    // always false — filtering out every record and producing an empty chart.
    const filteredBmi = adashFilterByPeriod(bmiHistory, adashCurrentPeriod, "createdAt");

    const labels = filteredBmi.map(b => {
        const d = new Date(b.createdAt || b.calculatedAt || b.date || "");
        return isNaN(d) ? "—" : d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
    });
    const bmiVals   = filteredBmi.map(b => b.bmiValue ? +b.bmiValue.toFixed(1) : null);
    const weightVals = filteredBmi.map(b => b.weight  || null);

    const isDark = document.body.classList.contains("dark-mode");
    const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)";
    const tickColor = isDark ? "#555" : "#8c8278";

    adashBmiChart = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "BMI",
                    data: bmiVals,
                    borderColor: "#6366f1",
                    backgroundColor: "rgba(99,102,241,0.08)",
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: "#6366f1",
                    borderWidth: 2.5,
                    yAxisID: "yBmi"
                },
                {
                    label: "Weight (kg)",
                    data: weightVals,
                    borderColor: "#06b6d4",
                    backgroundColor: "rgba(6,182,212,0.06)",
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3,
                    pointBackgroundColor: "#06b6d4",
                    borderWidth: 2,
                    borderDash: [5, 4],
                    yAxisID: "yWeight"
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: true, position: "top", labels: { boxWidth: 12, font: { size: 11 }, color: isDark ? "#a8a8a8" : "#4a4540" } },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            if (ctx.dataset.label === "BMI") return ` BMI: ${ctx.parsed.y}`;
                            return ` Weight: ${ctx.parsed.y} kg`;
                        }
                    }
                }
            },
            scales: {
                x: { grid: { color: gridColor }, ticks: { color: tickColor, maxRotation: 45 } },
                yBmi: {
                    type: "linear", position: "left", beginAtZero: false,
                    grid: { color: gridColor }, ticks: { color: tickColor },
                    title: { display: true, text: "BMI", color: "#6366f1", font: { size: 10 } }
                },
                yWeight: {
                    type: "linear", position: "right", beginAtZero: false,
                    grid: { drawOnChartArea: false }, ticks: { color: tickColor },
                    title: { display: true, text: "kg", color: "#06b6d4", font: { size: 10 } }
                }
            }
        }
    });
}

// ── 5. Vitals Charts ──────────────────────────────────────────────────────────
let adashCurrentVitalsPeriod = "week";

function adashRenderVitalsCharts(allVitals, period) {
    const emptyEl = document.getElementById("adash-vitals-empty");

    if (!allVitals || allVitals.length === 0) {
        ["adash-hr-chart","adash-bp-chart","adash-sugar-chart","adash-weight-chart"].forEach(id => {
            const el = document.getElementById(id);
            if (el) { const c = Chart.getChart(el); if (c) c.destroy(); }
        });
        if (emptyEl) emptyEl.style.display = "flex";
        return;
    }
    if (emptyEl) emptyEl.style.display = "none";

    // Filter by period
    const days = period === "week" ? 7 : period === "month" ? 30 : 90;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const filtered = allVitals.filter(v => new Date(v.recordedAt) >= cutoff);
    const src = filtered.length > 0 ? filtered : allVitals.slice(-days);

    const labels = src.map(v => {
        const d = new Date(v.recordedAt);
        return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
    });

    const isDark = document.body.classList.contains("dark-mode");
    const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)";
    const tickColor = isDark ? "#555" : "#8c8278";

    function makeVitalChart(chartVar, canvasId, label, data, color, unit) {
        const ctx = document.getElementById(canvasId);
        if (!ctx) return null;
        if (chartVar) { chartVar.destroy(); }
        const existing = Chart.getChart(ctx);
        if (existing) existing.destroy();
        return new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label, data,
                    borderColor: color,
                    backgroundColor: color + "18",
                    fill: true, tension: 0.4,
                    pointRadius: data.length <= 10 ? 4 : 2,
                    pointBackgroundColor: color,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (c) => ` ${c.parsed.y} ${unit}` } }
                },
                scales: {
                    x: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 9 }, maxRotation: 45, maxTicksLimit: 8 } },
                    y: { beginAtZero: false, grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 9 } } }
                },
                animation: false
            }
        });
    }

    adashHrChart     = makeVitalChart(adashHrChart,     "adash-hr-chart",     "Heart Rate", src.map(v => v.heartRate  || null), "#ef4444", "bpm");
    adashSugarChart  = makeVitalChart(adashSugarChart,  "adash-sugar-chart",  "Blood Sugar", src.map(v => v.bloodSugar || null), "#f59e0b", "mg/dL");
    adashWeightChart = makeVitalChart(adashWeightChart, "adash-weight-chart", "Weight",      src.map(v => v.weight    || null), "#06b6d4", "kg");

    // Blood pressure — two lines (systolic + diastolic)
    const bpCtx = document.getElementById("adash-bp-chart");
    if (bpCtx) {
        if (adashBpChart) { adashBpChart.destroy(); adashBpChart = null; }
        const existing = Chart.getChart(bpCtx);
        if (existing) existing.destroy();
        adashBpChart = new Chart(bpCtx, {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Systolic",
                        data: src.map(v => v.bpSystolic  || null),
                        borderColor: "#dc2626",
                        backgroundColor: "rgba(220,38,38,0.07)",
                        fill: false, tension: 0.4,
                        pointRadius: src.length <= 10 ? 3 : 1,
                        pointBackgroundColor: "#dc2626",
                        borderWidth: 2
                    },
                    {
                        label: "Diastolic",
                        data: src.map(v => v.bpDiastolic || null),
                        borderColor: "#3b82f6",
                        backgroundColor: "rgba(59,130,246,0.07)",
                        fill: false, tension: 0.4,
                        pointRadius: src.length <= 10 ? 3 : 1,
                        pointBackgroundColor: "#3b82f6",
                        borderWidth: 2
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: true, position: "top", labels: { boxWidth: 10, font: { size: 9 }, color: isDark ? "#a8a8a8" : "#4a4540" } },
                    tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y} mmHg` } }
                },
                scales: {
                    x: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 9 }, maxRotation: 45, maxTicksLimit: 8 } },
                    y: { beginAtZero: false, grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 9 } } }
                },
                animation: { duration: 800 }
            }
        });
    }
}

// ── 6. AI Health Insights ─────────────────────────────────────────────────────
let adashAiInsightsCache   = null;
let adashAiInsightsUid     = null;
let adashAiInsightsCacheTs = 0;          // epoch ms when the cache was last populated
const ADASH_AI_CACHE_TTL   = 10 * 60 * 1000; // 10-minute TTL

async function adashRenderAiInsights(stats, bmiHistory, vitalsHist, streak, forceRefresh) {
    const grid    = document.getElementById("adash-ai-grid");
    if (!grid) return;

    // Show loading state
    grid.innerHTML = `
        <div class="adash-ai-loading">
            <div class="adash-ai-spinner"></div>
            <p>Generating AI insights…</p>
        </div>`;

    // Use cache unless forced refresh, different user, or cache older than TTL.
    const cacheAge   = Date.now() - adashAiInsightsCacheTs;
    const cacheValid = adashAiInsightsCache
        && adashAiInsightsUid === currentUser.id
        && cacheAge < ADASH_AI_CACHE_TTL;
    if (!forceRefresh && cacheValid) {
        grid.innerHTML = adashAiInsightsCache;
        return;
    }

    try {
        const adherence = stats.adherencePercentage || 0;
        const taken     = stats.takenDoses  || 0;
        const missed    = stats.missedDoses || 0;
        const latestBmi = bmiHistory.length > 0 ? bmiHistory[bmiHistory.length - 1] : null;
        const latestV   = vitalsHist.length > 0  ? vitalsHist[vitalsHist.length - 1]  : null;
        const curStreak = streak.currentStreak || 0;

        const bmiStr     = latestBmi ? `BMI ${latestBmi.bmiValue?.toFixed(1)} (${latestBmi.bmiCategory || "Unknown"})` : "No BMI data";
        const vitalsStr  = latestV
            ? `HR ${latestV.heartRate || "?"} bpm, BP ${latestV.bpSystolic || "?"}/${latestV.bpDiastolic || "?"} mmHg, Sugar ${latestV.bloodSugar || "?"} mg/dL`
            : "No vitals data";
        const streakStr  = curStreak > 0 ? `${curStreak}-day streak` : "No active streak";

        const prompt = `You are a friendly healthcare assistant. Provide 4 concise health insights (each max 2 sentences) as JSON array.
Each insight has: title (string), message (string), type (one of: success, warning, info, danger).

Patient data:
- Medication adherence: ${adherence}% (${taken} taken, ${missed} missed)
- ${bmiStr}
- ${vitalsStr}  
- Adherence streak: ${streakStr}
- Most missed medicine: ${stats.mostMissedMedicine || "None"}

Return ONLY a valid JSON array. No markdown, no code blocks. Example:
[{"title":"Great Adherence","message":"Your 85% rate exceeds the 80% target.","type":"success"}]`;

        const res = await authFetch(`${API_BASE}/medicine/ai-info?name=${encodeURIComponent(prompt)}&userId=${currentUser.id}`,
            { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
        if (!res.ok) throw new Error(`AI request failed (HTTP ${res.status})`);

        const text = await res.text();

        // FIX Issue 10: Strip markdown code fences before parsing.
        // The AI model sometimes wraps the JSON in ```json ... ``` even when
        // instructed not to, causing the \[[\s\S]*\] regex to fail or match
        // the wrong substring and throw "Invalid AI response format".
        // Also handle the case where the model returns a JSON object {} wrapping
        // an array — extract the first array found in the response.
        const cleanText = text
            .replace(/```json\s*/gi, "")
            .replace(/```\s*/gi, "")
            .trim();

        // Parse JSON from response — find the outermost [...] array
        const jsonMatch = cleanText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("Invalid AI response format");

        const insights = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(insights) || insights.length === 0) throw new Error("Empty insights");

        const html = insights.map(i => adashInsightCard(i)).join("");
        grid.innerHTML = html;
        adashAiInsightsCache   = html;
        adashAiInsightsUid     = currentUser.id;
        adashAiInsightsCacheTs = Date.now();

    } catch (err) {
        console.warn("[Analytics] AI insights error:", err);
        // Fallback: generate rule-based insights
        const fallbackInsights = adashGenerateFallbackInsights(stats, bmiHistory, vitalsHist, streak);
        const html = fallbackInsights.map(i => adashInsightCard(i)).join("");
        grid.innerHTML = html;
        adashAiInsightsCache   = html;
        adashAiInsightsUid     = currentUser.id;
        adashAiInsightsCacheTs = Date.now();
    }
}

function adashInsightCard(insight) {
    const typeClass = {
        success: "adash-ai-card-success",
        warning: "adash-ai-card-warning",
        info:    "adash-ai-card-info",
        danger:  "adash-ai-card-danger"
    }[insight.type] || "adash-ai-card-info";

    let iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"/></svg>`;

    if (insight.type === "success") {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
    } else if (insight.type === "danger" || insight.type === "warning") {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>`;
    } else if (insight.title && insight.title.toLowerCase().includes("medication")) {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/></svg>`;
    } else if (insight.title && insight.title.toLowerCase().includes("vitals")) {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M3 12h2l2-7 3 14 3-10 2 3h6"/></svg>`;
    } else if (insight.title && insight.title.toLowerCase().includes("bmi")) {
        iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1M4.22 4.22l.707.707M18.364 18.364l.707.707M1 12h1m20 0h1M4.22 19.778l.707-.707M18.364 5.636l.707-.707"/></svg>`;
    }

    return `
        <div class="adash-ai-card ${typeClass}">
            <div class="adash-ai-card-icon">${iconSvg}</div>
            <div class="adash-ai-card-body">
                <p class="adash-ai-card-title">${escapeHtml(insight.title || "Insight")}</p>
                <p class="adash-ai-card-text">${escapeHtml(insight.message || "")}</p>
            </div>
        </div>`;
}

function adashGenerateFallbackInsights(stats, bmiHistory, vitalsHist, streak) {
    const adherence = stats.adherencePercentage || 0;
    const missed    = stats.missedDoses || 0;
    const curStreak = streak.currentStreak || 0;
    const latestBmi = bmiHistory.length > 0 ? bmiHistory[bmiHistory.length - 1] : null;
    const latestV   = vitalsHist.length > 0 ? vitalsHist[vitalsHist.length - 1] : null;
    const insights  = [];

    // Adherence insight
    if (adherence >= 90) {
        insights.push({ title: "Excellent Adherence", message: `Your ${adherence}% adherence is outstanding. You are maintaining optimal medication consistency.`, type: "success" });
    } else if (adherence >= 70) {
        insights.push({ title: "Good Adherence", message: `${adherence}% adherence is good. Aim for 90%+ for optimal treatment effectiveness.`, type: "info" });
    } else if (adherence > 0) {
        insights.push({ title: "Low Adherence Notice", message: `Your adherence is ${adherence}%. Missing doses reduces treatment effectiveness. Set reminders to stay on schedule.`, type: "danger" });
    } else {
        insights.push({ title: "Start Tracking", message: "Mark your doses as taken each day to track adherence and receive personalized insights.", type: "info" });
    }

    // Consistency insight
    if (missed > 5) {
        insights.push({ title: "Missed Dose Pattern", message: `You have missed ${missed} doses recently. Consider scheduled alarms to maintain a consistent routine.`, type: "warning" });
    } else if (curStreak >= 7) {
        insights.push({ title: "Consistent Adherence", message: `You have completed ${curStreak} consecutive days on schedule. Consistency significantly supports treatment outcomes.`, type: "success" });
    } else {
        insights.push({ title: "Dose Schedule", message: "Log doses daily to build a comprehensive adherence history for your health review.", type: "info" });
    }

    // BMI insight
    if (latestBmi) {
        const bmiVal = latestBmi.bmiValue || 0;
        if (bmiVal >= 18.5 && bmiVal < 25) {
            insights.push({ title: "Healthy BMI", message: `Your BMI of ${bmiVal.toFixed(1)} is in the normal range. Continue maintaining balanced nutrition and regular activity.`, type: "success" });
        } else if (bmiVal >= 25 && bmiVal < 30) {
            insights.push({ title: "BMI Observation", message: `Your BMI is ${bmiVal.toFixed(1)} (Overweight). Balanced nutrition and regular activity can help manage weight.`, type: "warning" });
        } else if (bmiVal >= 30) {
            insights.push({ title: "BMI Medical Notice", message: `Your BMI of ${bmiVal.toFixed(1)} is in the obese range. Consult a healthcare provider for personalized guidance.`, type: "danger" });
        } else {
            insights.push({ title: "Low BMI Notice", message: `Your BMI is ${bmiVal.toFixed(1)} (Underweight). Ensure adequate nutrition and consult your doctor if needed.`, type: "warning" });
        }
    } else {
        insights.push({ title: "Track Your BMI", message: "Use the BMI Calculator to record body mass index over time for comprehensive health insights.", type: "info" });
    }

    // Vitals insight
    if (latestV) {
        const hrOk = latestV.heartRate && latestV.heartRate >= 60 && latestV.heartRate <= 100;
        const bpOk = latestV.bpSystolic && latestV.bpSystolic <= 130;
        if (hrOk && bpOk) {
            insights.push({ title: "Vitals Within Range", message: "Your recent heart rate and blood pressure readings are within normal ranges. Continue regular logging.", type: "success" });
        } else if (latestV.bpSystolic && latestV.bpSystolic > 140) {
            insights.push({ title: "Elevated Blood Pressure", message: `Your blood pressure reading of ${latestV.bpSystolic}/${latestV.bpDiastolic} mmHg is elevated. Consider consulting your doctor.`, type: "danger" });
        } else {
            insights.push({ title: "Monitor Vitals", message: "Keep logging your vitals regularly. Consistent tracking helps detect trends early.", type: "info" });
        }
    } else {
        insights.push({ title: "Log Vitals", message: "Track blood pressure, heart rate, and blood sugar to receive personalized health trend analysis.", type: "info" });
    }

    return insights.slice(0, 4);
}

// ── Period filter helper (alias — delegates to the canonical filterByPeriod) ──
// All call sites that previously used adashFilterByPeriod now go through
// the single implementation above.
function adashFilterByPeriod(items, period, dateField) {
    return filterByPeriod(items, period, dateField);
}

// ── Analytics filter tab wiring ───────────────────────────────────────────────
// When the user clicks a period tab (7 Days / 30 Days / 90 Days / All Time):
//  1. Update the active tab highlight
//  2. Store the new period in adashCurrentPeriod
//  3. Re-run renderReports() — this rebuilds the chart + stat cards + badge
//  4. Re-render the BMI trend and vitals charts inside renderAnalyticsDashboard
//     (they are called by renderAnalyticsDashboard → already triggered inside renderReports)
function setupAnalyticsFilterTabs() {
    document.querySelectorAll(".analytics-filter-btn").forEach(btn => {
        btn.addEventListener("click", function () {
            // Active highlight
            document.querySelectorAll(".analytics-filter-btn").forEach(b => b.classList.remove("active"));
            this.classList.add("active");

            // Persist the new period
            const raw = this.dataset.period;
            adashCurrentPeriod = raw === "all" ? "all" : parseInt(raw, 10);

            if (!currentUser) return;

            // Re-render the full reports page with the new period — this is
            // the single trigger that updates chart, stat cards, alert banners,
            // mini chart, streak, AND the analytics dashboard below.
            renderReports();
        });
    });
}

// ── Vitals period tab wiring ───────────────────────────────────────────────────
function setupVitalsPeriodTabs() {
    document.querySelectorAll(".adash-vp-btn").forEach(btn => {
        btn.addEventListener("click", function () {
            document.querySelectorAll(".adash-vp-btn").forEach(b => b.classList.remove("active"));
            this.classList.add("active");
            adashCurrentVitalsPeriod = this.dataset.vperiod;

            if (!currentUser) return;
            adashRenderVitalsCharts(_analyticsVitalsHistory, adashCurrentVitalsPeriod);
        });
    });
}

// ── AI Insights refresh button ────────────────────────────────────────────────
function setupAdashAiRefresh() {
    const btn = document.getElementById("adash-ai-refresh-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
        if (!currentUser) return;
        btn.disabled = true;
        try {
            const [statsRes, bmiRes, vitalsRes, streakRes] = await Promise.all([
                authFetch(`${API_BASE}/logs/adherence/stats/${currentUser.id}`),
                authFetch(`${API_BASE}/bmi/recent/${currentUser.id}?limit=100`),
                authFetch(`${API_BASE}/vitals/recent/${currentUser.id}?limit=100`),
                // Use recalculate so the streak fed to AI insights has accurate
                // perfectDaysThisWeek / perfectDaysThisMonth values.
                authFetch(`${API_BASE}/streaks/recalculate/${currentUser.id}`, { method: "POST" })
            ]);
            const stats      = statsRes.ok  ? await statsRes.json()  : {};
            const bmiHistory = bmiRes.ok    ? (await bmiRes.json()).slice().reverse()    : [];
            const vitalsHist = vitalsRes.ok ? (await vitalsRes.json()).slice().reverse() : [];
            const streak     = streakRes.ok ? await streakRes.json() : {};
            adashAiInsightsCache = null; // force refresh
            await adashRenderAiInsights(stats, bmiHistory, vitalsHist, streak, true);
        } catch (err) {
            console.warn("[Analytics] AI refresh error:", err);
        } finally {
            btn.disabled = false;
        }
    });
}

// ── Wire up all analytics dashboard events on DOM ready ───────────────────────
document.addEventListener("DOMContentLoaded", () => {
    setupAnalyticsFilterTabs();
    setupVitalsPeriodTabs();
    setupAdashAiRefresh();
});

// ═══════════════════════════════════════════════════════════════════
//  END ANALYTICS DASHBOARD
// ═══════════════════════════════════════════════════════════════════

function stopReminderAudio() {
    if (activeReminderAudio) {
        activeReminderAudio.pause();
        activeReminderAudio.currentTime = 0;
        activeReminderAudio = null;
    }
}

// ── Audio: No AudioContext (avoids 'not allowed to start' errors) ────────────
// We use only the <audio id="notify-sound"> element. The element is primed
// (muted play → pause) on the first user gesture so that later unmuted calls
// from setTimeout / setInterval succeed. No Web Audio API is used.
let _audioCtx = null; // kept for backward compat, never used

// ── Audio unlock ───────────────────────────────────────────────────────────
// Browsers block unmuted audio.play() until the user has interacted with the
// page AND the audio element has been primed. We prime the element on the
// FIRST genuine user gesture (click/pointerdown/touchstart/keydown) using a
// MUTED play() — muted autoplay is ALWAYS allowed, so priming is guaranteed
// even if the gesture timing is imperfect. After priming, unmuted play() from
// setTimeout (reminders/missed-dose alerts) works for the rest of the session.
//
// We ALSO resume a single Web Audio AudioContext here, inside the gesture —
// that unlocks oscillator-based tones for setTimeout playback all session.
//
// NOTE: 'scroll' was previously in the listener list but is NOT a user
// activation, so it caused "play() failed because the user didn't interact"
// errors. Removed.
function primeAudioElement() {
    if (audioUnlocked) return Promise.resolve(true);
    const audio = document.getElementById("notify-sound");
    if (!audio) return Promise.resolve(false);

    audio.muted = true;
    const p = audio.play();
    if (p && typeof p.then === "function") {
        return p.then(() => {
            audio.pause();
            audio.currentTime = 0;
            audio.muted = false;
            audioUnlocked = true;
            console.log("[DoseBuddy] Audio unlocked");
            return true;
        }).catch(err => {
            audio.muted = false;
            // Autoplay still blocked — will retry on next genuine gesture.
            console.log("[DoseBuddy] Audio unlock attempt blocked:", err.message);
            return false;
        });
    }
    // Old browsers with no promise — optimistically consider unlocked.
    audio.muted = false;
    audioUnlocked = true;
    return Promise.resolve(true);
}

// Throttle repeated audio log messages so checkReminders (every 30s) can't spam.
let _lastAudioLogTs = 0;
function _logAudioThrottled(msg) {
    const now = Date.now();
    if (now - _lastAudioLogTs > 60000) {
        console.log(msg);
        _lastAudioLogTs = now;
    }
}

// ── Shared, authoritative notification-sound player ──────────────────────────
// Used by BOTH playReminderSound() (scheduled reminder) and
// playMissedDoseAlert() (PENDING → MISSED). One implementation, two entry points.
function _playNotifSound(label) {
    // 1. Respect user preference
    const prefs = loadFromLS(NOTIF_PREFS_KEY, { "sound-alerts": true });
    if (prefs["sound-alerts"] === false) {
        _logAudioThrottled(`[DoseBuddy] ${label}: sound alerts disabled`);
        return false;
    }

    const audio = document.getElementById("notify-sound");
    if (!audio) return false;
    if (audio.error) {
        console.warn(`[DoseBuddy] ${label}: audio element error`, audio.error.code, audio.error.message);
        return false;
    }

    // 2. Play the mp3 directly — no AudioContext, no tone.
    // The element was primed (muted play → pause) on the first user gesture
    // so unmuted play() from setInterval succeeds in Chrome/Edge/Safari.
    console.log(`[DoseBuddy] ${label}: attempting playback`);
    try {
        stopReminderAudio();
        audio.currentTime = 0;
        audio.volume = 1;
        audio.muted = false;
        audio.loop = false;
        const playPromise = audio.play();
        if (playPromise !== undefined && typeof playPromise.then === "function") {
            playPromise.then(() => {
                console.log(`[DoseBuddy] ${label}: playback started`);
                audioUnlocked = true;
                activeReminderAudio = audio;
            }).catch(err => {
                console.warn(`[DoseBuddy] ${label}: playback blocked — ${err.name}: ${err.message}`);
                audioUnlocked = false;
            });
        } else {
            activeReminderAudio = audio;
            audioUnlocked = true;
        }
        return true;
    } catch (e) {
        console.warn(`[DoseBuddy] ${label}: playback error — ${e.message}`);
        return false;
    }
}

// Scheduled medicine reminder sound (fires at the dose time via setTimeout)
function playReminderSound() {
    return _playNotifSound("Reminder audio");
}

// Missed-dose alert sound (fires at PENDING → MISSED transition, ~5 min late)
// Distinct entry point so the two events are never confused, even though they
// share the same asset + player.
function playMissedDoseAlert() {
    return _playNotifSound("Missed-dose audio");
}

function triggerDoseNotification(med, dateStr, displayTime) {
    console.log(`[DoseBuddy] triggerDoseNotification — med:"${med?.name}" time:${displayTime} date:${dateStr} user:${currentUser?.id}`);

    if (!currentUser) {
        console.log("[DoseBuddy] REMINDER SKIPPED (no currentUser)");
        return;
    }

    // Check if medicine-reminders pref is enabled (defaults true)
    const prefs = loadFromLS(NOTIF_PREFS_KEY, { "medicine-reminders": true });
    if (prefs["medicine-reminders"] === false) {
        console.log("[DoseBuddy] REMINDER SKIPPED (medicine-reminders preference is OFF)");
        return;
    }

    const key = `${currentUser.id}-${med.id}-${dateStr}-${displayTime}`;

    // Skip already-taken doses
    if (getDoseStatus(currentUser.id, med.id, dateStr, displayTime) === "TAKEN") {
        console.log(`[DoseBuddy] REMINDER SKIPPED (already taken): ${key}`);
        return;
    }

    // ── Strict deduplication ─────────────────────────────────────────────
    // firedReminderKeys persists for the entire calendar day.
    // It is ONLY cleared on logout or on a genuine date change.
    // It is never cleared by renderDashboard(), rescheduling, or re-rendering.
    if (firedReminderKeys.has(key)) {
        console.log(`[DoseBuddy] REMINDER BLOCKED (already fired today): ${key}`);
        return;
    }
    firedReminderKeys.add(key);
    console.log(`[DoseBuddy] REMINDER FIRED: userId=${currentUser.id} medId=${med.id} date=${dateStr} time=${displayTime} dedupKey=${key}`);

    // ── Always add to in-app notification panel ──────────────────────────
    addNotification(
        "reminder",
        `Time to take ${med.name}`,
        `${med.dosage} — scheduled at ${displayTime}`
    );

    // ── Always show in-app toast as a visible fallback ───────────────────
    showToast(`Reminder: ${med.name} (${med.dosage}) at ${displayTime}`, "info", 8000);

    // ── Browser Notification (if permission granted) ─────────────────────
    if ("Notification" in window && Notification.permission === "granted") {
        try {
            const notification = new Notification("DoseBuddy Reminder", {
                body: `Time to take ${med.name} (${med.dosage})`,
                icon: "https://cdn-icons-png.flaticon.com/512/2966/2966327.png",
                tag: key,          // browser deduplication by OS
                requireInteraction: false,
            });

            notification.onclick = () => {
                window.focus();
                switchView("dashboard-view");
                stopReminderAudio();
            };
        } catch (e) {
            console.warn("[DoseBuddy] Notification construction failed:", e.message);
        }
    }

    // ── Sound ─────────────────────────────────────────────────────────────
    playReminderSound();
}

function clearScheduledTimeouts() {
    scheduledTimeouts.forEach((id) => clearTimeout(id));
    scheduledTimeouts = [];
    // activeMissTimeouts are intentionally NOT cleared here — a reschedule
    // (e.g. user marks a dose taken) must not cancel an already-running
    // 5-minute miss-window for a different dose that was reminded earlier.
}

// Called only on logout and on hard reset — clears the miss-window timers too.
function clearMissTimeouts() {
    activeMissTimeouts.forEach((id) => clearTimeout(id));
    activeMissTimeouts = [];
}

// scheduleNotificationsForToday() has been removed.
// scheduleMedicineReminders() is the single scheduling system.
// See scheduleMedicineReminders() below.

// ── Update a single status cell in the dashboard table without re-rendering ──
// Called after mark-missed-batch so "Due now" → "Missed" immediately.
function _updateDashboardStatusCell(medId, timeStr, newStatus) {
    try {
        const rows = document.querySelectorAll(`tr.med-row-${medId}`);
        rows.forEach(tr => {
            // Find the time cell (td:nth-child(1)) and check it matches
            const timeCell = tr.querySelector("td:first-child");
            if (!timeCell) return;
            const rowTime = (timeCell.textContent || "").trim();
            if (rowTime !== timeStr) return;

            // Find the status pill (td:nth-child(5) .status-pill)
            const statusCell = tr.querySelector("td:nth-child(5)");
            if (!statusCell) return;
            const pill = statusCell.querySelector(".status-pill");
            if (!pill) return;

            if (newStatus === "MISSED") {
                pill.className = "status-pill status-missed";
                pill.textContent = "Missed";
                // Also disable the Mark taken button and show Missed button
                const actionCell = tr.querySelector("td:nth-child(6)");
                if (actionCell) {
                    const takeBtn = actionCell.querySelector(".action-btn-take");
                    if (takeBtn) {
                        takeBtn.textContent = "Missed";
                        takeBtn.className = "action-btn action-btn-disabled";
                        takeBtn.disabled = true;
                    }
                }
                // Update the left accent stripe color
                tr.style.setProperty("--row-accent", "var(--danger, #dc2626)");
            }
        });
    } catch (e) {
        // DOM update failed — non-critical, dashboard will reflect correct
        // state on next renderDashboard call.
    }
}

// ─── Interval-based reminder driver (every 30 s) ─────────────────────────────
// This is the ONLY mechanism that fires reminders and missed-dose alerts.
// The old setTimeout approach was wiped by every renderDashboard() call.
// Strategy:
//   - Runs every 30 s regardless of page state
//   - diff = nowMinutes - doseMinutes (positive = past, negative = future)
//   - Reminder: diff in [-1, 4]  → fires triggerDoseNotification (deduped)
//   - Missed:   diff > 5  AND status PENDING → mark missed + alert (deduped)
function checkReminders() {
    if (!currentUser) return;
    if (!medsCache || medsCache.length === 0) return;

    const now = new Date();
    const todayStr = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
    ].join("-");

    // Diagnostic — log every check so we can see the pipeline is running
    const nowTs = Date.now();
    if (nowTs - _lastCheckRemindersLog > 30000) {
        const nowMinutesDbg = now.getHours() * 60 + now.getMinutes();
        const times = medsCache.flatMap(m => (m.times || []).map(t => t.timeOfDay?.substring(0,5))).join(", ");
        console.log(`[DoseBuddy] checkReminders tick — ${now.getHours()}:${String(now.getMinutes()).padStart(2,"0")} | medsCacheDate=${medsCacheDate} todayStr=${todayStr} | doses: [${times}]`);
        _lastCheckRemindersLog = nowTs;
    }

    // If medsCacheDate is missing or stale, use medsCache anyway — it may be
    // a same-day load where medsCacheDate was not set correctly.
    // Only skip if cacheDate is a DIFFERENT day, not if it's missing.
    if (medsCacheDate && medsCacheDate !== todayStr) {
        console.log(`[DoseBuddy] checkReminders — SKIPPED: cache is for ${medsCacheDate}, not ${todayStr}`);
        return;
    }

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const toMarkMissed = [];

    for (const med of medsCache) {
        if (!isMedicationActiveToday(med, todayStr)) continue;
        if (!Array.isArray(med.times)) continue;

        for (const timeObj of med.times) {
            const rawTime = timeObj.timeOfDay || "";
            const displayTime = rawTime.substring(0, 5);
            if (!displayTime || displayTime.length < 5) {
                console.log(`[DoseBuddy] checkReminders SKIP: med="${med.name}" rawTime="${rawTime}"`);
                continue;
            }

            const [hh, mm] = displayTime.split(":").map(Number);
            if (isNaN(hh) || isNaN(mm)) {
                console.log(`[DoseBuddy] checkReminders SKIP parse: med="${med.name}" time="${displayTime}"`);
                continue;
            }

            const doseMinutes = hh * 60 + mm;
            const diff = nowMinutes - doseMinutes; // positive = past, negative = future

            // Always log so we can see exactly what's happening (not throttled)
            console.log(`[DoseBuddy] CHECK: med="${med.name}" dose=${displayTime} now=${nowMinutes}min dose=${doseMinutes}min diff=${diff}`);

            // ── Reminder window: [-1, 4] minutes around the dose time ────
            if (diff >= -1 && diff <= 4) {
                console.log(`[DoseBuddy] REMINDER WINDOW HIT: ${med.name} at ${displayTime}, diff=${diff}`);
                triggerDoseNotification(med, todayStr, displayTime);
            }

            // ── Missed: more than 5 min past and still PENDING ──────────
            if (diff > 5) {
                const status = getDoseStatus(currentUser.id, med.id, todayStr, displayTime);
                if (status !== "TAKEN" && status !== "MISSED") {
                    toMarkMissed.push({
                        userId:       currentUser.id,
                        medicationId: med.id,
                        date:         todayStr,
                        time:         displayTime
                    });
                }
            }
        }
    }

    if (toMarkMissed.length > 0) {
        authFetch(`${API_BASE}/logs/mark-missed-batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(toMarkMissed),
        })
        .then(() => {
            invalidateDataCache("/logs/today/", "/logs/summary/", "/logs/adherence/", "/streaks/");
            toMarkMissed.forEach(entry => {
                // Update in-memory logs so getDoseStatus returns MISSED immediately
                const existing = logs.find(
                    l => (l.medId === entry.medicationId || l.medicationId === entry.medicationId)
                      && l.date === entry.date && l.time === entry.time
                );
                if (!existing) {
                    logs.push({ medicationId: entry.medicationId, date: entry.date, time: entry.time, status: "MISSED" });
                } else {
                    existing.status = "MISSED";
                }

                // ── Update the status cell in the DOM immediately ──────────
                // This changes "Due now" → "Missed" without re-rendering
                // the entire dashboard (which would wipe all timeouts).
                _updateDashboardStatusCell(entry.medicationId, entry.time, "MISSED");

                // ── PENDING → MISSED: sound + in-app notification (once per dose) ──
                const missedAlertKey = `missed-${entry.userId}-${entry.medicationId}-${entry.date}-${entry.time}`;
                if (!firedMissedAlertKeys.has(missedAlertKey)) {
                    firedMissedAlertKeys.add(missedAlertKey);
                    const missedMed  = medsCache.find(m => String(m.id) === String(entry.medicationId));
                    const missedName = missedMed ? missedMed.name : "Medicine";

                    // In-app notification — addNotification persists to localStorage
                    addNotification(
                        "missed",
                        `Missed dose: ${missedName}`,
                        `Scheduled at ${entry.time} — not taken.`
                    );
                    playMissedDoseAlert();
                    console.log(`[DoseBuddy] MISSED ALERT: ${missedAlertKey}`);
                }
            });
            // Refresh charts and activity without wiping the notification store
            renderReports(logs);
            refreshActivityFeed();
        })
        .catch(err => console.error("[DoseBuddy] checkReminders missed-batch error:", err));
    }
}

// ─── Single reminder driver (interval-based, replaces setTimeout scheduling) ──
// Strategy: instead of fragile per-dose setTimeout timers (which were cleared by
// every renderDashboard() call), we use ONE setInterval that wakes every 30 s and
// checks every dose directly. This is the ONLY mechanism that fires reminders and
// missed-dose alerts. scheduleMedicineReminders() is kept for backward compat but
// now only does dedup-key housekeeping (no more setTimeout timers).
//
// Reminder fires when: nowMinutes - doseMinutes is in [0, 4] → grace window of 4 min
// Missed fires when:   nowMinutes - doseMinutes > 5  AND status is PENDING
// Both are deduped by their respective Sets.

function scheduleMedicineReminders() {
    // Keep only day-rollover cleanup — no more setTimeout timers that get wiped
    // by the next renderDashboard() call.
    if (!medsCache || medsCache.length === 0) return;

    const now = new Date();
    const today = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
    ].join("-");

    if (_lastScheduledDate !== "" && _lastScheduledDate !== today) {
        firedReminderKeys.clear();
        firedMissedAlertKeys.clear();
        console.log("[DoseBuddy] New calendar day — cleared dedup keys.");
    }
    _lastScheduledDate = today;

    console.log(`[DoseBuddy] scheduleMedicineReminders — ${medsCache.length} med(s) in cache for ${today}, medsCacheDate=${medsCacheDate}`);
}

// ─── AI request lock ────────────────────────────────────────────────────────
// Ensures only ONE AI request is in-flight at any time across all AI features.
let _aiRequestInFlight = false;

function _aiLock() {
    if (_aiRequestInFlight) {
        console.log("[AI] Duplicate request prevented");
        return false;
    }
    _aiRequestInFlight = true;
    console.log("[AI] Sending OpenRouter request");
    return true;
}

function _aiUnlock() {
    _aiRequestInFlight = false;
    console.log("[AI] Request completed");
}
// ────────────────────────────────────────────────────────────────────────────

function setupAiHandlers() {

    const aiBtn = document.getElementById("ai-med-search-btn");
    const aiInput = document.getElementById("ai-med-search-input");

    if (aiBtn) {
        aiBtn.addEventListener("click", searchAiMedicineInfo);
    }
    if (aiInput) {
        // Debounce: ignore Enter key if pressed within 500 ms of the last call
        let _aiDashDebounce = null;
        aiInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                clearTimeout(_aiDashDebounce);
                _aiDashDebounce = setTimeout(searchAiMedicineInfo, 300);
            }
        });
    }

    const aiSubmitView = document.getElementById("ai-submit-view");
    const aiQueryView = document.getElementById("ai-query-view");

    if (aiSubmitView) {
        aiSubmitView.addEventListener("click", searchAiMedicineInfoView);
    }
    if (aiQueryView) {
        aiQueryView.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                searchAiMedicineInfoView();
            }
        });
    }

    const symptomSubmitView = document.getElementById("symptom-submit-view");
    const symptomQueryView = document.getElementById("symptom-query-view");

    if (symptomSubmitView) {
        symptomSubmitView.addEventListener("click", checkSymptomsView);
    }
    if (symptomQueryView) {
        symptomQueryView.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                checkSymptomsView();
            }
        });
    }

    document.querySelectorAll(".ai-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            const targetId = chip.dataset.target;
            const input = document.getElementById(targetId);
            if (input) {
                input.value = chip.textContent.trim();
                input.focus();
            }
        });
    });
}

async function searchAiMedicineInfo() {
    const input = document.getElementById("ai-med-search-input");
    const resultBox = document.getElementById("ai-med-search-result");

    if (!input || !resultBox) return;

    const name = input.value.trim();
    if (!name) {
        resultBox.textContent = "Please enter a medicine name.";
        return;
    }

    if (!_aiLock()) {
        resultBox.textContent = "Another AI request is in progress. Please wait a moment.";
        return;
    }

    resultBox.textContent = "Thinking with AI...";

    try {
        // FIX: use authFetch so the JWT Authorization header is included.
        // Raw fetch() was sending the request without a token, causing the
        // backend to return 401 (Spring Security requires auth on all /api/**
        // endpoints except /api/auth/**), which the frontend displayed as
        // "Could not get information."
        const res = await authFetch(
            `${API_BASE}/medicine/ai-info?name=${encodeURIComponent(name)}&userId=${currentUser ? currentUser.id : ""}`
        );

        if (!res.ok) {
            resultBox.textContent = "Could not get information. Try again.";
            return;
        }

        const text = await res.text();
        resultBox.innerHTML = formatMedicineResponse(text);
    } catch (err) {
        console.error(err);
        resultBox.textContent = "Error connecting to server.";
    } finally {
        _aiUnlock();
    }
}

async function searchAiMedicineInfoView() {
    const input = document.getElementById("ai-query-view");
    const resultBox = document.getElementById("ai-response-view");
    const submitBtn = document.getElementById("ai-submit-view");

    if (!input || !resultBox) return;

    const query = input.value.trim();
    if (!query) {
        showToast("Please enter a question about medicines", "warning");
        return;
    }

    if (!_aiLock()) {
        resultBox.style.display = "block";
        resultBox.textContent = "Another AI request is in progress. Please wait a moment.";
        return;
    }

    resultBox.style.display = "block";
    resultBox.textContent = "Thinking with AI...";
    setButtonLoading(submitBtn, true, "Processing...");

    try {
        // FIX: use authFetch so the JWT Authorization header is included.
        // Raw fetch() was sending the request without a token, causing 401
        // which the frontend displayed as "Could not get information."
        const res = await authFetch(
            `${API_BASE}/medicine/ai-info?name=${encodeURIComponent(query)}&userId=${currentUser ? currentUser.id : ""}`
        );

        if (!res.ok) {
            resultBox.textContent = "Could not get information. Please try again.";
            return;
        }

        const text = await res.text();
        resultBox.innerHTML = formatMedicineResponse(text);
    } catch (err) {
        console.error(err);
        resultBox.textContent = "Error connecting to server.";
    } finally {
        setButtonLoading(submitBtn, false, "Ask AI");
        _aiUnlock();
    }
}

async function checkSymptomsView() {
    const input = document.getElementById("symptom-query-view");
    const resultBox = document.getElementById("symptom-response-view");
    const submitBtn = document.getElementById("symptom-submit-view");

    if (!input || !resultBox) return;

    const symptoms = input.value.trim();
    if (!symptoms) {
        showToast("Please describe your symptoms", "warning");
        return;
    }

    if (!_aiLock()) {
        resultBox.style.display = "block";
        resultBox.textContent = "Another AI request is in progress. Please wait a moment.";
        return;
    }

    resultBox.style.display = "block";
    resultBox.textContent = "Analyzing symptoms with AI...";
    setButtonLoading(submitBtn, true, "Analyzing...");

    try {
        const res = await authFetch(`${API_BASE}/medicine/symptom-check`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ symptoms: symptoms })
        });

        if (!res.ok) {
            resultBox.textContent = "Could not analyze symptoms. Please try again.";
            return;
        }

        const text = await res.text();
        resultBox.innerHTML = formatAiText(text);
    } catch (err) {
        console.error(err);
        resultBox.textContent = "Server error. Please try again.";
    } finally {
        setButtonLoading(submitBtn, false, "Check Symptoms");
        _aiUnlock();
    }
}

document.addEventListener("click", async function(e){

    if(e.target && e.target.id === "symptom-check-btn"){

        const input = document.getElementById("symptom-input");
        const result = document.getElementById("symptom-result");

        const symptoms = input.value.trim();

        if(!symptoms){
            result.textContent = "Please enter symptoms.";
            return;
        }

        if (!_aiLock()) {
            result.textContent = "Another AI request is in progress. Please wait a moment.";
            return;
        }

        result.textContent = "Analyzing symptoms with AI...";

        try{

            const res = await authFetch(`${API_BASE}/medicine/symptom-check`,{
                method:"POST",
                headers:{
                    "Content-Type":"application/json"
                },
                body: JSON.stringify({symptoms:symptoms})
            });

            if(!res.ok){
                result.textContent = "Could not analyze symptoms.";
                return;
            }

            const text = await res.text();

           result.innerHTML = formatAiText(text);

        }catch(err){
            console.error(err);
            result.textContent = "Server error.";
        } finally {
            _aiUnlock();
        }
    }

});

function setupBmiCalculator() {
    // Dashboard BMI calculator
    const calculateBtn = document.getElementById("calculate-bmi-btn");
    const heightInput = document.getElementById("bmi-height");
    const weightInput = document.getElementById("bmi-weight");

    if (calculateBtn) {
        calculateBtn.addEventListener("click", calculateBmi);
    }

    if (heightInput && weightInput) {
        heightInput.addEventListener("input", () => {
            if (heightInput.value && weightInput.value) {
                calculateBmiPreview();
            }
        });
        weightInput.addEventListener("input", () => {
            if (heightInput.value && weightInput.value) {
                calculateBmiPreview();
            }
        });
    }

    const calculateBtnView = document.getElementById("calculate-bmi-view-btn");
    const heightInputView = document.getElementById("bmi-height-view");
    const weightInputView = document.getElementById("bmi-weight-view");

    if (calculateBtnView) {
        calculateBtnView.addEventListener("click", calculateBmiView);
    }

    if (heightInputView && weightInputView) {
        heightInputView.addEventListener("input", () => {
            if (heightInputView.value && weightInputView.value) {
                calculateBmiPreviewView();
            }
        });
        weightInputView.addEventListener("input", () => {
            if (heightInputView.value && weightInputView.value) {
                calculateBmiPreviewView();
            }
        });
    }

    if (currentUser) {
        loadLatestBmi();
    }
}

function calculateBmiPreview() {
    const height = parseFloat(document.getElementById("bmi-height").value);
    const weight = parseFloat(document.getElementById("bmi-weight").value);

    if (!height || !weight || height <= 0 || weight <= 0) return;

    const heightInMeters = height / 100;
    const bmi = weight / (heightInMeters * heightInMeters);
    const bmiRounded = Math.round(bmi * 10) / 10;

    displayBmiResult({
        bmiValue: bmiRounded,
        bmiCategory: determineBmiCategory(bmiRounded),
        preview: true
    });
}

function calculateBmiPreviewView() {
    const height = parseFloat(document.getElementById("bmi-height-view").value);
    const weight = parseFloat(document.getElementById("bmi-weight-view").value);

    if (!height || !weight || height <= 0 || weight <= 0) return;

    const heightInMeters = height / 100;
    const bmi = weight / (heightInMeters * heightInMeters);
    const bmiRounded = Math.round(bmi * 10) / 10;

    displayBmiResultView({
        bmiValue: bmiRounded,
        bmiCategory: determineBmiCategory(bmiRounded),
        preview: true
    });
}

async function calculateBmi() {
    if (!currentUser) {
        showToast("Please login first", "error");
        return;
    }

    const heightInput = document.getElementById("bmi-height");
    const weightInput = document.getElementById("bmi-weight");
    const calculateBtn = document.getElementById("calculate-bmi-btn");

    const height = parseFloat(heightInput.value);
    const weight = parseFloat(weightInput.value);

    if (!height || !weight) {
        showToast("Please enter both height and weight", "warning");
        return;
    }

    if (height < 50 || height > 300) {
        showToast("Height must be between 50 and 300 cm", "warning");
        return;
    }

    if (weight < 20 || weight > 500) {
        showToast("Weight must be between 20 and 500 kg", "warning");
        return;
    }

    setButtonLoading(calculateBtn, true, "Calculating...");

    try {
        const response = await authFetch(`${API_BASE}/bmi/calculate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                userId: currentUser.id,
                height: height,
                weight: weight
            })
        });

        if (!response.ok) {
            const error = await response.json();
            showToast(error.message || "Failed to calculate BMI", "error");
            return;
        }

        const data = await response.json();
        displayBmiResult(data);
        displayHealthInsights(data);
        displayBmiResultView(data);
        displayHealthInsightsView(data);

        invalidateDataCache("/bmi/", "/activities/");
        _jsonCache.set(`${API_BASE}/bmi/latest/${currentUser.id}`, { data, at: Date.now() });

        showToast("BMI calculated successfully!", "success");
        try { await refreshActivityFeed(); } catch(e) {}

        const bmiVal = data.bmiValue ? data.bmiValue.toFixed(1) : "?";
        const bmiCat = data.bmiCategory || "";

    } catch (error) {
        console.error("BMI calculation error:", error);
        showToast("Failed to calculate BMI", "error");
    } finally {
        setButtonLoading(calculateBtn, false, "Calculate BMI");
    }
}

async function calculateBmiView() {
    if (!currentUser) {
        showToast("Please login first", "error");
        return;
    }

    const heightInput = document.getElementById("bmi-height-view");
    const weightInput = document.getElementById("bmi-weight-view");
    const calculateBtn = document.getElementById("calculate-bmi-view-btn");

    const height = parseFloat(heightInput.value);
    const weight = parseFloat(weightInput.value);


    if (!height || !weight) {
        showToast("Please enter both height and weight", "warning");
        return;
    }

    if (height < 50 || height > 300) {
        showToast("Height must be between 50 and 300 cm", "warning");
        return;
    }

    if (weight < 20 || weight > 500) {
        showToast("Weight must be between 20 and 500 kg", "warning");
        return;
    }

    setButtonLoading(calculateBtn, true, "Calculating...");

    try {
        const response = await authFetch(`${API_BASE}/bmi/calculate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                userId: currentUser.id,
                height: height,
                weight: weight
            })
        });

        if (!response.ok) {
            const error = await response.json();
            showToast(error.message || "Failed to calculate BMI", "error");
            return;
        }

        const data = await response.json();
        displayBmiResult(data);
        displayHealthInsights(data);
        displayBmiResultView(data);
        displayHealthInsightsView(data);

        invalidateDataCache("/bmi/", "/activities/");
        _jsonCache.set(`${API_BASE}/bmi/latest/${currentUser.id}`, { data, at: Date.now() });

        showToast("BMI calculated successfully!", "success");
        try { await refreshActivityFeed(); } catch(e) {}

    } catch (error) {
        console.error("BMI calculation error:", error);
        showToast("Failed to calculate BMI", "error");
    } finally {
        setButtonLoading(calculateBtn, false, "Calculate BMI");
    }
}

async function loadLatestBmi() {
    if (!currentUser) return;

    try {
        const data = await fetchJsonCached(`${API_BASE}/bmi/latest/${currentUser.id}`, 15000);
        
        if (data) {
            const h = document.getElementById("bmi-height");
            const w = document.getElementById("bmi-weight");
            if (h && data.height) h.value = data.height;
            if (w && data.weight) w.value = data.weight;

            const hv = document.getElementById("bmi-height-view");
            const wv = document.getElementById("bmi-weight-view");
            if (hv && data.height) hv.value = data.height;
            if (wv && data.weight) wv.value = data.weight;

            displayBmiResult(data);
            displayHealthInsights(data);
            displayBmiResultView(data);
            displayHealthInsightsView(data);
        }
    } catch (error) {
    }
}

function displayBmiResult(data) {
    const resultSection = document.getElementById("bmi-result-section");
    const valueDisplay = document.getElementById("bmi-value-display");
    const statusBadge = document.getElementById("bmi-status-badge");
    const statusIcon = document.getElementById("bmi-status-icon");
    const statusText = document.getElementById("bmi-status-text");

    if (!resultSection) return;

    resultSection.style.display = "block";
    valueDisplay.textContent = data.bmiValue.toFixed(1);

    const category = data.bmiCategory || determineBmiCategory(data.bmiValue);
    const categoryInfo = getBmiCategoryInfo(category);

    statusBadge.className = "bmi-status-badge " + categoryInfo.className;
    if (statusIcon) statusIcon.innerHTML = categoryInfo.iconSvg;
    if (statusText) statusText.textContent = categoryInfo.label;
}

function displayBmiResultView(data) {
    const resultSection = document.getElementById("bmi-result-section-view");
    const valueDisplay = document.getElementById("bmi-value-display-view");
    const statusBadge = document.getElementById("bmi-status-badge-view");
    const statusIcon = document.getElementById("bmi-status-icon-view");
    const statusText = document.getElementById("bmi-status-text-view");

    if (!resultSection) return;

    resultSection.style.display = "block";
    valueDisplay.textContent = data.bmiValue.toFixed(1);

    const category = data.bmiCategory || determineBmiCategory(data.bmiValue);
    const categoryInfo = getBmiCategoryInfo(category);

    statusBadge.className = "bmi-status-badge " + categoryInfo.className;
    if (statusIcon) statusIcon.innerHTML = categoryInfo.iconSvg;
    if (statusText) statusText.textContent = categoryInfo.label;
}

function displayHealthInsights(data) {
    const emptyContent = document.querySelector(".health-insights-empty");
    const suggestionsSection = document.getElementById("health-suggestions-section");
    const healthList = document.getElementById("health-suggestions-list");
    const dietList = document.getElementById("diet-recommendations-list");

    if (!suggestionsSection) return;
    if (emptyContent) emptyContent.style.display = "none";
    suggestionsSection.style.display = "flex";

    if (healthList && data.healthSuggestions) {
        healthList.innerHTML = "";
        data.healthSuggestions.forEach(suggestion => {
            const li = document.createElement("li");
            li.textContent = suggestion;
            healthList.appendChild(li);
        });
    }

    if (dietList && data.dietRecommendations) {
        dietList.innerHTML = "";
        data.dietRecommendations.forEach(recommendation => {
            const li = document.createElement("li");
            li.textContent = recommendation;
            dietList.appendChild(li);
        });
    }
}

function displayHealthInsightsView(data) {
    const contentDiv = document.getElementById("health-insights-content-view");
    
    if (!contentDiv) return;

    let insightsHTML = '<div class="health-insights-results">';
    
    if (data.healthSuggestions && data.healthSuggestions.length > 0) {
        insightsHTML += '<div class="insight-section">';
        insightsHTML += '<h4 class="insight-section-title">Health Suggestions</h4>';
        insightsHTML += '<ul class="insight-list">';
        data.healthSuggestions.forEach(suggestion => {
            insightsHTML += `<li>${escapeHtml(suggestion)}</li>`;
        });
        insightsHTML += '</ul></div>';
    }
    
    if (data.dietRecommendations && data.dietRecommendations.length > 0) {
        insightsHTML += '<div class="insight-section">';
        insightsHTML += '<h4 class="insight-section-title">Diet Recommendations</h4>';
        insightsHTML += '<ul class="insight-list">';
        data.dietRecommendations.forEach(recommendation => {
            insightsHTML += `<li>${escapeHtml(recommendation)}</li>`;
        });
        insightsHTML += '</ul></div>';
    }
    
    insightsHTML += '</div>';
    
    contentDiv.innerHTML = insightsHTML;
}

function determineBmiCategory(bmi) {
    if (bmi < 18.5) return "UNDERWEIGHT";
    if (bmi < 25.0) return "NORMAL";
    if (bmi < 30.0) return "OVERWEIGHT";
    return "OBESE";
}

function getBmiCategoryInfo(category) {
    const categories = {
        "UNDERWEIGHT": {
            label: "Underweight (< 18.5)",
            iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="14" height="14" style="display:inline-block;vertical-align:middle;margin-right:4px;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>`,
            className: "status-underweight"
        },
        "NORMAL": {
            label: "Healthy Weight (18.5 – 24.9)",
            iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="14" height="14" style="display:inline-block;vertical-align:middle;margin-right:4px;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
            className: "status-normal"
        },
        "OVERWEIGHT": {
            label: "Overweight (25 – 29.9)",
            iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="14" height="14" style="display:inline-block;vertical-align:middle;margin-right:4px;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>`,
            className: "status-overweight"
        },
        "OBESE": {
            label: "Obese (≥ 30)",
            iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="14" height="14" style="display:inline-block;vertical-align:middle;margin-right:4px;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>`,
            className: "status-obese"
        }
    };

    return categories[category] || categories["NORMAL"];
}

function setupThemeFromStorage() {
    const stored = localStorage.getItem("theme");
    const initial = stored === "dark" ? "dark" : "light";
    if (currentUser && getRefreshToken()) {
        applyTheme(initial);
    } else {
        document.body.classList.remove("dark-mode");
    }
    const btnMenu = document.getElementById("menu-theme-toggle");
    const checkbox = document.getElementById("theme-toggle-checkbox");

    if (btnMenu) {
        btnMenu.addEventListener("click", () => {
            const next = document.body.classList.contains("dark-mode")
                ? "light"
                : "dark";
            applyTheme(next);
        });
    }

    if (checkbox) {
        checkbox.addEventListener("change", () => {
            const next = checkbox.checked ? "dark" : "light";
            applyTheme(next);
        });
    }

    updateThemeButtons();
}

function applyTheme(mode) {
    if (mode === "dark") {
        document.body.classList.add("dark-mode");
    } else {
        document.body.classList.remove("dark-mode");
    }
    localStorage.setItem("theme", mode);
    updateThemeButtons();
    updateChartColors(mode === "dark");
}

function updateChartColors(isDark) {
    const takenBg     = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,161,155,0.18)";
    const takenBorder = isDark ? "#e8e8e8"                : "#00A19B";
    const missedBg    = isDark ? "rgba(248,113,113,0.15)" : "rgba(220,38,38,0.15)";
    const missedBorder= isDark ? "#f87171"                : "#dc2626";
    const gridColor   = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    const tickColor   = isDark ? "#555555"                : "#8c8278";

    Chart.instances && Object.values(Chart.instances).forEach(chart => {
        if (!chart || !chart.data || !chart.data.datasets) return;
        chart.data.datasets.forEach(ds => {
            if (ds.label === "Taken") {
                ds.backgroundColor = takenBg;
                ds.borderColor     = takenBorder;
            } else if (ds.label === "Missed") {
                ds.backgroundColor = missedBg;
                ds.borderColor     = missedBorder;
            }
        });
        if (chart.options.scales) {
            ["x","y"].forEach(axis => {
                if (chart.options.scales[axis]) {
                    if (chart.options.scales[axis].grid)
                        chart.options.scales[axis].grid.color = gridColor;
                    if (chart.options.scales[axis].ticks)
                        chart.options.scales[axis].ticks.color = tickColor;
                }
            });
        }
        if (chart.options.plugins?.legend?.labels)
            chart.options.plugins.legend.labels.color = isDark ? "#a8a8a8" : "#4a4540";
        chart.update("none");
    });

    if (missedMiniChart) {
        const miniBarBg     = isDark ? "rgba(248,113,113,0.55)" : "rgba(220,38,38,0.45)";
        const miniBarBorder = isDark ? "#f87171" : "#dc2626";
        const miniGrid      = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
        const miniTick      = isDark ? "#555555" : "#8c8278";
        missedMiniChart.data.datasets[0].backgroundColor = miniBarBg;
        missedMiniChart.data.datasets[0].borderColor = miniBarBorder;
        if (missedMiniChart.options.scales) {
            ["x","y"].forEach(axis => {
                if (missedMiniChart.options.scales[axis]) {
                    if (missedMiniChart.options.scales[axis].grid)
                        missedMiniChart.options.scales[axis].grid.color = miniGrid;
                    if (missedMiniChart.options.scales[axis].ticks)
                        missedMiniChart.options.scales[axis].ticks.color = miniTick;
                }
            });
        }
        missedMiniChart.update("none");
    }
}

function updateThemeButtons() {
    const btnMenu  = document.getElementById("menu-theme-toggle");
    const checkbox = document.getElementById("theme-toggle-checkbox");
    const text     = document.getElementById("theme-toggle-text");
    const isDark   = document.body.classList.contains("dark-mode");

    if (checkbox) checkbox.checked = isDark;
    if (text)     text.textContent = isDark ? "Light mode" : "Dark mode";

    if (btnMenu) {
        const label = btnMenu.querySelector(".sidebar-theme-label");
        const pill  = btnMenu.querySelector(".sidebar-theme-pill");
        if (label) label.textContent = isDark ? "Light Mode" : "Dark Mode";
        if (pill)  pill.classList.toggle("pill-on", isDark);
    }
}

function setupNotificationsUI(){
    const bell  = document.getElementById("notification-bell");
    const panel = document.getElementById("notification-panel");
    if (!bell || !panel) return;

    bell.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = panel.classList.contains("notif-panel-open");
        panel.classList.toggle("notif-panel-open", !isOpen);
        if (!isOpen) renderNotificationPanel();
    });

    document.addEventListener("click", (e) => {
        if (!panel.contains(e.target) && e.target !== bell) {
            panel.classList.remove("notif-panel-open");
        }
    });
}

// Section config for Medicine Assistant structured response
const MED_SECTIONS = [
    { key: "MEDICINE OVERVIEW",       icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/></svg>`, label: "Medicine Overview"       },
    { key: "DOSAGE INFORMATION",      icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`, label: "Dosage Information"      },
    { key: "COMMON USES",             icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`, label: "Common Uses"             },
    { key: "WARNINGS & PRECAUTIONS",  icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>`, label: "Warnings & Precautions" },
    { key: "SIDE EFFECTS",            icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>`, label: "Side Effects"            },
    { key: "WHEN TO CONSULT A DOCTOR",icon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"/></svg>`, label: "When to Consult a Doctor"},
];

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderMarkdown(text) {
    if (!text) return "";

    const lines = text.split("\n");
    let html = "";
    let i = 0;
    let inList = false;
    let inOrderedList = false;
    let inTable = false;
    let tableRows = [];

    function flushList() {
        if (inList) { html += "</ul>"; inList = false; }
        if (inOrderedList) { html += "</ol>"; inOrderedList = false; }
    }

    function flushTable() {
        if (!inTable) return;
        inTable = false;
        if (tableRows.length < 2) { tableRows = []; return; }
        html += '<div class="ai-table-wrap"><table class="ai-table">';
        tableRows.forEach((row, idx) => {
            const tag = idx === 0 ? "th" : "td";
            const cells = row.split("|").map(c => c.trim()).filter((c, ci, arr) => ci > 0 && ci < arr.length - 1);
            if (idx === 1 && cells.every(c => /^[-: ]+$/.test(c))) return; // skip separator row
            html += "<tr>" + cells.map(c => `<${tag}>${inlineFormat(c)}</${tag}>`).join("") + "</tr>";
        });
        html += "</table></div>";
        tableRows = [];
    }

    function inlineFormat(str) {
        return str
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/\*(.+?)\*/g, "<em>$1</em>")
            .replace(/`(.+?)`/g, "<code>$1</code>");
    }

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // Table row
        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
            flushList();
            inTable = true;
            tableRows.push(trimmed);
            i++; continue;
        } else if (inTable) {
            flushTable();
        }

        // Headings
        const hMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
        if (hMatch) {
            flushList();
            const level = Math.min(hMatch[1].length + 1, 4);
            html += `<h${level} class="ai-h${level}">${inlineFormat(hMatch[2])}</h${level}>`;
            i++; continue;
        }

        // Horizontal rule
        if (/^[-*_]{3,}$/.test(trimmed)) {
            flushList(); html += "<hr class='ai-hr'>"; i++; continue;
        }

        // Unordered list
        const ulMatch = trimmed.match(/^[-*•]\s+(.+)/);
        if (ulMatch) {
            if (!inList) { flushList(); html += '<ul class="ai-ul">'; inList = true; }
            html += `<li>${inlineFormat(ulMatch[1])}</li>`;
            i++; continue;
        }

        // Ordered list
        const olMatch = trimmed.match(/^\d+\.\s+(.+)/);
        if (olMatch) {
            if (!inOrderedList) { flushList(); html += '<ol class="ai-ol">'; inOrderedList = true; }
            html += `<li>${inlineFormat(olMatch[1])}</li>`;
            i++; continue;
        }

        // Empty line — close open blocks
        if (!trimmed) {
            flushList();
            i++; continue;
        }

        // Bold-only line (acts as a section heading)
        const boldLine = trimmed.match(/^\*\*(.+)\*\*:?$/);
        if (boldLine) {
            flushList();
            html += `<p class="ai-bold-heading">${inlineFormat(trimmed)}</p>`;
            i++; continue;
        }

        // Normal paragraph
        flushList();
        html += `<p class="ai-p">${inlineFormat(trimmed)}</p>`;
        i++;
    }

    flushList();
    flushTable();

    return `<div class="ai-response-body">${html}</div>`;
}

function formatMedicineResponse(text) {
    if (!text) return "";
    return renderMarkdown(text);
}

function formatAiText(text) {
    if (!text) return "";
    return renderMarkdown(text);
}

function setupPrescriptionUpload() {
    const fileInput     = document.getElementById("prescription-file-input");
    const browseBtn     = document.getElementById("prescription-browse-btn");
    const dropZone      = document.getElementById("prescription-drop-zone");
    const filesListEl   = document.getElementById("prescription-files-list");
    const autofillBtn   = document.getElementById("prescription-autofill-btn");
    const errorEl       = document.getElementById("prescription-error");
    const infoEl        = document.getElementById("prescription-info");

    const reviewSection = null; // removed — now uses modal
    const countEl       = null; // removed — now uses #prx-modal-count
    const metaBar       = null; // removed — now uses #prx-modal-meta
    const medsListEl    = null; // removed — now uses #prx-modal-body
    const saveAllBtn    = null; // removed — now uses #prx-modal-add-btn
    const cancelBtn     = null; // removed — now uses #prx-modal-cancel-btn

    if (!fileInput || !browseBtn || !dropZone || !autofillBtn) {
        console.warn("[Prescription] Setup skipped — elements not found in DOM.");
        return;
    }

    // State: multiple uploaded files
    let uploadedFiles = [];
    let currentExtractedMeds = [];

    function formatFileSize(bytes) {
        if (!bytes || bytes <= 0) return "0 B";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function clearAllUploadedFiles() {
        uploadedFiles = [];
        currentExtractedMeds = [];
        if (fileInput) fileInput.value = "";
        renderFileList();
        if (errorEl) errorEl.textContent = "";
        if (infoEl) {
            infoEl.textContent = "";
            infoEl.style.color = "";
        }
        // Close modal if open (defined later in this scope — safe optional call)
        if (typeof closePrescriptionModal === "function") closePrescriptionModal();
    }

    function removeFileById(fileId) {
        uploadedFiles = uploadedFiles.filter(f => f.id !== fileId);
        renderFileList();
        if (errorEl) errorEl.textContent = "";
        if (uploadedFiles.length === 0) {
            if (fileInput) fileInput.value = "";
            if (infoEl) {
                infoEl.textContent = "";
                infoEl.style.color = "";
            }
        } else {
            if (infoEl) {
                infoEl.textContent = `${uploadedFiles.length} file(s) selected`;
                infoEl.style.color = "var(--text-secondary)";
            }
        }
    }

    function renderFileList() {
        if (!filesListEl) return;
        if (uploadedFiles.length === 0) {
            filesListEl.style.display = "none";
            filesListEl.innerHTML = "";
            return;
        }

        filesListEl.style.display = "flex";
        filesListEl.innerHTML = uploadedFiles.map(f => {
            const thumbHtml = f.isImage && f.thumbUrl
                ? `<img src="${f.thumbUrl}" alt="Prescription thumbnail" class="upload-file-thumb" />`
                : `<div class="upload-file-doc-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="20" height="20">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
                    </svg>
                   </div>`;

            return `
                <div class="upload-file-card" data-id="${f.id}">
                    <div class="upload-file-left">
                        ${thumbHtml}
                        <div class="upload-file-meta">
                            <span class="upload-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
                            <span class="upload-file-size">${formatFileSize(f.size)}</span>
                        </div>
                    </div>
                    <button type="button" class="upload-file-remove-btn" data-id="${f.id}" title="Remove file" aria-label="Remove ${escapeHtml(f.name)}">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" width="14" height="14">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
            `;
        }).join("");

        // Attach individual remove handlers
        filesListEl.querySelectorAll(".upload-file-remove-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = btn.getAttribute("data-id");
                removeFileById(id);
            });
        });
    }

    browseBtn.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files.length > 0) {
            handleFilesSelect(Array.from(fileInput.files));
        }
    });

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFilesSelect(Array.from(e.dataTransfer.files));
        }
    });

    async function handleFilesSelect(files) {
        if (!files || files.length === 0) return;
        errorEl.textContent = "";
        infoEl.textContent = "";
        infoEl.style.color = "";
        if (typeof closePrescriptionModal === "function") closePrescriptionModal();

        for (const file of files) {
            // Check for duplicate by name and size
            const alreadyExists = uploadedFiles.some(f => f.name === file.name && f.size === file.size);
            if (alreadyExists) continue;

            const isImage = file.type.startsWith("image/");
            const fileItem = {
                id: `prx_file_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                file: file,
                name: file.name,
                size: file.size,
                type: file.type || "application/octet-stream",
                isImage: isImage,
                thumbUrl: null,
                preprocessedBase64: null
            };

            if (isImage) {
                try {
                    const res = await preprocessImageAutoOrient(file);
                    fileItem.preprocessedBase64 = res.base64;
                    fileItem.thumbUrl = res.base64;
                } catch (imgErr) {
                    console.warn("[Prescription] Image preprocessing fallback:", imgErr);
                    fileItem.thumbUrl = URL.createObjectURL(file);
                }
            }

            uploadedFiles.push(fileItem);
        }

        renderFileList();

        if (uploadedFiles.length > 0) {
            infoEl.textContent = `${uploadedFiles.length} file(s) attached and ready for AI extraction.`;
            infoEl.style.color = "var(--text-secondary)";
        }
    }

    /**
     * Reads EXIF orientation from a JPEG/HEIC file.
     * Returns 1–8 per EXIF spec, or 1 (no rotation) on failure.
     */
    function readExifOrientation(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const buf = e.target.result;
                    const view = new DataView(buf);
                    // Must start with JPEG SOI marker
                    if (view.getUint16(0) !== 0xFFD8) { resolve(1); return; }
                    let offset = 2;
                    while (offset < view.byteLength - 2) {
                        const marker = view.getUint16(offset);
                        offset += 2;
                        if (marker === 0xFFE1) { // APP1 (EXIF)
                            // Check for "Exif\0\0"
                            if (view.getUint32(offset + 2) !== 0x45786966 || view.getUint16(offset + 6) !== 0x0000) {
                                resolve(1); return;
                            }
                            const tiffStart = offset + 8;
                            const littleEndian = view.getUint16(tiffStart) === 0x4949;
                            const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
                            const ifdEntries = view.getUint16(tiffStart + ifdOffset, littleEndian);
                            for (let i = 0; i < ifdEntries; i++) {
                                const entryOffset = tiffStart + ifdOffset + 2 + i * 12;
                                if (view.getUint16(entryOffset, littleEndian) === 0x0112) {
                                    resolve(view.getUint16(entryOffset + 8, littleEndian));
                                    return;
                                }
                            }
                            resolve(1); return;
                        } else if ((marker & 0xFF00) !== 0xFF00) {
                            resolve(1); return;
                        } else {
                            offset += view.getUint16(offset);
                        }
                    }
                    resolve(1);
                } catch (ex) {
                    resolve(1);
                }
            };
            reader.onerror = () => resolve(1);
            // Only read first 128KB — EXIF is always at the start
            reader.readAsArrayBuffer(file.slice(0, 131072));
        });
    }

    /**
     * Automatic image orientation detection via EXIF + canvas rotation.
     * createImageBitmap with imageOrientation:"from-image" only applies
     * EXIF rotation visually in some browsers — it does NOT rotate the raw
     * pixel data drawn to canvas. We must read EXIF manually and apply the
     * correct canvas transform so Gemini receives an upright image.
     */
    function preprocessImageAutoOrient(file) {
        return new Promise(async (resolve) => {
            try {
                // Step 1: Read EXIF orientation
                const orientation = await readExifOrientation(file);

                // Step 2: Decode image to bitmap (no orientation correction here)
                const dataUrl = await new Promise((r) => {
                    const reader = new FileReader();
                    reader.onload = (e) => r(e.target.result);
                    reader.onerror = () => r(null);
                    reader.readAsDataURL(file);
                });
                if (!dataUrl) { resolve({ base64: null }); return; }

                const img = new Image();
                await new Promise((r) => {
                    img.onload = () => r(true);
                    img.onerror = () => r(false);
                    img.src = dataUrl;
                });

                const srcW = img.naturalWidth || img.width;
                const srcH = img.naturalHeight || img.height;
                if (!srcW || !srcH) { resolve({ base64: null }); return; }

                // Step 3: Determine output dimensions after rotation
                // EXIF orientations 5-8 swap width/height (90° or 270° rotation)
                const swapped = orientation >= 5;
                const maxDim = 2400;
                let drawW = srcW, drawH = srcH;
                if (srcW > maxDim || srcH > maxDim) {
                    if (srcW > srcH) { drawH = Math.round(srcH * maxDim / srcW); drawW = maxDim; }
                    else             { drawW = Math.round(srcW * maxDim / srcH); drawH = maxDim; }
                }
                const canvasW = swapped ? drawH : drawW;
                const canvasH = swapped ? drawW : drawH;

                const canvas = document.createElement("canvas");
                canvas.width  = canvasW;
                canvas.height = canvasH;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                if (!ctx) { resolve({ base64: null }); return; }

                // Step 4: Apply EXIF rotation transform before drawing
                ctx.save();
                // Transform matrix per EXIF orientation spec
                switch (orientation) {
                    case 2: ctx.transform(-1,  0,  0,  1, canvasW,      0); break;
                    case 3: ctx.transform(-1,  0,  0, -1, canvasW, canvasH); break;
                    case 4: ctx.transform( 1,  0,  0, -1,       0, canvasH); break;
                    case 5: ctx.transform( 0,  1,  1,  0,       0,       0); break;
                    case 6: ctx.transform( 0,  1, -1,  0, canvasH,       0); break;
                    case 7: ctx.transform( 0, -1, -1,  0, canvasH, canvasW); break;
                    case 8: ctx.transform( 0, -1,  1,  0,       0, canvasW); break;
                    default: break; // orientation 1 — no transform needed
                }
                ctx.drawImage(img, 0, 0, drawW, drawH);
                ctx.restore();

                // Step 5: Adaptive contrast enhancement for OCR readability
                // Only apply if the image has low contrast (e.g. faded/dim scans)
                try {
                    const imgData = ctx.getImageData(0, 0, canvasW, canvasH);
                    const d = imgData.data;
                    let minLum = 255, maxLum = 0;
                    // Sample every 8th pixel for speed
                    for (let i = 0; i < d.length; i += 32) {
                        const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
                        if (lum < minLum) minLum = lum;
                        if (lum > maxLum) maxLum = lum;
                    }
                    const spread = maxLum - minLum;
                    // Only stretch contrast if image is noticeably low-contrast
                    // (spread < 180) — avoid degrading already-clear prescriptions
                    if (spread > 35 && spread < 180 && (minLum > 20 || maxLum < 230)) {
                        const factor = 255 / spread;
                        for (let i = 0; i < d.length; i += 4) {
                            d[i]     = Math.min(255, Math.max(0, (d[i]     - minLum) * factor));
                            d[i + 1] = Math.min(255, Math.max(0, (d[i + 1] - minLum) * factor));
                            d[i + 2] = Math.min(255, Math.max(0, (d[i + 2] - minLum) * factor));
                        }
                        ctx.putImageData(imgData, 0, 0);
                    }
                } catch (contrastErr) {
                    console.warn("[Prescription] Contrast filter skipped:", contrastErr);
                }

                // Step 6: Export at high quality for vision model
                const optimizedDataUrl = canvas.toDataURL("image/jpeg", 0.95);
                resolve({ base64: optimizedDataUrl });

            } catch (err) {
                console.warn("[Prescription] Preprocessing failed, sending raw:", err);
                // Last-resort fallback: send raw file bytes
                const reader = new FileReader();
                reader.onload = (e) => resolve({ base64: e.target.result });
                reader.onerror = () => resolve({ base64: null });
                reader.readAsDataURL(file);
            }
        });
    }

    // Single authoritative processing flag — prevents double-click duplicate requests
    let _prxProcessing = false;

    autofillBtn.addEventListener("click", async () => {
        // Double-click / re-entry guard
        if (_prxProcessing) return;

        errorEl.textContent = "";
        infoEl.textContent  = "";
        infoEl.style.color  = "";

        if (uploadedFiles.length === 0) {
            errorEl.textContent = "Please select or drop at least one prescription file first.";
            return;
        }
        if (!currentUser) {
            errorEl.textContent = "Please login first.";
            return;
        }
        if (currentUser.role === "CAREGIVER") {
            errorEl.textContent = "Caregivers cannot add medicines. Login as patient.";
            return;
        }

        // Enter processing state — ONE loading indicator only (the button)
        _prxProcessing = true;
        const originalBtnText = autofillBtn.innerHTML;
        autofillBtn.innerHTML = `
            <svg class="btn-spinner" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="16" height="16" style="animation: spin 1s linear infinite; flex-shrink:0;">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" style="opacity:0.25;"></circle>
                <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" style="opacity:0.75;"></path>
            </svg>
            Analyzing Prescription...
        `;
        autofillBtn.disabled = true;

        try {
            let uploadRes;
            const allImagesWithBase64 = uploadedFiles.every(f => f.isImage && f.preprocessedBase64);

            if (allImagesWithBase64) {
                // Multi-image batch JSON request with auto-oriented and contrast-enhanced base64 payloads
                const imagesPayload = uploadedFiles.map(f => ({
                    image: f.preprocessedBase64,
                    mimeType: "image/jpeg",
                    fileName: f.name
                }));

                uploadRes = await authFetch(`${API_BASE}/prescription/upload`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        images: imagesPayload,
                        userId: currentUser.id
                    })
                });
            } else {
                // Multi-file FormData request supporting PDF, DOCX, TXT, images
                const formData = new FormData();
                formData.append("userId", currentUser.id);
                uploadedFiles.forEach(f => {
                    formData.append("files", f.file);
                });
                // Also append single 'file' fallback for backward compatibility
                if (uploadedFiles[0]) {
                    formData.append("file", uploadedFiles[0].file);
                }

                uploadRes = await authFetch(`${API_BASE}/prescription/upload`, {
                    method: "POST",
                    body: formData
                });
            }

            if (!uploadRes.ok) {
                const errData = await uploadRes.json().catch(() => ({}));
                const status = uploadRes.status;
                if (status === 401 || status === 403) {
                    errorEl.textContent = "Authentication error. Please log out and log in again.";
                } else if (status === 400) {
                    errorEl.textContent = errData.message || "Invalid file. Please check the file and try again.";
                } else if (status >= 500) {
                    errorEl.textContent = "The prescription analysis service is temporarily unavailable. Please try again.";
                } else {
                    errorEl.textContent = errData.message || "Failed to parse prescription. Please try again.";
                }
                return;
            }

            const responseData = await uploadRes.json();
            const medicines = responseData.medicines || (Array.isArray(responseData) ? responseData : []);

            if (!Array.isArray(medicines) || medicines.length === 0) {
                const failMsg = "No medication could be identified in this prescription. Please ensure the image is clear, well-lit, and shows the medicine list.";
                errorEl.textContent = failMsg;
                infoEl.textContent = "";
                showToast(failMsg, "warning");
                return;
            }

            currentExtractedMeds = medicines.map((m, idx) => ({
                id: `prx_item_${Date.now()}_${idx}`,
                brandName: m.brandName || m.name || m.medicineName || "",
                genericName: m.genericName || "",
                name: m.name || m.medicineName || m.brandName || "",
                strength: m.strength || "",
                dosage: m.dosage || "1 Tablet",
                form: m.form || "Tablet",
                foodInstruction: m.foodInstruction || m.food_instruction || m.instructions || "Before meal",
                startDate: m.startDate || "",
                duration: m.duration || `${m.durationDays || 30} Days`,
                durationDays: m.durationDays || (m.duration_days ? m.duration_days : (m.duration_value ? m.duration_value * (m.duration_unit === "months" ? 30 : 7) : 30)),
                morning: Boolean(m.morning || (m.times && m.times.includes("08:00"))),
                afternoon: Boolean(m.afternoon || (m.times && (m.times.includes("13:00") || m.times.includes("14:00")))),
                evening: Boolean(m.evening || (m.times && m.times.includes("18:00"))),
                night: Boolean(m.night || (m.times && (m.times.includes("20:00") || m.times.includes("21:00")))),
                times: Array.isArray(m.times) ? m.times : ["08:00"],
                confidence: typeof m.confidence === "number" ? m.confidence : 0.9,
                nameConfidence: typeof m.nameConfidence === "number" ? m.nameConfidence : (typeof m.name_confidence === "number" ? m.name_confidence : 0.9),
                strengthConfidence: typeof m.strengthConfidence === "number" ? m.strengthConfidence : 0.9,
                scheduleConfidence: typeof m.scheduleConfidence === "number" ? m.scheduleConfidence : 0.9,
                durationConfidence: typeof m.durationConfidence === "number" ? m.durationConfidence : 0.9,
                needsVerification: Boolean(m.needsVerification || m.needs_confirmation || (m.confidence && m.confidence < 0.65) || !m.name),
                possibleAlternatives: Array.isArray(m.possibleAlternatives) ? m.possibleAlternatives : [],
                sourceText: m.sourceText || m.source_text || ""
            }));

            currentExtractedMeds.forEach(m => {
                if (!m.morning && !m.afternoon && !m.evening && !m.night) {
                    m.morning = true;
                }
            });

            // Open prescription review modal
            openPrescriptionModal(responseData);

            infoEl.style.color = "var(--success)";
            infoEl.textContent = `${currentExtractedMeds.length} medicine(s) detected. Review in popup.`;

        } catch (err) {
            console.error("[Prescription] Extraction error:", err);
            if (err && err.message && err.message.toLowerCase().includes("fetch")) {
                errorEl.textContent = "Could not reach the prescription analysis service. Please check your connection.";
            } else {
                errorEl.textContent = "Prescription analysis failed. Please try again.";
            }
        } finally {
            // Always reset — no matter how the operation ended
            _prxProcessing = false;
            autofillBtn.disabled = false;
            autofillBtn.innerHTML = originalBtnText;
        }
    });

    // ─── PRESCRIPTION REVIEW MODAL ────────────────────────────────────────────

    const _prxModal        = document.getElementById("prx-modal-overlay");
    const _prxModalBody    = document.getElementById("prx-modal-body");
    const _prxModalCount   = document.getElementById("prx-modal-count");
    const _prxModalMeta    = document.getElementById("prx-modal-meta");
    const _prxModalAddBtn  = document.getElementById("prx-modal-add-btn");
    const _prxModalAddLbl  = document.getElementById("prx-modal-add-label");
    const _prxModalClose   = document.getElementById("prx-modal-close-btn");
    const _prxModalCancel  = document.getElementById("prx-modal-cancel-btn");

    function getTimesFromSchedule(item) {
        const times = [];
        if (item.morning)   times.push("08:00");
        if (item.afternoon) times.push("13:00");
        if (item.evening)   times.push("18:00");
        if (item.night)     times.push("21:00");
        return times.length > 0 ? times : ["08:00"];
    }

    function closePrescriptionModal() {
        if (_prxModal) {
            _prxModal.classList.remove("prx-modal-open");
            setTimeout(() => { _prxModal.style.display = "none"; }, 280);
        }
        document.body.style.overflow = "";
    }

    function updateModalAddBtn() {
        const accepted = currentExtractedMeds.filter(m => !m._rejected);
        if (_prxModalAddLbl) {
            _prxModalAddLbl.textContent = accepted.length === 1
                ? "Add 1 medicine to DoseBuddy"
                : `Add ${accepted.length} medicines to DoseBuddy`;
        }
        if (_prxModalAddBtn) _prxModalAddBtn.disabled = accepted.length === 0;
    }

    function renderModalCard(item, index) {
        const schedSlots = [
            { key: "morning",   label: "Morning",   time: "08:00" },
            { key: "afternoon", label: "Afternoon", time: "13:00" },
            { key: "evening",   label: "Evening",   time: "18:00" },
            { key: "night",     label: "Night",     time: "21:00" }
        ];
        const activeSlots = schedSlots.filter(s => item[s.key]);
        const schedHtml = activeSlots.length > 0
            ? activeSlots.map(s => `<span class="prx-chip prx-chip-time">${s.label}</span>`).join("")
            : `<span class="prx-chip prx-chip-muted">No schedule set</span>`;

        const isAfterFood = item.foodInstruction?.toLowerCase().includes("after");
        const foodLabel = isAfterFood ? "After meal" : (item.foodInstruction || "As directed");

        return `
        <div class="prx-med-card ${item._rejected ? "prx-med-card--rejected" : ""}" id="prxmc_${item.id}">
            <div class="prx-med-card-top">
                <div class="prx-med-card-num">${index + 1}</div>
                <div class="prx-med-card-info">
                    <div class="prx-med-card-name">${escapeHtml(item.brandName || item.name || "Unknown")}</div>
                    ${item.genericName ? `<div class="prx-med-card-generic">${escapeHtml(item.genericName)}</div>` : ""}
                </div>
                <div class="prx-med-card-strength">${escapeHtml(item.strength || item.dosage || "")}</div>
                <button type="button" class="prx-med-card-reject-btn" data-id="${item.id}" title="${item._rejected ? "Undo remove" : "Remove this medicine"}">
                    ${item._rejected
                        ? `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"/></svg>`
                        : `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`
                    }
                </button>
            </div>
            ${item._rejected ? `<div class="prx-med-card-rejected-label">Removed — click undo to restore</div>` : `
            <div class="prx-med-card-details">
                <div class="prx-med-card-row">
                    <span class="prx-chip-group">${schedHtml}</span>
                </div>
                <div class="prx-med-card-row prx-med-card-meta">
                    <span class="prx-chip prx-chip-food">${escapeHtml(foodLabel)}</span>
                    <span class="prx-chip prx-chip-duration">${item.durationDays || 30} days</span>
                </div>
            </div>
            `}
        </div>`;
    }

    function openPrescriptionModal(data) {
        if (!_prxModal || !_prxModalBody) return;

        // Reset rejection state
        currentExtractedMeds.forEach(m => { m._rejected = false; });

        // Populate meta bar
        if (_prxModalMeta) {
            const patient = data.patientName || data.patient_name || "";
            const doctor  = data.doctorName  || data.doctor_name  || "";
            const date    = data.visitDate   || data.visit_date   || "";
            const parts   = [];
            if (patient) parts.push(`<strong>Patient:</strong> ${escapeHtml(patient)}`);
            if (doctor)  parts.push(`<strong>Doctor:</strong> ${escapeHtml(doctor)}`);
            if (date)    parts.push(`<strong>Visit:</strong> ${escapeHtml(date)}`);
            if (parts.length > 0) {
                _prxModalMeta.innerHTML = parts.join("<span class='prx-meta-divider'>|</span>");
                _prxModalMeta.style.display = "flex";
            } else {
                _prxModalMeta.style.display = "none";
            }
        }

        // Render cards
        _prxModalBody.innerHTML = currentExtractedMeds.map((m, i) => renderModalCard(m, i)).join("");

        // Attach reject/undo button listeners
        _prxModalBody.querySelectorAll(".prx-med-card-reject-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const item = currentExtractedMeds.find(m => m.id === btn.dataset.id);
                if (!item) return;
                item._rejected = !item._rejected;
                const cardEl = document.getElementById(`prxmc_${item.id}`);
                if (cardEl) {
                    const idx = currentExtractedMeds.indexOf(item);
                    cardEl.outerHTML = renderModalCard(item, idx);
                    // Re-attach listener on replaced element
                    const newCard = document.getElementById(`prxmc_${item.id}`);
                    if (newCard) {
                        newCard.querySelector(".prx-med-card-reject-btn")?.addEventListener("click", arguments.callee.bind(null));
                    }
                }
                updateModalAddBtn();
            });
        });

        // Count & add button
        if (_prxModalCount) _prxModalCount.textContent = currentExtractedMeds.length;
        updateModalAddBtn();

        // Show modal
        document.body.style.overflow = "hidden";
        _prxModal.style.display = "flex";
        requestAnimationFrame(() => _prxModal.classList.add("prx-modal-open"));

        showToast(`${currentExtractedMeds.length} medicines detected from prescription`, "info");
    }

    // Re-attach reject buttons using event delegation (fixes the callee issue)
    if (_prxModalBody) {
        _prxModalBody.addEventListener("click", (e) => {
            const btn = e.target.closest(".prx-med-card-reject-btn");
            if (!btn) return;
            const item = currentExtractedMeds.find(m => m.id === btn.dataset.id);
            if (!item) return;
            item._rejected = !item._rejected;
            const idx = currentExtractedMeds.indexOf(item);
            const cardEl = document.getElementById(`prxmc_${item.id}`);
            if (cardEl) cardEl.outerHTML = renderModalCard(item, idx);
            updateModalAddBtn();
        });
    }

    // Close on overlay click
    if (_prxModal) {
        _prxModal.addEventListener("click", (e) => {
            if (e.target === _prxModal) closePrescriptionModal();
        });
    }

    // Close button
    if (_prxModalClose) _prxModalClose.addEventListener("click", closePrescriptionModal);

    // Cancel button
    if (_prxModalCancel) {
        _prxModalCancel.addEventListener("click", () => {
            closePrescriptionModal();
            currentExtractedMeds = [];
            clearAllUploadedFiles();
            infoEl.textContent  = "";
            errorEl.textContent = "";
        });
    }

    // ESC key closes modal
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && _prxModal && _prxModal.style.display !== "none") {
            closePrescriptionModal();
        }
    });

    // Add button — save accepted medicines
    if (_prxModalAddBtn) {
        _prxModalAddBtn.addEventListener("click", async () => {
            const toSave = currentExtractedMeds.filter(m => !m._rejected);
            if (toSave.length === 0) {
                showToast("No medicines selected to add.", "warning");
                return;
            }

            _prxModalAddBtn.disabled = true;
            if (_prxModalAddLbl) _prxModalAddLbl.textContent = "Saving...";

            const _nowPrx = new Date();
            const todayStr = [
                _nowPrx.getFullYear(),
                String(_nowPrx.getMonth() + 1).padStart(2, "0"),
                String(_nowPrx.getDate()).padStart(2, "0")
            ].join("-");

            let savedCount = 0, failCount = 0;

            for (const item of toSave) {
                const brand = (item.brandName || item.name || "").trim();
                const gen   = (item.genericName || "").trim();
                const fullName = brand + (gen && !brand.toLowerCase().includes(gen.toLowerCase()) ? ` (${gen})` : "");
                if (!fullName.trim()) { failCount++; continue; }

                const days = item.durationDays || 30;
                const endDate = new Date();
                endDate.setDate(endDate.getDate() + days);
                const endDateStr = [
                    endDate.getFullYear(),
                    String(endDate.getMonth() + 1).padStart(2, "0"),
                    String(endDate.getDate()).padStart(2, "0")
                ].join("-");

                const payload = {
                    userId:       currentUser.id,
                    name:         fullName,
                    dosage:       item.strength || item.dosage || "As prescribed",
                    instructions: item.foodInstruction || "",
                    startDate:    todayStr,
                    endDate:      endDateStr,
                    times:        getTimesFromSchedule(item)
                };

                try {
                    const res = await authFetch(`${API_BASE}/medications/add`, {
                        method:  "POST",
                        headers: { "Content-Type": "application/json" },
                        body:    JSON.stringify(payload)
                    });
                    if (res.ok) savedCount++; else failCount++;
                } catch (e) {
                    console.error("[Prescription] Save error:", e);
                    failCount++;
                }
            }

            _prxModalAddBtn.disabled = false;
            updateModalAddBtn();

            if (savedCount > 0) {
                closePrescriptionModal();
                currentExtractedMeds = [];
                clearAllUploadedFiles();
                infoEl.textContent  = "";
                errorEl.textContent = "";

                showToast(`✓ ${savedCount} medicine${savedCount > 1 ? "s" : ""} added to your DoseBuddy schedule!`, "success");
                // In-app notification for prescription extraction completing
                addNotification(
                    "ai",
                    "Prescription processed",
                    `${savedCount} medicine${savedCount > 1 ? "s" : ""} added to your schedule from prescription.`
                );
                resetMedicineForm();
                invalidateDataCache("/medications/", "/logs/summary/", "/logs/adherence/", "/streaks/");
                try { await renderDashboard();     } catch(e) { console.warn("Dashboard refresh failed"); }
                try { await refreshActivityFeed(); } catch(e) { console.warn("Activity refresh failed"); }
            } else {
                showToast("Could not save medicines. Please try again.", "error");
            }
        });
    }
    function resetMedicineForm() {
        const medForm = document.getElementById("medicine-form");
        if (medForm) medForm.reset();
        const startInput = document.getElementById("med-start-date");
        const endInput   = document.getElementById("med-end-date");
        const successText = document.getElementById("med-success");
        const errorText   = document.getElementById("med-error");
        const _now = new Date();
        const todayStr = [
            _now.getFullYear(),
            String(_now.getMonth() + 1).padStart(2, "0"),
            String(_now.getDate()).padStart(2, "0")
        ].join("-");
        if (startInput) { startInput.value = todayStr; startInput.min = todayStr; }
        if (endInput)   { endInput.value   = todayStr; endInput.min   = todayStr; }
        if (successText) successText.textContent = "";
        if (errorText)   errorText.textContent   = "";
        ["time-1", "time-2", "time-3"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = "";
        });
    }

    function fillMedicineForm(result) {
        if (!result) return;
        const nameEl  = document.getElementById("med-name");
        const doseEl  = document.getElementById("med-dosage");
        const instrEl = document.getElementById("med-instructions");
        const startEl = document.getElementById("med-start-date");
        const endEl   = document.getElementById("med-end-date");

        if (nameEl)  nameEl.value  = result.medicineName || result.name || result.brandName || "";
        if (doseEl)  doseEl.value  = result.strength || result.dosage || "";
        if (instrEl) instrEl.value = result.foodInstruction || result.food_instruction || result.instructions || "";

        const _now = new Date();
        const todayStr = [
            _now.getFullYear(),
            String(_now.getMonth() + 1).padStart(2, "0"),
            String(_now.getDate()).padStart(2, "0")
        ].join("-");

        if (startEl) startEl.value = result.startDate || todayStr;

        if (endEl) {
            const days = result.durationDays || result.duration_days || 30;
            const endD = new Date();
            endD.setDate(endD.getDate() + days);
            endEl.value = [
                endD.getFullYear(),
                String(endD.getMonth() + 1).padStart(2, "0"),
                String(endD.getDate()).padStart(2, "0")
            ].join("-");
        }

        // Map schedule slots to the three fixed time fields:
        // time-1 = Morning (08:00), time-2 = Afternoon (13:00), time-3 = Evening/Night
        // Use the boolean morning/afternoon/evening/night flags from the extracted result
        // so the mapping is semantic, not positional.
        const slotMap = [
            { field: "time-1", flagKey: "morning",   fallback: "08:00" },
            { field: "time-2", flagKey: "afternoon",  fallback: "13:00" },
            { field: "time-3", flagKey: "evening",    fallback: "18:00", altKey: "night", altFallback: "21:00" }
        ];

        // Build a set of scheduled times from the result
        const scheduledTimes = Array.isArray(result.times) ? result.times.map(normalizeTime).filter(Boolean) : [];

        slotMap.forEach(({ field, flagKey, fallback, altKey, altFallback }) => {
            const el = document.getElementById(field);
            if (!el) return;

            const flagOn    = Boolean(result[flagKey]);
            const altFlagOn = altKey ? Boolean(result[altKey]) : false;

            if (flagOn) {
                // Prefer the actual extracted time matching this slot's range
                const matchedTime = scheduledTimes.find(t => {
                    const h = parseInt(t.split(":")[0], 10);
                    if (flagKey === "morning")   return h >= 5  && h < 12;
                    if (flagKey === "afternoon") return h >= 12 && h < 17;
                    if (flagKey === "evening")   return h >= 17 && h < 21;
                    return false;
                });
                el.value = matchedTime || fallback;
            } else if (altFlagOn && altKey) {
                // Night slot overflows into time-3 if evening is empty
                const nightTime = scheduledTimes.find(t => parseInt(t.split(":")[0], 10) >= 20);
                el.value = nightTime || altFallback;
            } else {
                el.value = "";
            }
        });
    }

    function normalizeTime(t) {
        if (!t) return "";
        t = t.trim();
        if (/^\d{2}:\d{2}$/.test(t)) return t;       // already HH:mm
        if (/^\d:\d{2}$/.test(t))    return "0" + t; // H:mm → 0H:mm
        return t;
    }
}

const PROFILE_PREFS_KEY = "dosebuddy_profile_prefs";
const NOTIF_PREFS_KEY   = "dosebuddy_notif_prefs";

// ─── Notification Permission Utilities ───────────────────────────────────────
// Shows a non-intrusive banner asking the user to enable notifications.
// This is called ONLY when permission is "default" (not yet decided).
// We never auto-request — the browser requires a real user click.
function showNotifPermissionBanner() {
    // Don't show if user is not logged in yet
    if (!currentUser) return;
    // Don't show if already handled
    if (!("Notification" in window)) return;
    if (Notification.permission !== "default") return;
    // Don't show if we already have a banner
    if (document.getElementById("notif-permission-banner")) return;

    const banner = document.createElement("div");
    banner.id = "notif-permission-banner";
    banner.setAttribute("role", "alert");
    banner.innerHTML = `
        <div class="notif-banner-content">
            <span class="notif-banner-icon">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/></svg>
            </span>
            <p class="notif-banner-text">Enable browser notifications to get dose reminders on time.</p>
            <div class="notif-banner-actions">
                <button class="notif-banner-allow" id="notif-banner-allow-btn">Enable Notifications</button>
                <button class="notif-banner-dismiss" id="notif-banner-dismiss-btn" aria-label="Dismiss">✕</button>
            </div>
        </div>
    `;

    document.body.appendChild(banner);

    // Animate in
    requestAnimationFrame(() => banner.classList.add("notif-banner-visible"));

    document.getElementById("notif-banner-allow-btn").addEventListener("click", () => {
        requestNotificationPermission().then(permission => {
            banner.classList.remove("notif-banner-visible");
            setTimeout(() => banner.remove(), 300);
            if (permission === "granted") {
                showToast("Notifications enabled! You'll get dose reminders on time.", "success", 5000);
                // Re-schedule now that we have permission
                scheduleMedicineReminders();
            } else if (permission === "denied") {
                showToast("Notifications blocked. To enable, click the lock icon in your browser's address bar.", "warning", 8000);
            }
        });
    });

    document.getElementById("notif-banner-dismiss-btn").addEventListener("click", () => {
        banner.classList.remove("notif-banner-visible");
        setTimeout(() => banner.remove(), 300);
    });
}

// Requests notification permission — must be called from a user gesture.
function requestNotificationPermission() {
    if (!("Notification" in window)) {
        return Promise.resolve("denied");
    }
    if (Notification.permission === "granted") {
        return Promise.resolve("granted");
    }
    // Notification.requestPermission returns a Promise in modern browsers
    // and uses a callback in old Safari. We normalise both here.
    return new Promise(resolve => {
        const result = Notification.requestPermission(permission => resolve(permission));
        if (result && typeof result.then === "function") {
            result.then(resolve).catch(() => resolve("denied"));
        }
    });
}

// Updates the permission status row inside the Notification Preferences modal.
function updateNotifPermissionStatus() {
    const statusRow   = document.getElementById("notif-perm-status-row");
    const statusText  = document.getElementById("notif-perm-status-text");
    const enableBtn   = document.getElementById("notif-perm-enable-btn");
    if (!statusRow || !statusText || !enableBtn) return;

    if (!("Notification" in window)) {
        statusText.textContent  = "Not supported in this browser.";
        statusText.className    = "notif-perm-text notif-perm-unsupported";
        enableBtn.style.display = "none";
        return;
    }

    const perm = Notification.permission;
    if (perm === "granted") {
        statusText.textContent  = "✓ Enabled — you will receive dose reminders.";
        statusText.className    = "notif-perm-text notif-perm-granted";
        enableBtn.style.display = "none";
    } else if (perm === "denied") {
        statusText.textContent  = "✕ Blocked — enable notifications in your browser settings to receive dose reminders.";
        statusText.className    = "notif-perm-text notif-perm-denied";
        enableBtn.style.display = "none";
    } else {
        statusText.textContent  = "⚠ Permission required — click Enable Notifications to get started.";
        statusText.className    = "notif-perm-text notif-perm-default";
        enableBtn.style.display = "inline-flex";
    }
}

function openModal(id) {
    const modal    = document.getElementById(id);
    const backdrop = document.getElementById("modal-backdrop");
    if (!modal || !backdrop) return;
    backdrop.classList.add("backdrop-visible");
    modal.classList.add("modal-open");
    document.body.style.overflow = "hidden";
    const first = modal.querySelector("button, input, select, [tabindex]");
    if (first) setTimeout(() => first.focus(), 50);
}

function closeModal(id) {
    const modal    = document.getElementById(id);
    const backdrop = document.getElementById("modal-backdrop");
    if (!modal) return;
    modal.classList.remove("modal-open");
    const anyOpen = document.querySelectorAll(".modal.modal-open").length > 0;
    if (!anyOpen && backdrop) backdrop.classList.remove("backdrop-visible");
    if (!anyOpen) document.body.style.overflow = "";
}

function closeAllModals() {
    document.querySelectorAll(".modal.modal-open").forEach(m => m.classList.remove("modal-open"));
    const backdrop = document.getElementById("modal-backdrop");
    if (backdrop) backdrop.classList.remove("backdrop-visible");
    document.body.style.overflow = "";
}

function setupProfileDropdown() {
    const avatarBtn  = document.getElementById("nav-user-avatar");
    const dropdown   = document.getElementById("profile-dropdown");
    if (!avatarBtn || !dropdown) return;

    avatarBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains("pd-open");
        dropdown.classList.toggle("pd-open", !isOpen);
        avatarBtn.setAttribute("aria-expanded", String(!isOpen));
    });

    document.addEventListener("click", (e) => {
        if (!dropdown.contains(e.target) && e.target !== avatarBtn) {
            dropdown.classList.remove("pd-open");
            avatarBtn.setAttribute("aria-expanded", "false");
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            dropdown.classList.remove("pd-open");
            closeAllModals();
        }
    });

    const backdrop = document.getElementById("modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeAllModals);

    document.querySelectorAll(".modal-close, [data-modal]").forEach(btn => {
        btn.addEventListener("click", () => {
            const target = btn.dataset.modal;
            if (target) closeModal(target);
        });
    });

    document.getElementById("pd-profile-btn")?.addEventListener("click", () => {
        dropdown.classList.remove("pd-open");
        openProfileSettingsModal();
    });

    document.getElementById("pd-notif-btn")?.addEventListener("click", () => {
        dropdown.classList.remove("pd-open");
        openNotifPrefsModal();
    });

    document.getElementById("pd-help-btn")?.addEventListener("click", () => {
        dropdown.classList.remove("pd-open");
        openModal("modal-help");
    });

    document.getElementById("pd-privacy-btn")?.addEventListener("click", () => {
        dropdown.classList.remove("pd-open");
        openPrivacyModal();
    });

    document.getElementById("pd-logout-btn")?.addEventListener("click", () => {
        dropdown.classList.remove("pd-open");
        openModal("modal-logout");
    });

    document.getElementById("confirm-logout-btn")?.addEventListener("click", () => {
        closeAllModals();
        doLogoutAction();
    });

    document.getElementById("help-copy-email")?.addEventListener("click", () => {
        navigator.clipboard.writeText("dosebuddySupport@gmail.com").then(() => {
            showToast("Email copied to clipboard!", "success", 2000);
        }).catch(() => {
            showToast("dosebuddySupport@gmail.com", "info", 3000);
        });
    });
}

function doLogoutAction() {
    stopReminderAudio(); // Stop any active reminder audio (mirrors doLogout in setupNav)
    currentUser = null;
    saveToLS(LS_CURRENT_USER_KEY, null);
    clearTokens(); // Clear JWT tokens
    // Clear all notification dedup state so the next login starts fresh
    firedReminderKeys.clear();
    firedMissedAlertKeys.clear();
    _lastScheduledDate = "";
    clearScheduledTimeouts();
    clearMissTimeouts(); // Stop any pending 5-min miss-window timers
    // Stop the checkReminders safety-net interval — it is restarted on next login
    if (_reminderIntervalId) { clearInterval(_reminderIntervalId); _reminderIntervalId = null; }
    // Clear in-app notification panel from memory (localStorage stays for next login)
    notifStore = [];
    refreshNotifBadge();
    medsCache = [];
    medsCacheDate = null;
    showAuthView();
}

function updateProfileDropdown() {
    if (!currentUser) return;
    const name  = currentUser.name  || "User";
    const email = currentUser.email || "";
    const role  = currentUser.role  || "";

    const pdAvatar = document.getElementById("pd-avatar");
    const pdName   = document.getElementById("pd-name");
    const pdEmail  = document.getElementById("pd-email");
    const pdRole   = document.getElementById("pd-role");

    if (pdAvatar) pdAvatar.textContent = name.charAt(0).toUpperCase();
    if (pdName)   pdName.textContent   = name;
    if (pdEmail)  pdEmail.textContent  = email;
    if (pdRole)   pdRole.textContent   =
        role === "PATIENT"   ? "Patient" :
        role === "CAREGIVER" ? "Caregiver" : role;
}

function normalizeDateInput(val) {
    if (!val) return "";
    if (typeof val === "string") {
        const trimmed = val.trim();
        const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) return match[1];
        const d = new Date(trimmed);
        if (!isNaN(d.getTime())) {
            const year = d.getUTCFullYear();
            const month = String(d.getUTCMonth() + 1).padStart(2, "0");
            const day = String(d.getUTCDate()).padStart(2, "0");
            return `${year}-${month}-${day}`;
        }
        return "";
    }
    if (val instanceof Date && !isNaN(val.getTime())) {
        const year = val.getFullYear();
        const month = String(val.getMonth() + 1).padStart(2, "0");
        const day = String(val.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }
    return "";
}

async function openProfileSettingsModal() {
    if (!currentUser || !currentUser.id) {
        showToast("Please log in first.", "error");
        return;
    }

    // FIX Issue 2: Populate the modal immediately from the in-memory
    // currentUser (already enriched on login/page-load via fetchFullProfile).
    // This makes the profile settings appear instantly — no network wait.
    // A background refresh then silently updates the form if anything changed
    // since the last fetch.
    function _populateProfileForm(profile) {
        const preview = document.getElementById("profile-avatar-preview");
        const pName   = document.getElementById("profile-avatar-name");
        const pRole   = document.getElementById("profile-avatar-role");

        const name = profile.name || "";
        if (preview) preview.textContent = (name || "U").charAt(0).toUpperCase();
        if (pName)   pName.textContent   = name || "User";
        if (pRole)   pRole.textContent   = profile.role === "CAREGIVER" ? "Caregiver" : "Patient";

        const textFields = {
            "ps-name":      profile.name            || "",
            "ps-email":     profile.email           || "",
            "ps-phone":     profile.phone           || "",
            "ps-dob":       normalizeDateInput(profile.dob),
            "ps-emergency": profile.emergencyContact || ""
        };
        Object.entries(textFields).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
        });

        const genderEl = document.getElementById("ps-gender");
        if (genderEl) {
            const normalized = normalizeGenderValue(profile.gender || "");
            genderEl.value = normalized;
            if (normalized && genderEl.value !== normalized) {
                console.warn("Gender value not found in options:", normalized);
                genderEl.value = "";
            }
        }

        const nameInput = document.getElementById("ps-name");
        if (nameInput) {
            const fresh = nameInput.cloneNode(true);
            nameInput.parentNode.replaceChild(fresh, nameInput);
            fresh.addEventListener("input", () => {
                const v = fresh.value.trim();
                if (preview) preview.textContent = (v || "U").charAt(0).toUpperCase();
                if (pName)   pName.textContent   = v || "User";
            });
        }
    }

    // Step 1 — show immediately from cached currentUser (zero latency)
    _populateProfileForm(currentUser);
    openModal("modal-profile");

    if (Date.now() - _profileFetchedAt < 60000) return;

    // Step 2 — background refresh: silently re-fetch and update the form
    // if the server has newer data. Never blocks the modal from opening.
    try {
        const res = await authFetch(`${API_BASE}/user/profile/${currentUser.id}`);
        if (!res.ok) return; // stale data already shown — that's fine
        const profile = await res.json();
        _profileFetchedAt = Date.now();

        currentUser = { ...currentUser, ...profile };
        saveToLS(LS_CURRENT_USER_KEY, currentUser);

        // Only update the form if the modal is still open
        if (document.getElementById("modal-profile")?.classList.contains("modal-open")) {
            _populateProfileForm(profile);
        }
    } catch (err) {
        // Background refresh failed — user is still looking at cached data, fine
        console.warn("[Profile] Background refresh failed (non-fatal):", err.message);
    }
}

function normalizeGenderValue(raw) {
    if (!raw) return "";
    const map = {
        "male":              "Male",
        "female":            "Female",
        "other":             "Other",
        "prefer-not":        "Prefer not to say",
        "prefer not to say": "Prefer not to say",
        "Male":              "Male",
        "Female":            "Female",
        "Other":             "Other",
        "Prefer not to say": "Prefer not to say"
    };
    return map[raw] || raw;
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("ps-save-btn")?.addEventListener("click", async () => {
        if (!currentUser || !currentUser.id) {
            showToast("Please log in first.", "error");
            return;
        }

        const name  = document.getElementById("ps-name")?.value.trim();
        const email = document.getElementById("ps-email")?.value.trim();

        if (!name) { showToast("Please enter your full name.", "error"); return; }
        if (email && !email.includes("@")) { showToast("Please enter a valid email.", "error"); return; }

        const updateData = {
            name,
            phone:            document.getElementById("ps-phone")?.value.trim()     || "",
            dob:              normalizeDateInput(document.getElementById("ps-dob")?.value),
            gender:           document.getElementById("ps-gender")?.value            || "",
            emergencyContact: document.getElementById("ps-emergency")?.value.trim()  || ""
        };

        const saveBtn = document.getElementById("ps-save-btn");
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving..."; }

        try {
            const res = await authFetch(`${API_BASE}/user/profile/${currentUser.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(updateData)
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || "Failed to update profile");
            }

            const updatedProfile = await res.json();

            currentUser = { ...currentUser, ...updatedProfile };
            saveToLS(LS_CURRENT_USER_KEY, currentUser);

            updateUserMenuInfo();
            updateProfileDropdown();

            closeModal("modal-profile");
            showToast("Profile updated successfully!", "success");
        } catch (err) {
            console.error("Error updating profile:", err);
            showToast(err.message || "Failed to update profile.", "error");
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Changes"; }
        }
    });
});

function openNotifPrefsModal() {
    const saved = loadFromLS(NOTIF_PREFS_KEY, {
        "medicine-reminders": true,
        "missed-alerts":      true,
        "daily-summary":      false,
        "sound-alerts":       true,
    });

    document.querySelectorAll(".toggle-switch[data-pref]").forEach(btn => {
        const pref = btn.dataset.pref;
        const on   = saved[pref] !== undefined ? saved[pref] : btn.classList.contains("active");
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-checked", String(on));
    });

    // Refresh the live permission status row each time the modal opens
    updateNotifPermissionStatus();

    openModal("modal-notif");
}

document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".toggle-switch[data-pref]").forEach(btn => {
        btn.addEventListener("click", () => {
            const isOn = btn.classList.toggle("active");
            btn.setAttribute("aria-checked", String(isOn));
        });
    });

    document.getElementById("notif-save-btn")?.addEventListener("click", async () => {
        const prefs = {};
        document.querySelectorAll(".toggle-switch[data-pref]").forEach(btn => {
            prefs[btn.dataset.pref] = btn.classList.contains("active");
        });
        saveToLS(NOTIF_PREFS_KEY, prefs);
        closeModal("modal-notif");
        showToast("Notification preferences saved!", "success");
    });

    // "Enable Notifications" button inside the preferences modal
    document.getElementById("notif-perm-enable-btn")?.addEventListener("click", () => {
        requestNotificationPermission().then(permission => {
            updateNotifPermissionStatus();
            if (permission === "granted") {
                showToast("Notifications enabled! You'll get dose reminders on time.", "success", 5000);
                // Remove the banner if it was showing
                const banner = document.getElementById("notif-permission-banner");
                if (banner) { banner.classList.remove("notif-banner-visible"); setTimeout(() => banner.remove(), 300); }
                // Re-schedule now that we have permission
                scheduleMedicineReminders();
            } else if (permission === "denied") {
                showToast("Notifications blocked. Click the lock icon in your browser's address bar to allow them.", "warning", 8000);
            }
        });
    });

    // "Send Test Notification" button
    document.getElementById("notif-test-btn")?.addEventListener("click", async () => {        const resultEl = document.getElementById("notif-test-result");
        const btn      = document.getElementById("notif-test-btn");

        function showResult(msg, color) {
            if (!resultEl) return;
            resultEl.textContent   = msg;
            resultEl.style.color   = color;
            resultEl.style.display = "block";
            setTimeout(() => { if (resultEl) resultEl.style.display = "none"; }, 6000);
        }

        if (!("Notification" in window)) {
            showResult("❌ Notifications are not supported in this browser.", "var(--error, #e53e3e)");
            return;
        }
        if (Notification.permission === "denied") {
            showResult("⚠ Notifications are blocked. Enable them in your browser settings.", "var(--warning, #d97706)");
            return;
        }
        if (Notification.permission !== "granted") {
            showResult("⚠ Notifications are not enabled yet. Click Enable Notifications first.", "var(--warning, #d97706)");
            return;
        }

        if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
        try {
            const n = new Notification("DoseBuddy Test ✓", {
                body: "Notifications are working! You will receive your dose reminders.",
                icon: "/favicon.ico",
                tag:  "dosebuddy-test-" + Date.now(),
            });
            n.onerror = () => showResult("❌ Notification failed to display.", "var(--error, #e53e3e)");
            showResult("✓ Test notification sent! Check your browser notifications.", "var(--success, #16a34a)");
            if (typeof playReminderSound === "function") playReminderSound();
        } catch (e) {
            showResult(`❌ Error: ${e.message}`, "var(--error, #e53e3e)");
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = "Send Test"; }
        }
    });

    // ── Dev-only "Test Missed Dose Alert" button ──────────────────────────
    // Only visible when localStorage["dosebuddy_dev"] === "1". Never shown in
    // production. Simulates a PENDING→MISSED transition: plays the missed-dose
    // alert sound once, creates a missed in-app notification, and reports the
    // result — without requiring the user to wait for a real missed dose.
    (function setupDevMissedDoseTest() {
        const devSection = document.getElementById("notif-dev-section");
        if (!devSection) return;
        try {
            if (localStorage.getItem("dosebuddy_dev") === "1") {
                devSection.style.display = "block";
            }
        } catch (e) { /* ignore */ }

        document.getElementById("notif-test-missed-btn")?.addEventListener("click", () => {
            const resultEl = document.getElementById("notif-missed-test-result");
            const btn      = document.getElementById("notif-test-missed-btn");
            function showResult(msg, color) {
                if (!resultEl) return;
                resultEl.textContent   = msg;
                resultEl.style.color   = color;
                resultEl.style.display = "block";
                setTimeout(() => { if (resultEl) resultEl.style.display = "none"; }, 6000);
            }

            if (!currentUser) {
                showResult("⚠ Log in first to test the missed-dose alert.", "var(--warning, #d97706)");
                return;
            }

            // Deterministic key for the simulated event (unique per click via Date.now)
            const simKey = `missed-${currentUser.id}-devsim-${Date.now()}`;
            // Use the same dedup gate as the real transition so it honours
            // firedMissedAlertKeys exactly like production behaviour.
            if (firedMissedAlertKeys.has(simKey)) {
                showResult("⚠ Simulated alert already fired. Click again to re-run.", "var(--warning, #d97706)");
                return;
            }
            firedMissedAlertKeys.add(simKey);

            addNotification(
                "missed",
                "Missed dose: Test Medicine",
                "Scheduled at 10:00 — not taken. (dev simulation)"
            );
            playMissedDoseAlert();
            if (btn) { btn.textContent = "Played ✓"; setTimeout(() => { if (btn) btn.textContent = "Simulate Miss"; }, 2000); }
            showResult("✓ Missed-dose alert simulated: notification created + sound played once.", "var(--success, #16a34a)");
            console.log(`[DoseBuddy] DEV missed-dose alert simulated: ${simKey}`);
        });
    })();
});

function openPrivacyModal() {
    ["sec-current-pw","sec-new-pw","sec-confirm-pw"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
    });
    const errEl = document.getElementById("sec-pw-error");
    if (errEl) errEl.textContent = "";
    const wrap = document.getElementById("pw-strength-wrap");
    if (wrap) wrap.style.display = "none";
    openModal("modal-privacy");
}

document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".pw-toggle-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            const input = document.getElementById(btn.dataset.target);
            if (!input) return;
            const isPassword = input.type === "password";
            input.type = isPassword ? "text" : "password";
            btn.innerHTML = isPassword
                ? `<svg class="pw-eye" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/></svg>`
                : `<svg class="pw-eye" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`;
        });
    });

    document.getElementById("sec-new-pw")?.addEventListener("input", (e) => {
        const val  = e.target.value;
        const wrap = document.getElementById("pw-strength-wrap");
        const fill = document.getElementById("pw-strength-fill");
        const lbl  = document.getElementById("pw-strength-label");
        if (!wrap || !fill || !lbl) return;

        if (!val) { wrap.style.display = "none"; return; }
        wrap.style.display = "flex";

        let score = 0;
        if (val.length >= 8)          score++;
        if (/[A-Z]/.test(val))        score++;
        if (/[0-9]/.test(val))        score++;
        if (/[^A-Za-z0-9]/.test(val)) score++;

        const levels = [
            { pct: "25%",  color: "#ef4444", label: "Weak"      },
            { pct: "50%",  color: "#f59e0b", label: "Fair"      },
            { pct: "75%",  color: "#00A19B", label: "Good"      },
            { pct: "100%", color: "#22c55e", label: "Strong"    },
        ];
        const lvl = levels[Math.max(0, score - 1)];
        fill.style.width      = lvl.pct;
        fill.style.background = lvl.color;
        lbl.textContent       = lvl.label;
        lbl.style.color       = lvl.color;
    });

    document.getElementById("sec-save-btn")?.addEventListener("click", async () => {
        if (!currentUser || !currentUser.id) {
            showToast("Please log in first.", "error");
            return;
        }

        const current = document.getElementById("sec-current-pw")?.value;
        const newPw   = document.getElementById("sec-new-pw")?.value;
        const confirm = document.getElementById("sec-confirm-pw")?.value;
        const errEl   = document.getElementById("sec-pw-error");

        if (!current) { if (errEl) errEl.textContent = "Please enter your current password."; return; }
        if (!newPw || newPw.length < 8) { if (errEl) errEl.textContent = "New password must be at least 8 characters."; return; }
        if (newPw !== confirm) { if (errEl) errEl.textContent = "Passwords do not match."; return; }

        if (errEl) errEl.textContent = "";

        const saveBtn = document.getElementById("sec-save-btn");
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = "Changing...";
        }

        try {
            const res = await authFetch(`${API_BASE}/user/change-password/${currentUser.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    currentPassword: current,
                    newPassword: newPw
                })
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || "Failed to change password");
            }

            ["sec-current-pw", "sec-new-pw", "sec-confirm-pw"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = "";
            });

            closeModal("modal-privacy");
            showToast("Password changed successfully! Please log in with your new password.", "success", 4000);
        } catch (err) {
            console.error("Error changing password:", err);
            if (errEl) errEl.textContent = err.message || "Failed to change password.";
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = "Save Password";
            }
        }
    });
});

document.addEventListener("DOMContentLoaded", () => {
    setupProfileDropdown();
});

let notifStore = [];

// localStorage key for per-user in-app notifications (scoped by userId)
function _notifStoreKey(userId) {
    return `dosebuddy_notif_store_${userId}`;
}

/** Load this user's notifications from localStorage into notifStore. */
function loadNotifStore(userId) {
    if (!userId) { notifStore = []; return; }
    try {
        const raw = localStorage.getItem(_notifStoreKey(userId));
        notifStore = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(notifStore)) notifStore = [];
    } catch (e) {
        notifStore = [];
    }
}

/** Persist the current notifStore for this user to localStorage. */
function saveNotifStore(userId) {
    if (!userId) return;
    try {
        localStorage.setItem(_notifStoreKey(userId), JSON.stringify(notifStore.slice(0, 50)));
    } catch (e) {
        console.warn("[Notif] Could not persist notifications:", e.message);
    }
}

/** Clear this user's notifications from localStorage and memory. */
function clearNotifStore(userId) {
    notifStore = [];
    if (userId) {
        try { localStorage.removeItem(_notifStoreKey(userId)); } catch (e) {}
    }
    refreshNotifBadge();
    renderNotificationPanel();
}

const NOTIF_ICONS = {
    missed:      { iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`, color: "notif-icon-orange" },
    reminder:    { iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/></svg>`, color: "notif-icon-blue"   },
    adherence:   { iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.504-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.003 0H9.497m5.003 0A3.375 3.375 0 0017.875 12V6.375c0-.621-.504-1.125-1.125-1.125H7.25c-.621 0-1.125.504-1.125 1.125V12a3.375 3.375 0 003.375 3.375m6.375-7.5h2.25a2.25 2.25 0 012.25 2.25v.75a2.25 2.25 0 01-2.25 2.25h-2.25m-9-5.25H4.875A2.25 2.25 0 002.625 9.75v.75a2.25 2.25 0 002.25 2.25h2.25"/></svg>`, color: "notif-icon-green"  },
    ai:          { iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/></svg>`, color: "notif-icon-purple" },
    info:        { iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/></svg>`, color: "notif-icon-blue"   },
};

function timeAgo(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)   return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function renderNotificationPanel() {
    const list      = document.getElementById("notification-list");
    const emptyEl   = document.getElementById("notif-empty-state");
    if (!list || !emptyEl) return;

    list.innerHTML = "";

    if (notifStore.length === 0) {
        emptyEl.style.display = "flex";
        return;
    }
    emptyEl.style.display = "none";

    notifStore.forEach(item => {
        const icon = NOTIF_ICONS[item.type] || NOTIF_ICONS.info;
        const div  = document.createElement("div");
        div.className = `notif-item${item.unread ? " notif-item-unread" : ""}`;
        div.dataset.id = item.id;
        div.innerHTML = `
            <div class="notif-item-icon ${icon.color}">${icon.iconSvg}</div>
            <div class="notif-item-body">
                <p class="notif-item-title">${escapeHtml(item.title)}</p>
                <p class="notif-item-desc">${escapeHtml(item.desc)}</p>
                <span class="notif-item-time">${timeAgo(item.ts)}</span>
            </div>
            ${item.unread ? '<span class="notif-item-dot"></span>' : ""}
        `;
        div.addEventListener("click", () => {
            item.unread = false;
            div.classList.remove("notif-item-unread");
            div.querySelector(".notif-item-dot")?.remove();
            saveNotifStore(currentUser?.id);
            refreshNotifBadge();
        });
        list.appendChild(div);
    });
}

function refreshNotifBadge() {
    const unread  = notifStore.filter(n => n.unread).length;
    const countEl = document.getElementById("notification-count");
    const badge   = document.getElementById("notif-unread-badge");
    if (countEl) { countEl.textContent = unread; countEl.style.display = unread > 0 ? "flex" : "none"; }
    if (badge)   { badge.textContent   = unread; badge.style.display   = unread > 0 ? "inline-flex" : "none"; }
}

function addNotification(type, title, desc) {
    // Deterministic id: same event never creates a duplicate entry
    const id = `${type}-${(currentUser?.id || "anon")}-${title.replace(/\s+/g, "_").substring(0, 40)}-${Math.floor(Date.now() / 60000)}`;
    // Skip if already in store (same id = same minute, same title)
    if (notifStore.some(n => n.id === id)) return;

    notifStore.unshift({ id, type, title, desc, unread: true, ts: Date.now() });
    notifStore = notifStore.slice(0, 50);
    saveNotifStore(currentUser?.id);
    refreshNotifBadge();
    // Live-update the panel if it's currently open
    const panel = document.getElementById("notification-panel");
    if (panel && panel.classList.contains("notif-panel-open")) {
        renderNotificationPanel();
    }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("notif-mark-all-btn")?.addEventListener("click", () => {
        notifStore.forEach(n => n.unread = false);
        saveNotifStore(currentUser?.id);
        renderNotificationPanel();
        refreshNotifBadge();
    });

    document.getElementById("notif-clear-btn")?.addEventListener("click", () => {
        clearNotifStore(currentUser?.id);
    });
});


const ONBOARDING_KEY = "dosebuddy_onboarding_done";

const ONBOARDING_STEPS = [
    {
        title:  "Welcome to DoseBuddy",
        desc:   "Your personal medicine reminder and health companion. Let us show you around in a few quick steps.",
        target: null,
        pos:    "center",
    },
    {
        title:  "Sidebar Navigation",
        desc:   "Use the sidebar to switch between Dashboard, Add Medicine, Reports, History, and AI tools.",
        target: "#user-menu",
        pos:    "right",
    },
    {
        title:  "Add Your Medicines",
        desc:   "Click Add Medicine to set up your medication schedule. You can also upload a prescription to auto-fill.",
        target: "[data-view='add-medicine-view']",
        pos:    "right",
    },
    {
        title:  "Notification Bell",
        desc:   "Click the bell to see missed doses, reminders, and health tips. The badge shows unread count.",
        target: "#notification-bell",
        pos:    "bottom",
    },
    {
        title:  "Your Profile",
        desc:   "Click your avatar to access Profile Settings, Notification Preferences, Help, and Security.",
        target: "#nav-user-avatar",
        pos:    "bottom",
    },
    {
        title:  "Dark Mode",
        desc:   "Toggle dark mode anytime using the button at the bottom of the sidebar. Your preference is saved.",
        target: "#menu-theme-toggle",
        pos:    "right",
    },
];

let obStep = 0;

function startOnboarding() {
    if (localStorage.getItem(ONBOARDING_KEY)) return;
    obStep = 0;
    showOnboardingStep(0);
}

function showOnboardingStep(step) {
    const overlay  = document.getElementById("onboarding-overlay");
    const tooltip  = document.getElementById("onboarding-tooltip");
    const spotlight= document.getElementById("onboarding-spotlight");
    const titleEl  = document.getElementById("ob-title");
    const descEl   = document.getElementById("ob-desc");
    const stepEl   = document.getElementById("ob-step-indicator");
    const nextBtn  = document.getElementById("ob-next-btn");

    if (!overlay || !tooltip) return;

    const data = ONBOARDING_STEPS[step];
    if (!data) { finishOnboarding(); return; }

    titleEl.textContent = data.title;
    descEl.textContent  = data.desc;
    stepEl.textContent  = `Step ${step + 1} of ${ONBOARDING_STEPS.length}`;
    nextBtn.textContent = step === ONBOARDING_STEPS.length - 1 ? "Finish" : "Next";

    overlay.style.display  = "block";
    tooltip.style.display  = "block";

    if (data.target) {
        const el = document.querySelector(data.target);
        if (el) {
            // Scroll element into view if outside the visible viewport
            const initialRect = el.getBoundingClientRect();
            if (initialRect.top < 0 || initialRect.bottom > window.innerHeight || initialRect.left < 0 || initialRect.right > window.innerWidth) {
                el.scrollIntoView({ block: "center", inline: "nearest" });
            }

            const r = el.getBoundingClientRect();
            const pad = 6;
            spotlight.style.cssText = `
                display:block;
                top:${r.top - pad}px;
                left:${r.left - pad}px;
                width:${r.width + pad * 2}px;
                height:${r.height + pad * 2}px;
            `;
        } else {
            spotlight.style.display = "none";
        }
    } else {
        spotlight.style.display = "none";
    }

    positionTooltip(tooltip, data);

    tooltip.classList.remove("ob-visible");
    requestAnimationFrame(() => tooltip.classList.add("ob-visible"));
}

function positionTooltip(tooltip, data) {
    tooltip.style.top    = "50%";
    tooltip.style.left   = "50%";
    tooltip.style.bottom = "auto";
    tooltip.style.right  = "auto";
    tooltip.style.transform = "translate(-50%, -50%)";

    if (!data.target) return;

    const el = document.querySelector(data.target);
    if (!el) return;

    const r = el.getBoundingClientRect();
    const gap = 14;
    const padding = 16;
    
    // Dynamically measure tooltip size instead of hardcoding
    const tw = tooltip.offsetWidth || 280;
    const th = tooltip.offsetHeight || 160;
    
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let preferredPos = data.pos || "bottom";
    
    const spaceTop = r.top;
    const spaceBottom = vh - r.bottom;
    const spaceLeft = r.left;
    const spaceRight = vw - r.right;

    // Smart positioning logic if preferred side doesn't have enough space
    if (preferredPos === "right" && spaceRight < tw + gap + padding) {
        if (spaceLeft >= tw + gap + padding) preferredPos = "left";
        else if (spaceBottom >= th + gap + padding) preferredPos = "bottom";
        else if (spaceTop >= th + gap + padding) preferredPos = "top";
        else preferredPos = spaceLeft > spaceRight ? "left" : "right";
    } else if (preferredPos === "bottom" && spaceBottom < th + gap + padding) {
        if (spaceTop >= th + gap + padding) preferredPos = "top";
        else if (spaceRight >= tw + gap + padding) preferredPos = "right";
        else if (spaceLeft >= tw + gap + padding) preferredPos = "left";
        else preferredPos = spaceTop > spaceBottom ? "top" : "bottom";
    }

    let top, left;

    if (preferredPos === "right") {
        top = Math.min(r.top, vh - th - padding);
        top = Math.max(padding, top);
        left = r.right + gap;
    } else if (preferredPos === "left") {
        top = Math.min(r.top, vh - th - padding);
        top = Math.max(padding, top);
        left = r.left - tw - gap;
    } else if (preferredPos === "top") {
        top = r.top - th - gap;
        left = r.left + r.width / 2 - tw / 2;
    } else {
        // bottom fallback
        top = r.bottom + gap;
        left = r.left + r.width / 2 - tw / 2;
    }

    // Final boundary clamp to guarantee tooltip is visible within viewport
    top = Math.max(padding, Math.min(top, vh - th - padding));
    left = Math.max(padding, Math.min(left, vw - tw - padding));

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.transform = "none";
}

function finishOnboarding() {
    localStorage.setItem(ONBOARDING_KEY, "1");
    const overlay = document.getElementById("onboarding-overlay");
    const tooltip = document.getElementById("onboarding-tooltip");
    if (overlay) overlay.style.display = "none";
    if (tooltip) { tooltip.classList.remove("ob-visible"); tooltip.style.display = "none"; }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("ob-next-btn")?.addEventListener("click", () => {
        obStep++;
        if (obStep >= ONBOARDING_STEPS.length) { finishOnboarding(); return; }
        showOnboardingStep(obStep);
    });

    document.getElementById("ob-skip-btn")?.addEventListener("click", finishOnboarding);

    document.addEventListener("keydown", (e) => {
        const tooltip = document.getElementById("onboarding-tooltip");
        if (!tooltip || tooltip.style.display === "none") return;
        if (e.key === "Escape") finishOnboarding();
        if (e.key === "Enter")  document.getElementById("ob-next-btn")?.click();
    });
});


let vitalsBpChart    = null;
let vitalsSugarChart = null;
let vitalsWeightChart = null;
let currentVitalsPeriod = "week";

function setupVitals() {
    document.querySelectorAll(".vitals-period-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".vitals-period-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentVitalsPeriod = btn.dataset.period;
            const label = document.getElementById("vitals-chart-period-label");
            if (label) {
                label.textContent = currentVitalsPeriod === "week" ? "Last 7 days"
                    : currentVitalsPeriod === "month" ? "Last 30 days" : "All time";
            }
            loadVitalsTrend(currentVitalsPeriod);
        });
    });
    const form = document.getElementById("vitals-form");
    if (form) {
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            await submitVitals();
        });
    }
}

async function renderVitalsView() {
    if (!currentUser) return;
    await Promise.all([
        loadVitalsLatest(),
        loadVitalsHistory(),
        loadVitalsTrend(currentVitalsPeriod)
    ]);
}

async function loadVitalsLatest() {
    if (!currentUser) return;
    try {
        const data = await fetchJsonCached(`${API_BASE}/vitals/latest/${currentUser.id}`, 15000);
        if (!data) {
            clearVitalsSummaryCards();
            return;
        }
        renderVitalsSummaryCards(data);
        checkVitalsAlerts(data);
    } catch (e) {
        clearVitalsSummaryCards();
    }
}

async function loadVitalsHistory() {
    if (!currentUser) return;
    try {
        const data = await fetchJsonCached(`${API_BASE}/vitals/history/${currentUser.id}`, 15000);
        const records = Array.isArray(data) ? data : [];
        renderVitalsTable(records);
        renderVitalsInsights(records);
    } catch (e) {
        renderVitalsTable([]);
    }
}

async function loadVitalsTrend(period) {
    if (!currentUser) return;
    try {
        const data = await fetchJsonCached(`${API_BASE}/vitals/trend/${currentUser.id}?period=${period}`, 15000);
        const records = Array.isArray(data) ? data : [];
        renderVitalsCharts(records);
    } catch (e) {
        renderVitalsCharts([]);
    }
}

async function submitVitals() {
    if (!currentUser) { showToast("Please login first", "error"); return; }

    clearVitalsFormErrors();

    const bpSys  = document.getElementById("vf-bp-sys").value.trim();
    const bpDia  = document.getElementById("vf-bp-dia").value.trim();
    const sugar  = document.getElementById("vf-sugar").value.trim();
    const weight = document.getElementById("vf-weight").value.trim();
    const hr     = document.getElementById("vf-hr").value.trim();
    const temp   = document.getElementById("vf-temp").value.trim();
    const notes  = document.getElementById("vf-notes").value.trim();

    if (!bpSys && !bpDia && !sugar && !weight && !hr && !temp) {
        document.getElementById("vf-general-err").textContent = "Please enter at least one vital measurement.";
        return;
    }

    let hasError = false;
    if (bpSys && (Number(bpSys) < 50 || Number(bpSys) > 300)) {
        document.getElementById("vf-bp-sys-err").textContent = "Must be 50–300 mmHg";
        hasError = true;
    }
    if (bpDia && (Number(bpDia) < 30 || Number(bpDia) > 200)) {
        document.getElementById("vf-bp-dia-err").textContent = "Must be 30–200 mmHg";
        hasError = true;
    }
    if (sugar && (Number(sugar) < 20 || Number(sugar) > 600)) {
        document.getElementById("vf-sugar-err").textContent = "Must be 20–600 mg/dL";
        hasError = true;
    }
    if (weight && (Number(weight) < 10 || Number(weight) > 500)) {
        document.getElementById("vf-weight-err").textContent = "Must be 10–500 kg";
        hasError = true;
    }
    if (hr && (Number(hr) < 20 || Number(hr) > 300)) {
        document.getElementById("vf-hr-err").textContent = "Must be 20–300 bpm";
        hasError = true;
    }
    if (temp && (Number(temp) < 30 || Number(temp) > 45)) {
        document.getElementById("vf-temp-err").textContent = "Must be 30–45 °C";
        hasError = true;
    }
    if (hasError) return;

    const body = {
        userId:      currentUser.id,
        bpSystolic:  bpSys  ? parseInt(bpSys)    : null,
        bpDiastolic: bpDia  ? parseInt(bpDia)    : null,
        bloodSugar:  sugar  ? parseFloat(sugar)  : null,
        weight:      weight ? parseFloat(weight) : null,
        heartRate:   hr     ? parseInt(hr)       : null,
        temperature: temp   ? parseFloat(temp)   : null,
        notes:       notes  || null
    };

    const btn = document.getElementById("vitals-submit-btn");
    setButtonLoading(btn, true, "Saving...");

    try {
        const res = await authFetch(`${API_BASE}/vitals/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const err = await res.json();
            document.getElementById("vf-general-err").textContent = err.message || "Failed to save vitals.";
            return;
        }
        invalidateDataCache("/vitals/", "/activities/");
        showToast("Vitals saved successfully!", "success");
        document.getElementById("vitals-form").reset();
        await renderVitalsView();
        await refreshActivityFeed();
    } catch (e) {
        document.getElementById("vf-general-err").textContent = "Connection error. Please try again.";
    } finally {
        setButtonLoading(btn, false, "Save Vitals");
    }
}

function clearVitalsFormErrors() {
    ["vf-bp-sys-err","vf-bp-dia-err","vf-sugar-err","vf-weight-err","vf-hr-err","vf-temp-err","vf-general-err"]
        .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ""; });
}

function renderVitalsSummaryCards(d) {
    const bpEl = document.getElementById("vc-bp");
    const bpSt = document.getElementById("vc-bp-status");
    if (bpEl) bpEl.textContent = (d.bpSystolic && d.bpDiastolic) ? `${d.bpSystolic}/${d.bpDiastolic}` : "—";
    if (bpSt) { bpSt.textContent = formatVitalStatus(d.bpStatus); bpSt.className = "vitals-card-status " + vitalStatusClass(d.bpStatus); }

    const sgEl = document.getElementById("vc-sugar");
    const sgSt = document.getElementById("vc-sugar-status");
    if (sgEl) sgEl.textContent = d.bloodSugar != null ? d.bloodSugar : "—";
    if (sgSt) { sgSt.textContent = formatVitalStatus(d.sugarStatus); sgSt.className = "vitals-card-status " + vitalStatusClass(d.sugarStatus); }


    const wtEl = document.getElementById("vc-weight");
    if (wtEl) wtEl.textContent = d.weight != null ? d.weight : "—";
    const wtSt = document.getElementById("vc-weight-status");
    if (wtSt) { wtSt.textContent = ""; wtSt.className = "vitals-card-status"; }


    const hrEl = document.getElementById("vc-hr");
    const hrSt = document.getElementById("vc-hr-status");
    if (hrEl) hrEl.textContent = d.heartRate != null ? d.heartRate : "—";
    if (hrSt) { hrSt.textContent = formatVitalStatus(d.heartRateStatus); hrSt.className = "vitals-card-status " + vitalStatusClass(d.heartRateStatus); }


    const tpEl = document.getElementById("vc-temp");
    const tpSt = document.getElementById("vc-temp-status");
    if (tpEl) tpEl.textContent = d.temperature != null ? d.temperature : "—";
    if (tpSt) { tpSt.textContent = formatVitalStatus(d.tempStatus); tpSt.className = "vitals-card-status " + vitalStatusClass(d.tempStatus); }
}

function clearVitalsSummaryCards() {
    ["vc-bp","vc-sugar","vc-weight","vc-hr","vc-temp"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = "—";
    });
    ["vc-bp-status","vc-sugar-status","vc-weight-status","vc-hr-status","vc-temp-status"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = ""; el.className = "vitals-card-status"; }
    });
}

function formatVitalStatus(status) {
    if (!status) return "";
    const map = {
        NORMAL: "Normal", ELEVATED: "Elevated", HIGH: "High",
        HIGH_STAGE1: "High", HIGH_STAGE2: "Very High",
        LOW: "Low", FEVER: "Fever", LOW_FEVER: "Low Fever", HYPOTHERMIA: "Low"
    };
    return map[status] || status;
}

function vitalStatusClass(status) {
    if (!status) return "";
    if (status === "NORMAL")  return "vcs-normal";
    if (status === "LOW")     return "vcs-low";
    if (status === "ELEVATED" || status === "HIGH_STAGE1" || status === "LOW_FEVER") return "vcs-elevated";
    if (status === "HIGH" || status === "HIGH_STAGE2" || status === "FEVER") return "vcs-high";
    if (status === "HYPOTHERMIA") return "vcs-hypothermia";
    return "";
}

function checkVitalsAlerts(d) {
    const banner = document.getElementById("vitals-alert-banner");
    const text   = document.getElementById("vitals-alert-text");
    if (!banner || !text) return;

    const alerts = [];
    if (d.bpStatus === "HIGH_STAGE2") alerts.push("Blood pressure is critically high — consult a doctor.");
    else if (d.bpStatus === "HIGH_STAGE1") alerts.push("Blood pressure is elevated.");
    if (d.bpStatus === "LOW") alerts.push("Blood pressure is low.");
    if (d.sugarStatus === "HIGH") alerts.push("Blood sugar is high.");
    if (d.sugarStatus === "LOW")  alerts.push("Blood sugar is low — risk of hypoglycemia.");
    if (d.tempStatus === "FEVER") alerts.push("Fever detected — temperature above 38.5°C.");
    if (d.heartRateStatus === "HIGH") alerts.push("Heart rate is elevated.");
    if (d.heartRateStatus === "LOW")  alerts.push("Heart rate is low (bradycardia).");

    if (alerts.length > 0) {
        text.textContent = alerts.join("  |  ");
        banner.style.display = "flex";
    } else {
        banner.style.display = "none";
    }
}

function renderVitalsTable(records) {
    const tbody = document.getElementById("vitals-table-body");
    const empty = document.getElementById("vitals-table-empty");
    const count = document.getElementById("vitals-record-count");
    if (!tbody) return;

    tbody.innerHTML = "";
    if (count) count.textContent = `${records.length} record${records.length !== 1 ? "s" : ""}`;

    if (!records || records.length === 0) {
        if (empty) empty.style.display = "flex";
        return;
    }
    if (empty) empty.style.display = "none";

    records.forEach(r => {
        const tr = document.createElement("tr");

        const dt = new Date(r.recordedAt);
        const dateStr = dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        const timeStr = dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

        tr.innerHTML = `
            <td style="white-space:nowrap;font-size:0.78rem;">${dateStr}<br><span style="color:var(--text-muted);font-size:0.72rem;">${timeStr}</span></td>
            <td>${buildBpCell(r)}</td>
            <td>${buildValueCell(r.bloodSugar, r.sugarStatus)}</td>
            <td>${r.weight != null ? r.weight : "—"}</td>
            <td>${buildValueCell(r.heartRate, r.heartRateStatus)}</td>
            <td>${buildValueCell(r.temperature, r.tempStatus)}</td>
            <td class="vitals-notes-cell" title="${r.notes || ""}">${r.notes || "—"}</td>
            <td><button class="vitals-delete-btn" data-id="${r.id}">Delete</button></td>
        `;
        tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".vitals-delete-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (!confirm("Delete this vitals record?")) return;
            await deleteVitalRecord(btn.dataset.id);
        });
    });
}

function buildBpCell(r) {
    if (r.bpSystolic == null || r.bpDiastolic == null) return "—";
    const dot = r.bpStatus ? `<span class="vitals-status-dot ${dotClass(r.bpStatus)}"></span>` : "";
    return `${dot}<span class="vitals-bp-pill">${r.bpSystolic}/${r.bpDiastolic}</span>`;
}

function buildValueCell(val, status) {
    if (val == null) return "—";
    const dot = status ? `<span class="vitals-status-dot ${dotClass(status)}"></span>` : "";
    return `${dot}${val}`;
}

function dotClass(status) {
    if (!status) return "";
    if (status === "NORMAL") return "dot-normal";
    if (status === "LOW" || status === "HYPOTHERMIA") return "dot-low";
    if (status === "ELEVATED" || status === "HIGH_STAGE1" || status === "LOW_FEVER") return "dot-elevated";
    return "dot-high";
}

async function deleteVitalRecord(id) {
    try {
        const res = await authFetch(`${API_BASE}/vitals/${id}`, { method: "DELETE" });
        if (res.ok || res.status === 204) {
            showToast("Record deleted", "success");
            await renderVitalsView();
        } else {
            showToast("Failed to delete record", "error");
        }
    } catch (e) {
        showToast("Connection error", "error");
    }
}

function renderVitalsCharts(records) {
    const emptyEl = document.getElementById("vitals-chart-empty");
    const isDark = document.body.classList.contains("dark-mode");

    if (!records || records.length === 0) {
        if (emptyEl) emptyEl.style.display = "block";
        destroyVitalsCharts();
        return;
    }
    if (emptyEl) emptyEl.style.display = "none";

    const labels = records.map(r => {
        const d = new Date(r.recordedAt);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });

    const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    const tickColor = isDark ? "#555555" : "#8c8278";

    const baseOptions = (yLabel) => ({
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: { mode: "index", intersect: false }
        },
        scales: {
            x: {
                grid: { display: false },
                ticks: { color: tickColor, font: { size: 9 }, maxTicksLimit: 8 }
            },
            y: {
                beginAtZero: false,
                grid: { color: gridColor },
                ticks: { color: tickColor, font: { size: 9 } }
            }
        }
    });

    const bpCtx = document.getElementById("vitals-bp-chart");
    if (bpCtx) {
        if (vitalsBpChart) vitalsBpChart.destroy();
        const sysData = records.map(r => r.bpSystolic);
        const diaData = records.map(r => r.bpDiastolic);
        vitalsBpChart = new Chart(bpCtx, {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Systolic",
                        data: sysData,
                        borderColor: isDark ? "#f87171" : "#ef4444",
                        backgroundColor: isDark ? "rgba(248,113,113,0.1)" : "rgba(239,68,68,0.08)",
                        borderWidth: 2,
                        pointRadius: 3,
                        tension: 0.3,
                        fill: true,
                        spanGaps: true
                    },
                    {
                        label: "Diastolic",
                        data: diaData,
                        borderColor: isDark ? "#fbbf24" : "#f59e0b",
                        backgroundColor: "transparent",
                        borderWidth: 2,
                        pointRadius: 3,
                        tension: 0.3,
                        borderDash: [4, 3],
                        spanGaps: true
                    }
                ]
            },
            options: {
                ...baseOptions("mmHg"),
                plugins: {
                    legend: { display: true, labels: { color: tickColor, font: { size: 10 }, boxWidth: 12 } },
                    tooltip: { mode: "index", intersect: false }
                }
            }
        });
    }

    const sgCtx = document.getElementById("vitals-sugar-chart");
    if (sgCtx) {
        if (vitalsSugarChart) vitalsSugarChart.destroy();
        vitalsSugarChart = new Chart(sgCtx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: "Blood Sugar",
                    data: records.map(r => r.bloodSugar),
                    borderColor: isDark ? "#fbbf24" : "#f59e0b",
                    backgroundColor: isDark ? "rgba(251,191,36,0.1)" : "rgba(245,158,11,0.08)",
                    borderWidth: 2,
                    pointRadius: 3,
                    tension: 0.3,
                    fill: true,
                    spanGaps: true
                }]
            },
            options: baseOptions("mg/dL")
        });
    }

    const wtCtx = document.getElementById("vitals-weight-chart");
    if (wtCtx) {
        if (vitalsWeightChart) vitalsWeightChart.destroy();
        vitalsWeightChart = new Chart(wtCtx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: "Weight",
                    data: records.map(r => r.weight),
                    borderColor: isDark ? "#60a5fa" : "#3b82f6",
                    backgroundColor: isDark ? "rgba(96,165,250,0.1)" : "rgba(59,130,246,0.08)",
                    borderWidth: 2,
                    pointRadius: 3,
                    tension: 0.3,
                    fill: true,
                    spanGaps: true
                }]
            },
            options: baseOptions("kg")
        });
    }
}

function destroyVitalsCharts() {
    if (vitalsBpChart)     { vitalsBpChart.destroy();     vitalsBpChart = null; }
    if (vitalsSugarChart)  { vitalsSugarChart.destroy();  vitalsSugarChart = null; }
    if (vitalsWeightChart) { vitalsWeightChart.destroy();  vitalsWeightChart = null; }
}

function renderVitalsInsights(records) {
    const container = document.getElementById("vitals-insights-list");
    if (!container) return;

    if (!records || records.length === 0) {
        container.innerHTML = `<div class="empty-state" style="padding: 1.5rem; text-align: center; color: var(--text-muted);">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 0.5rem; display: block; margin-left: auto; margin-right: auto; opacity: 0.7;"><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41M12 6a6 6 0 0 0-6 6c0 2.22 1.21 4.16 3 5.2V19a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-1.8c1.79-1.04 3-2.98 3-5.2a6 6 0 0 0-6-6z"/></svg>
            <p style="margin: 0; font-size: 0.875rem;">Log vitals to see personalized health insights.</p>
        </div>`;
        return;
    }

    const insights = generateVitalsInsights(records);
    if (insights.length === 0) {
        container.innerHTML = `<div class="empty-state" style="padding: 1.5rem; text-align: center; color: var(--text-muted);">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 0.5rem; display: block; margin-left: auto; margin-right: auto; opacity: 0.7;"><polyline points="20 6 9 17 4 12"/></svg>
            <p style="margin: 0; font-size: 0.875rem;">All vitals look normal. Keep it up!</p>
        </div>`;
        return;
    }

    container.innerHTML = insights.map(i =>
        `<div class="vitals-insight-item insight-${i.type}">
            <span class="vitals-insight-icon">${i.iconSvg || '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'}</span>
            <span class="vitals-insight-text">${escapeHtml(i.text)}</span>
        </div>`
    ).join("");
}

function generateVitalsInsights(records) {
    const insights = [];
    const recent7 = records.slice(0, Math.min(records.length, 7));

    const alertSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    const trendUpSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
    const trendDownSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>';
    const checkSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    const scaleSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 7l9-4 9 4M6 10l-3 6h6l-3-6zM18 10l-3 6h6l-3-6z"/></svg>';
    const heartSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
    const tempSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>';
    const sugarSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>';

    const bpRecords = recent7.filter(r => r.bpSystolic != null && r.bpDiastolic != null);
    if (bpRecords.length > 0) {
        const avgSys = bpRecords.reduce((s, r) => s + r.bpSystolic, 0) / bpRecords.length;
        const avgDia = bpRecords.reduce((s, r) => s + r.bpDiastolic, 0) / bpRecords.length;
        if (avgSys >= 140 || avgDia >= 90) {
            insights.push({ type: "alert", iconSvg: alertSvg, text: `Blood pressure has been consistently high this week (avg ${Math.round(avgSys)}/${Math.round(avgDia)} mmHg). Consider consulting a doctor.` });
        } else if (avgSys >= 130) {
            insights.push({ type: "warning", iconSvg: trendUpSvg, text: `BP slightly elevated this week (avg ${Math.round(avgSys)}/${Math.round(avgDia)} mmHg). Monitor closely.` });
        } else if (avgSys < 90) {
            insights.push({ type: "warning", iconSvg: trendDownSvg, text: `Blood pressure appears low this week. Stay hydrated and consult a doctor if symptoms persist.` });
        } else {
            insights.push({ type: "good", iconSvg: checkSvg, text: `Blood pressure is within normal range this week (avg ${Math.round(avgSys)}/${Math.round(avgDia)} mmHg).` });
        }
    }

    const sugarRecords = recent7.filter(r => r.bloodSugar != null);
    if (sugarRecords.length >= 2) {
        const avgSugar = sugarRecords.reduce((s, r) => s + r.bloodSugar, 0) / sugarRecords.length;
        const maxSugar = Math.max(...sugarRecords.map(r => r.bloodSugar));
        const minSugar = Math.min(...sugarRecords.map(r => r.bloodSugar));
        const fluctuation = maxSugar - minSugar;
        if (avgSugar > 200) {
            insights.push({ type: "alert", iconSvg: sugarSvg, text: `Blood sugar is consistently high (avg ${Math.round(avgSugar)} mg/dL). Seek medical advice.` });
        } else if (fluctuation > 80) {
            insights.push({ type: "warning", iconSvg: alertSvg, text: `Sugar levels fluctuating frequently (range: ${Math.round(minSugar)}–${Math.round(maxSugar)} mg/dL). Maintain consistent meal timing.` });
        } else if (avgSugar < 70) {
            insights.push({ type: "alert", iconSvg: alertSvg, text: `Blood sugar is low on average (${Math.round(avgSugar)} mg/dL). Risk of hypoglycemia — consult your doctor.` });
        } else {
            insights.push({ type: "good", iconSvg: checkSvg, text: `Blood sugar levels are stable this week (avg ${Math.round(avgSugar)} mg/dL).` });
        }
    }

    const weightRecords = records.filter(r => r.weight != null).slice(0, 7);
    if (weightRecords.length >= 2) {
        const first = weightRecords[weightRecords.length - 1].weight;
        const last  = weightRecords[0].weight;
        const diff  = Math.abs(last - first);
        if (diff < 0.5) {
            insights.push({ type: "info", iconSvg: scaleSvg, text: `Weight stable over last ${weightRecords.length} readings (${last} kg).` });
        } else if (last > first) {
            insights.push({ type: "info", iconSvg: trendUpSvg, text: `Weight increased by ${diff.toFixed(1)} kg over recent readings.` });
        } else {
            insights.push({ type: "info", iconSvg: trendDownSvg, text: `Weight decreased by ${diff.toFixed(1)} kg over recent readings.` });
        }
    }

    const hrRecords = recent7.filter(r => r.heartRate != null);
    if (hrRecords.length > 0) {
        const avgHr = hrRecords.reduce((s, r) => s + r.heartRate, 0) / hrRecords.length;
        if (avgHr > 100) {
            insights.push({ type: "warning", iconSvg: heartSvg, text: `Heart rate elevated this week (avg ${Math.round(avgHr)} bpm). Consider reducing stress and caffeine.` });
        } else if (avgHr < 55) {
            insights.push({ type: "info", iconSvg: heartSvg, text: `Resting heart rate is low (avg ${Math.round(avgHr)} bpm). This may be normal for athletes.` });
        }
    }

    const tempRecords = recent7.filter(r => r.temperature != null);
    if (tempRecords.length > 0) {
        const maxTemp = Math.max(...tempRecords.map(r => r.temperature));
        if (maxTemp > 38.5) {
            insights.push({ type: "alert", iconSvg: tempSvg, text: `Fever recorded (${maxTemp}°C). Rest, stay hydrated, and consult a doctor if it persists.` });
        } else if (maxTemp > 37.5) {
            insights.push({ type: "warning", iconSvg: tempSvg, text: `Slightly elevated temperature recorded (${maxTemp}°C). Monitor closely.` });
        }
    }

    return insights;
}

async function renderStreakPanel() {
    if (!currentUser) return;

    try {
        // FIX: call the recalculate endpoint (POST) instead of the read-only
        // GET endpoint.  The GET endpoint returns the last persisted value which
        // stays at 0 until an explicit recalculate is triggered.  By always
        // recalculating on dashboard load we guarantee the streak reflects the
        // actual intake-log history, including doses marked since the last save.
        const res = await authFetch(`${API_BASE}/streaks/recalculate/${currentUser.id}`, {
            method: "POST"
        });
        if (!res.ok) return;
        const data = await res.json();
        applyStreakToUI(data, false);
    } catch (err) {
        console.warn("Streak panel load failed:", err);
    }
}

async function recalculateStreak() {
    if (!currentUser) return;

    try {
        const res = await authFetch(`${API_BASE}/streaks/recalculate/${currentUser.id}`, {
            method: "POST"
        });
        if (!res.ok) return;
        const data = await res.json();
        applyStreakToUI(data, true);

        if (data.newlyUnlockedBadge) {
            const badge = (data.allBadges || []).find(b => b.key === data.newlyUnlockedBadge);
            if (badge) {
                showBadgeUnlockToast(badge);
                triggerConfetti();
            }
        }

        const streak = data.currentStreak || 0;
        if (streak > 0 && [3, 7, 14, 30, 60, 100].includes(streak)) {
            showToast(`${streak}-day streak! Keep it up!`, "success", 4000);
            triggerConfetti();
        }
    } catch (err) {
        console.warn("Streak recalculate failed:", err);
    }
}

function applyStreakToUI(data, animate) {
    const currentStreak  = data.currentStreak  || 0;
    const longestStreak  = data.longestStreak  || 0;
    const perfectWeek    = data.perfectDaysThisWeek  || 0;
    const perfectMonth   = data.perfectDaysThisMonth || 0;
    const allBadges      = data.allBadges || [];
    const unlockedBadges = data.unlockedBadges || [];

    const countEl = document.getElementById("streak-current");
    const bestEl  = document.getElementById("streak-longest");
    const subEl   = document.getElementById("streak-sub-text");
    const fireEl  = document.getElementById("streak-fire-icon");

    if (countEl) {
        countEl.textContent = currentStreak;
        if (animate) countEl.style.animation = "none",
            requestAnimationFrame(() => { countEl.style.animation = "streakCountUp 0.4s ease"; });
    }
    if (bestEl)  bestEl.textContent  = longestStreak;
    if (subEl) {
        if (currentStreak === 0) {
            subEl.textContent = "Take all doses today to start your streak";
        } else if (currentStreak === 1) {
            subEl.textContent = "Great start! Keep going tomorrow";
        } else if (currentStreak < 7) {
            subEl.textContent = `${7 - currentStreak} more days to earn Week Warrior`;
        } else if (currentStreak < 30) {
            subEl.textContent = `${30 - currentStreak} more days to earn Month Master`;
        } else {
            subEl.textContent = "Incredible consistency — you're a champion!";
        }
    }
    if (fireEl) {
        fireEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="22" height="22"><path stroke-linecap="round" stroke-linejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z"/></svg>';
    }

    const weekCount = document.getElementById("streak-week-count");
    if (weekCount) weekCount.textContent = `${perfectWeek}/7 perfect days`;

    const dotsRow = document.getElementById("streak-dots-row");
    if (dotsRow) {
        const dots = dotsRow.querySelectorAll(".streak-dot");
        const today = new Date();
        dots.forEach((dot, i) => {
            const dayOfWeek = today.getDay(); // 0=Sun,1=Mon...
            const mondayOffset = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
            const dotDate = new Date(today);
            dotDate.setDate(today.getDate() + mondayOffset + i);
            dotDate.setHours(0, 0, 0, 0);

            const todayMidnight = new Date(today);
            todayMidnight.setHours(0, 0, 0, 0);

            dot.classList.remove("dot-perfect", "dot-missed", "dot-today");

            if (dotDate.getTime() === todayMidnight.getTime()) {
                dot.classList.add("dot-today");
            } else if (dotDate < todayMidnight) {
                const daysAgo = Math.round((todayMidnight - dotDate) / 86400000);
                if (daysAgo <= currentStreak) {
                    dot.classList.add("dot-perfect");
                } else {
                    dot.classList.add("dot-missed");
                }
            }
            dot.title = dotDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        });
    }

    setMilestoneBar("ms-3day-bar",  "ms-3day-pct",  currentStreak, 3);
    setMilestoneBar("ms-7day-bar",  "ms-7day-pct",  currentStreak, 7);
    setMilestoneBar("ms-30day-bar", "ms-30day-pct", currentStreak, 30);
    setMilestoneBar("ms-week-bar",  "ms-week-pct",  perfectWeek,   7);

    renderBadgesGrid("badges-grid", allBadges, data.newlyUnlockedBadge);

    const badgesCountEl = document.getElementById("badges-unlocked-count");
    if (badgesCountEl) badgesCountEl.textContent = `${unlockedBadges.length} badge${unlockedBadges.length !== 1 ? "s" : ""} earned`;
}

function setMilestoneBar(barId, pctId, current, target) {
    const bar = document.getElementById(barId);
    const pct = document.getElementById(pctId);
    if (!bar || !pct) return;
    const progress = Math.min(100, Math.round((current / target) * 100));
    bar.style.width = progress + "%";
    pct.textContent = progress >= 100 ? "100%" : progress + "%";
}

function renderBadgesGrid(containerId, allBadges, newlyUnlocked) {
    const grid = document.getElementById(containerId);
    if (!grid || !allBadges) return;

    grid.innerHTML = allBadges.map(badge => {
        const isNew = badge.key === newlyUnlocked;
        const cls = badge.unlocked
            ? `badge-unlocked${isNew ? " badge-new-unlock" : ""}`
            : "badge-locked";
        return `
            <div class="badge-item ${cls}" title="${badge.description}">
                ${!badge.unlocked ? '<span class="badge-lock-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg></span>' : ""}
                <span class="badge-emoji">${badge.icon}</span>
                <span class="badge-title">${badge.title}</span>
                <span class="badge-desc">${badge.description}</span>
            </div>`;
    }).join("");
}


async function renderReportsStreak() {
    if (!currentUser) return null;

    try {
        const data = await fetchJsonCached(`${API_BASE}/streaks/${currentUser.id}`, 10000);

        const currentStreak = data.currentStreak  || 0;
        const longestStreak = data.longestStreak  || 0;
        const perfectWeek   = data.perfectDaysThisWeek  || 0;
        const perfectMonth  = data.perfectDaysThisMonth || 0;
        const unlockedBadges = (data.allBadges || []).filter(b => b.unlocked);

        const rptCurrent = document.getElementById("rpt-current-streak");
        const rptLongest = document.getElementById("rpt-longest-streak");
        const rptWeek    = document.getElementById("rpt-perfect-week");
        const rptMonth   = document.getElementById("rpt-perfect-month");

        if (rptCurrent) rptCurrent.textContent = currentStreak;
        if (rptLongest) rptLongest.textContent = longestStreak;
        if (rptWeek)    rptWeek.textContent    = `${perfectWeek}/7`;
        if (rptMonth)   rptMonth.textContent   = `${perfectMonth}/30`;

        const insightEl  = document.getElementById("rpt-ai-insight");
        const insightText = document.getElementById("rpt-ai-text");
        if (insightEl && insightText) {
            const msg = generateAiInsight(currentStreak, longestStreak, perfectWeek, unlockedBadges.length);
            insightText.textContent = msg;
            insightEl.style.display = "flex";
        }

        const badgesGrid = document.getElementById("rpt-badges-grid");
        if (badgesGrid) {
            if (unlockedBadges.length === 0) {
                badgesGrid.innerHTML = '<p class="empty-state" style="font-size:0.8rem;">No badges yet — keep taking your doses!</p>';
            } else {
                badgesGrid.innerHTML = unlockedBadges.map(b =>
                    `<div class="rpt-badge-chip">
                        <span class="rpt-badge-chip-icon">${b.icon}</span>
                        <span>${b.title}</span>
                    </div>`
                ).join("");
            }
        }

        // Return the live streak DTO so renderReports() can thread it into
        // renderAnalyticsDashboard(), eliminating the stale GET /streaks call.
        return data;
    } catch (err) {
        console.warn("Reports streak load failed:", err);
        return null;
    }
}

function generateAiInsight(streak, longest, perfectWeek, badgeCount) {
    if (streak === 0 && longest === 0) {
        return "Start taking your doses consistently to build your first streak. Even one perfect day is a great beginning!";
    }
    if (streak === 0 && longest > 0) {
        return `You had a best streak of ${longest} days. Don't give up — restart today and beat your record!`;
    }
    if (streak >= 30) {
        return `Outstanding! A ${streak}-day streak shows exceptional dedication to your health. You're an Adherence Master!`;
    }
    if (streak >= 14) {
        return `Excellent work maintaining a ${streak}-day streak! You're building a powerful health habit.`;
    }
    if (streak >= 7) {
        return `Great job maintaining a ${streak}-day streak! Consistency like this significantly improves treatment outcomes.`;
    }
    if (streak >= 3) {
        return `You're on a ${streak}-day streak — keep going! ${7 - streak} more days to earn the Week Warrior badge.`;
    }
    if (perfectWeek >= 5) {
        return `${perfectWeek} out of 7 days this week were perfect. You're improving adherence consistency!`;
    }
    if (badgeCount > 0) {
        return `You've earned ${badgeCount} achievement badge${badgeCount > 1 ? "s" : ""}. Keep up the great work!`;
    }
    return "You're building a healthy habit. Take all scheduled doses today to grow your streak!";
}

function showBadgeUnlockToast(badge) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = "toast toast-success";
    toast.setAttribute("role", "alert");
    toast.innerHTML = `
        <span class="toast-icon" style="font-size:1.2rem;">${badge.icon}</span>
        <div style="flex:1;">
            <div style="font-weight:700;font-size:0.82rem;">Badge Unlocked: ${badge.title}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:1px;">${badge.description}</div>
        </div>
        <button class="toast-close" aria-label="Dismiss">&times;</button>
    `;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("toast-visible"));

    const dismiss = () => {
        toast.classList.remove("toast-visible");
        toast.classList.add("toast-hiding");
        setTimeout(() => toast.remove(), 300);
    };
    toast.querySelector(".toast-close").addEventListener("click", dismiss);
    setTimeout(dismiss, 5000);
}

function triggerConfetti() {
    const colors = ["#00A19B", "#f97316", "#22c55e", "#7c3aed", "#f59e0b", "#ef4444"];
    const container = document.createElement("div");
    container.className = "confetti-container";
    document.body.appendChild(container);

    for (let i = 0; i < 28; i++) {
        const piece = document.createElement("div");
        piece.className = "confetti-piece";
        piece.style.cssText = `
            left: ${Math.random() * 100}%;
            background: ${colors[Math.floor(Math.random() * colors.length)]};
            animation-delay: ${Math.random() * 0.5}s;
            animation-duration: ${1.0 + Math.random() * 0.8}s;
            transform: rotate(${Math.random() * 360}deg);
            width: ${6 + Math.random() * 6}px;
            height: ${6 + Math.random() * 6}px;
            border-radius: ${Math.random() > 0.5 ? "50%" : "2px"};
        `;
        container.appendChild(piece);
    }

    setTimeout(() => container.remove(), 2500);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SINGLE SOURCE OF TRUTH: period filter helper
//
//  Replaces the old duplicate adashFilterByPeriod / filterByPeriod functions.
//  Both call sites now use this one function.
//
//  @param {Array}  items      - array of objects to filter
//  @param {string|number} period
//                 "all" → return everything
//                 number or numeric string → return items from last N days
//  @param {string} dateField  - key on each item whose value is a date string
//  @returns {Array} filtered subset
// ─────────────────────────────────────────────────────────────────────────────
function filterByPeriod(items, period, dateField) {
    if (period === "all" || !period) return items;
    const days = parseInt(period, 10);
    if (isNaN(days) || days <= 0) return items;
    // Start of the cutoff day (midnight, local time).
    // "days=7" covers today + the 6 preceding calendar days.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    cutoff.setHours(0, 0, 0, 0);

    // Build a "YYYY-MM-DD" string for the cutoff so we can compare date
    // strings directly.  Using string comparison on ISO dates avoids the
    // UTC-vs-local pitfall: new Date("2026-06-07") is parsed as UTC midnight,
    // so comparing it to a local-midnight Date object fails for UTC+ zones —
    // today's logs would be incorrectly excluded.
    const cutoffStr = [
        cutoff.getFullYear(),
        String(cutoff.getMonth() + 1).padStart(2, "0"),
        String(cutoff.getDate()).padStart(2, "0")
    ].join("-"); // "YYYY-MM-DD"

    return items.filter(item => {
        const dateStr = (item[dateField] || "").substring(0, 10); // "YYYY-MM-DD"
        return dateStr >= cutoffStr;
    });
}

function fmtDateTime(d) {
    if (!d) return "—";
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleString("en-GB", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit"
    });
}

function fmtDate(d) {
    if (!d) return "—";
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

function setExportLoading(btn, loadingText) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span style="opacity:0.7">${loadingText}</span>`;
    return () => { btn.disabled = false; btn.innerHTML = orig; };
}

const PDF_BRAND   = [0, 161, 155];   // --primary #00A19B
const PDF_DARK    = [26, 23, 20];    // --text-primary
const PDF_MUTED   = [140, 130, 120]; // --text-muted
const PDF_BORDER  = [207, 200, 190]; // --border
const PDF_SUCCESS = [45, 164, 78];   // --success
const PDF_DANGER  = [220, 38, 38];   // --danger
const PDF_LIGHT   = [245, 241, 236]; // --surface

function pdfHeader(doc, title, subtitle) {
    const W = doc.internal.pageSize.getWidth();

    // Teal header bar
    doc.setFillColor(...PDF_BRAND);
    doc.rect(0, 0, W, 20, "F");

    // White brand pill (left)
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(10, 4, 36, 12, 3, 3, "F");

    // Brand name — ASCII-safe, no emoji
    doc.setTextColor(...PDF_BRAND);
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("DoseBuddy", 14, 12);

    // Centered report title
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(title, W / 2, 12, { align: "center" });

    // Right-aligned subtitle (date)
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.text(subtitle, W - 10, 12, { align: "right" });

    // Thin accent line below header
    doc.setDrawColor(...PDF_BRAND);
    doc.setLineWidth(0.5);
    doc.line(0, 20, W, 20);

    doc.setTextColor(...PDF_DARK);
    return 26;
}

function pdfSection(doc, y, text) {
    const W = doc.internal.pageSize.getWidth();
    doc.setFillColor(...PDF_LIGHT);
    doc.rect(10, y, W - 20, 8, "F");
    doc.setDrawColor(...PDF_BORDER);
    doc.rect(10, y, W - 20, 8, "S");
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...PDF_BRAND);
    doc.text(text.toUpperCase(), 14, y + 5.5);
    doc.setTextColor(...PDF_DARK);
    doc.setFont("helvetica", "normal");
    return y + 12;
}

function pdfInfoRow(doc, y, label, value) {
    doc.setFontSize(8.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...PDF_MUTED);
    doc.text(label + ":", 14, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...PDF_DARK);
    doc.text(String(value ?? "—"), 60, y);
    return y + 6;
}

function pdfFooter(doc) {
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setDrawColor(...PDF_BORDER);
        doc.line(10, H - 12, W - 10, H - 12);
        doc.setFontSize(7);
        doc.setTextColor(...PDF_MUTED);
        doc.text("DoseBuddy — Confidential Medical Report", 14, H - 7);
        doc.text(`Page ${i} of ${pages}`, W - 14, H - 7, { align: "right" });
    }
}

async function fetchAllHistoryPages(userId, maxRecords = 5000) {
    const size = 500;
    const records = [];
    for (let page = 0; records.length < maxRecords; page++) {
        const res = await authFetch(`${API_BASE}/logs/history/${userId}?page=${page}&size=${size}`);
        if (!res.ok) throw new Error("Failed to fetch history");
        const batch = await res.json();
        records.push(...batch);
        if (batch.length < size) break;
    }
    return records.slice(0, maxRecords);
}


async function exportReportsPDF() {
    if (!currentUser) { showToast("Please log in first", "error"); return; }
    const btn = document.getElementById("export-reports-pdf");
    const restore = setExportLoading(btn, "Generating…");

    try {
        const period = adashCurrentPeriod !== undefined
            ? (adashCurrentPeriod === "all" ? "all" : String(adashCurrentPeriod))
            : "all";
        const now = new Date();

        const statsDays = period === "all" ? 0 : Number(period);
        const [history, statsRes, bmi, vitalsRes, streakRes] = await Promise.all([
            fetchAllHistoryPages(currentUser.id),
            authFetch(`${API_BASE}/logs/adherence/stats/${currentUser.id}?days=${statsDays}`),
            fetchJsonCached(`${API_BASE}/bmi/latest/${currentUser.id}`, 15000).catch(() => null),
            authFetch(`${API_BASE}/vitals/recent/${currentUser.id}?limit=100`),
            // Use recalculate (POST) not the read-only GET endpoint.
            // The GET endpoint always returns perfectDaysThisWeek/Month = 0
            // because it returns the last persisted snapshot, not a live value.
            authFetch(`${API_BASE}/streaks/recalculate/${currentUser.id}`, { method: "POST" })
        ]);

        const stats    = statsRes.ok ? await statsRes.json() : {};
        const vitals   = vitalsRes.ok ? await vitalsRes.json() : [];
        const streak   = streakRes.ok ? await streakRes.json() : {};

        const filtered = filterByPeriod(history, period, "date");

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        const W = doc.internal.pageSize.getWidth();
        const periodLabel = period === "all" ? "All Time" : `Last ${period} Days`;

        let y = pdfHeader(doc, "Medical Report", `Generated: ${fmtDateTime(now)}`);

        y = pdfSection(doc, y, "1. Patient Information");
        y = pdfInfoRow(doc, y, "Name",        currentUser.name  || "—");
        y = pdfInfoRow(doc, y, "Email",       currentUser.email || "—");
        y = pdfInfoRow(doc, y, "Account Type", currentUser.role  || "PATIENT");
        y = pdfInfoRow(doc, y, "Report Period", periodLabel);
        y = pdfInfoRow(doc, y, "Export Date",  fmtDateTime(now));
        y += 4;

        y = pdfSection(doc, y, "2. Medication Summary");
        const taken    = stats.takenDoses   ?? 0;
        const missed   = stats.missedDoses  ?? 0;
        const total    = stats.totalDoses   ?? 0;
        const adherPct = stats.adherencePercentage ?? 0;
        y = pdfInfoRow(doc, y, "Total Doses",    total);
        y = pdfInfoRow(doc, y, "Doses Taken",    taken);
        y = pdfInfoRow(doc, y, "Doses Missed",   missed);
        y = pdfInfoRow(doc, y, "Adherence Rate", `${adherPct}%`);
        y = pdfInfoRow(doc, y, "Most Missed",    stats.mostMissedMedicine || "—");
        y += 4;

        y = pdfSection(doc, y, "3. Streak & Achievements");
        y = pdfInfoRow(doc, y, "Current Streak",  `${streak.currentStreak ?? 0} days`);
        y = pdfInfoRow(doc, y, "Best Streak",     `${streak.longestStreak ?? 0} days`);
        const earnedBadges = (streak.allBadges || []).filter(b => b.unlocked).map(b => b.title).join(", ") || "None yet";
        y = pdfInfoRow(doc, y, "Badges Earned",   earnedBadges);
        y += 4;

        y = pdfSection(doc, y, "4. Medicine History");
        if (filtered.length === 0) {
            doc.setFontSize(8.5); doc.setTextColor(...PDF_MUTED);
            doc.text("No history records for the selected period.", 14, y + 4);
            y += 10;
        } else {
            doc.autoTable({
                startY: y,
                margin: { left: 10, right: 10 },
                head: [["Date", "Time", "Medicine", "Dosage", "Status"]],
                body: filtered.map(l => [
                    l.date || "—",
                    l.time || "—",
                    l.medicineName || "—",
                    l.dosage || "—",
                    l.status || "—"
                ]),
                styles: { fontSize: 8, cellPadding: 2.5, font: "helvetica" },
                headStyles: { fillColor: PDF_BRAND, textColor: 255, fontStyle: "bold", fontSize: 8 },
                alternateRowStyles: { fillColor: [250, 248, 245] },
                columnStyles: {
                    4: {
                        fontStyle: "bold",
                        textColor: (cell) => cell.raw === "TAKEN" ? PDF_SUCCESS : cell.raw === "MISSED" ? PDF_DANGER : PDF_MUTED
                    }
                },
                didParseCell(data) {
                    if (data.column.index === 4 && data.section === "body") {
                        const v = data.cell.raw;
                        data.cell.styles.textColor = v === "TAKEN" ? PDF_SUCCESS : v === "MISSED" ? PDF_DANGER : PDF_MUTED;
                    }
                }
            });
            y = doc.lastAutoTable.finalY + 6;
        }

        if (y > 240) { doc.addPage(); y = pdfHeader(doc, "Medical Report (cont.)", `Generated: ${fmtDateTime(now)}`); }
        y = pdfSection(doc, y, "5. BMI Information");
        if (bmi) {
            y = pdfInfoRow(doc, y, "BMI Value",    bmi.bmiValue?.toFixed(1) ?? "—");
            y = pdfInfoRow(doc, y, "Category",     bmi.bmiCategory ?? "—");
            y = pdfInfoRow(doc, y, "Height",       bmi.height ? `${bmi.height} cm` : "—");
            y = pdfInfoRow(doc, y, "Weight",       bmi.weight ? `${bmi.weight} kg` : "—");
            if (bmi.healthSuggestions?.length) {
                y += 2;
                doc.setFontSize(8); doc.setFont("helvetica", "bold"); doc.setTextColor(...PDF_MUTED);
                doc.text("Health Suggestions:", 14, y); y += 5;
                doc.setFont("helvetica", "normal"); doc.setTextColor(...PDF_DARK);
                bmi.healthSuggestions.slice(0, 3).forEach(s => {
                    doc.text(`• ${s}`, 16, y, { maxWidth: W - 30 }); y += 5;
                });
            }
        } else {
            doc.setFontSize(8.5); doc.setTextColor(...PDF_MUTED);
            doc.text("No BMI data recorded.", 14, y + 4); y += 10;
        }
        y += 4;

        if (y > 220) { doc.addPage(); y = pdfHeader(doc, "Medical Report (cont.)", `Generated: ${fmtDateTime(now)}`); }
        y = pdfSection(doc, y, "6. Vitals Log");
        const filteredVitals = filterByPeriod(vitals, period, "recordedAt");
        if (filteredVitals.length === 0) {
            doc.setFontSize(8.5); doc.setTextColor(...PDF_MUTED);
            doc.text("No vitals recorded for the selected period.", 14, y + 4); y += 10;
        } else {
            doc.autoTable({
                startY: y,
                margin: { left: 10, right: 10 },
                head: [["Date", "BP (mmHg)", "Sugar (mg/dL)", "Weight (kg)", "HR (bpm)", "Temp (°C)"]],
                body: filteredVitals.slice(0, 50).map(v => [
                    fmtDate(v.recordedAt),
                    (v.bpSystolic && v.bpDiastolic) ? `${v.bpSystolic}/${v.bpDiastolic}` : "—",
                    v.bloodSugar ?? "—",
                    v.weight     ?? "—",
                    v.heartRate  ?? "—",
                    v.temperature ?? "—"
                ]),
                styles: { fontSize: 7.5, cellPadding: 2, font: "helvetica" },
                headStyles: { fillColor: PDF_BRAND, textColor: 255, fontStyle: "bold", fontSize: 8 },
                alternateRowStyles: { fillColor: [250, 248, 245] }
            });
            y = doc.lastAutoTable.finalY + 6;
        }

        if (y > 240) { doc.addPage(); y = pdfHeader(doc, "Medical Report (cont.)", `Generated: ${fmtDateTime(now)}`); }
        y = pdfSection(doc, y, "7. Health Insights & Recommendations");
        const insight = generateAiInsight(
            streak.currentStreak ?? 0,
            streak.longestStreak ?? 0,
            streak.perfectDaysThisWeek ?? 0,
            (streak.allBadges || []).filter(b => b.unlocked).length
        );
        doc.setFontSize(8.5); doc.setFont("helvetica", "italic"); doc.setTextColor(...PDF_DARK);
        doc.text(`"${insight}"`, 14, y + 4, { maxWidth: W - 28 }); y += 12;
        doc.setFont("helvetica", "normal");
        if (adherPct < 70) {
            doc.setTextColor(...PDF_DANGER);
            doc.text(`[!] Adherence is ${adherPct}% - below the recommended 70% threshold. Please consult your healthcare provider.`, 14, y, { maxWidth: W - 28 });
            y += 8;
        } else {
            doc.setTextColor(...PDF_SUCCESS);
            doc.text(`[OK] Adherence is ${adherPct}% - above the 70% threshold. Keep up the great work!`, 14, y, { maxWidth: W - 28 });
            y += 8;
        }
        doc.setTextColor(...PDF_MUTED);
        doc.setFontSize(7.5);
        doc.text("Disclaimer: This report is generated by DoseBuddy for informational purposes only. Always consult a qualified healthcare professional.", 14, y + 4, { maxWidth: W - 28 });

        pdfFooter(doc);
        doc.save(`DoseBuddy_Report_${currentUser.name?.replace(/\s+/g, "_") || "User"}_${now.toISOString().slice(0,10)}.pdf`);
        showToast("Medical report downloaded successfully", "success");
    } catch (err) {
        console.error("PDF export error:", err);
        showToast("Failed to generate PDF. Please try again.", "error");
    } finally {
        restore();
    }
}


async function exportHistoryPDF() {
    if (!currentUser) { showToast("Please log in first", "error"); return; }
    const btn = document.getElementById("export-history-pdf");
    const restore = setExportLoading(btn, "Generating…");

    try {
        const [history, stats] = await Promise.all([
            fetchAllHistoryPages(currentUser.id),
            fetchJsonCached(`${API_BASE}/logs/adherence/stats/${currentUser.id}?days=0`, 10000)
        ]);
        const now = new Date();

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        const W = doc.internal.pageSize.getWidth();

        let y = pdfHeader(doc, "Dose History Report", `Generated: ${fmtDateTime(now)}`);

        y = pdfSection(doc, y, "Patient Information");
        y = pdfInfoRow(doc, y, "Name",  currentUser.name  || "—");
        y = pdfInfoRow(doc, y, "Email", currentUser.email || "—");
        y = pdfInfoRow(doc, y, "Date",  fmtDateTime(now));
        y += 4;

        const taken   = stats.takenDoses || 0;
        const missed  = stats.missedDoses || 0;
        const total   = stats.totalDoses || 0;
        const adh     = stats.adherencePercentage || 0;

        y = pdfSection(doc, y, "Summary");
        y = pdfInfoRow(doc, y, "Total Records", total);
        y = pdfInfoRow(doc, y, "Taken",         taken);
        y = pdfInfoRow(doc, y, "Missed",        missed);
        y = pdfInfoRow(doc, y, "Adherence",     `${adh}%`);
        y += 4;

        y = pdfSection(doc, y, "Complete Dose History");
        if (history.length === 0) {
            doc.setFontSize(8.5); doc.setTextColor(...PDF_MUTED);
            doc.text("No history records found.", 14, y + 4);
        } else {
            doc.autoTable({
                startY: y,
                margin: { left: 10, right: 10 },
                head: [["Date", "Time", "Medicine", "Dosage", "Status"]],
                body: history.map(l => [l.date || "—", l.time || "—", l.medicineName || "—", l.dosage || "—", l.status || "—"]),
                styles: { fontSize: 8, cellPadding: 2.5 },
                headStyles: { fillColor: PDF_BRAND, textColor: 255, fontStyle: "bold" },
                alternateRowStyles: { fillColor: [250, 248, 245] },
                didParseCell(data) {
                    if (data.column.index === 4 && data.section === "body") {
                        const v = data.cell.raw;
                        data.cell.styles.textColor = v === "TAKEN" ? PDF_SUCCESS : v === "MISSED" ? PDF_DANGER : PDF_MUTED;
                        data.cell.styles.fontStyle = "bold";
                    }
                }
            });
        }

        pdfFooter(doc);
        doc.save(`DoseBuddy_History_${currentUser.name?.replace(/\s+/g, "_") || "User"}_${now.toISOString().slice(0,10)}.pdf`);
        showToast("History report downloaded", "success");
    } catch (err) {
        console.error("History PDF error:", err);
        showToast("Failed to generate history PDF.", "error");
    } finally {
        restore();
    }
}

async function exportVitalsPDF() {
    if (!currentUser) { showToast("Please log in first", "error"); return; }
    const btn = document.getElementById("export-vitals-pdf");
    const restore = setExportLoading(btn, "Generating…");

    try {
        const [vitalsRes, bmi] = await Promise.all([
            authFetch(`${API_BASE}/vitals/recent/${currentUser.id}?limit=100`),
            fetchJsonCached(`${API_BASE}/bmi/latest/${currentUser.id}`, 15000).catch(() => null)
        ]);
        const vitals = vitalsRes.ok ? await vitalsRes.json() : [];
        const now    = new Date();

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        const W = doc.internal.pageSize.getWidth();

        let y = pdfHeader(doc, "Vitals & Health Metrics Report", `Generated: ${fmtDateTime(now)}`);

        y = pdfSection(doc, y, "Patient Information");
        y = pdfInfoRow(doc, y, "Name",  currentUser.name  || "—");
        y = pdfInfoRow(doc, y, "Email", currentUser.email || "—");
        y = pdfInfoRow(doc, y, "Date",  fmtDateTime(now));
        y += 4;

        y = pdfSection(doc, y, "BMI Summary");
        if (bmi) {
            y = pdfInfoRow(doc, y, "BMI Value",  bmi.bmiValue?.toFixed(1) ?? "—");
            y = pdfInfoRow(doc, y, "Category",   bmi.bmiCategory ?? "—");
            y = pdfInfoRow(doc, y, "Height",     bmi.height ? `${bmi.height} cm` : "—");
            y = pdfInfoRow(doc, y, "Weight",     bmi.weight ? `${bmi.weight} kg` : "—");
        } else {
            doc.setFontSize(8.5); doc.setTextColor(...PDF_MUTED);
            doc.text("No BMI data recorded.", 14, y + 4);
        }
        y += 6;

        y = pdfSection(doc, y, "Vitals History");
        if (vitals.length === 0) {
            doc.setFontSize(8.5); doc.setTextColor(...PDF_MUTED);
            doc.text("No vitals recorded yet.", 14, y + 4);
        } else {
            doc.autoTable({
                startY: y,
                margin: { left: 10, right: 10 },
                head: [["Date & Time", "BP (mmHg)", "Sugar (mg/dL)", "Weight (kg)", "HR (bpm)", "Temp (°C)", "Notes"]],
                body: vitals.map(v => [
                    fmtDateTime(v.recordedAt),
                    (v.bpSystolic && v.bpDiastolic) ? `${v.bpSystolic}/${v.bpDiastolic}` : "—",
                    v.bloodSugar  ?? "—",
                    v.weight      ?? "—",
                    v.heartRate   ?? "—",
                    v.temperature ?? "—",
                    v.notes       || "—"
                ]),
                styles: { fontSize: 7.5, cellPadding: 2 },
                headStyles: { fillColor: PDF_BRAND, textColor: 255, fontStyle: "bold", fontSize: 8 },
                alternateRowStyles: { fillColor: [250, 248, 245] },
                columnStyles: { 6: { cellWidth: 30, fontSize: 7 } }
            });
        }

        pdfFooter(doc);
        doc.save(`DoseBuddy_Vitals_${currentUser.name?.replace(/\s+/g, "_") || "User"}_${now.toISOString().slice(0,10)}.pdf`);
        showToast("Vitals report downloaded", "success");
    } catch (err) {
        console.error("Vitals PDF error:", err);
        showToast("Failed to generate vitals PDF.", "error");
    } finally {
        restore();
    }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("export-reports-pdf")
        ?.addEventListener("click", exportReportsPDF);
    document.getElementById("export-history-pdf")
        ?.addEventListener("click", exportHistoryPDF);
    document.getElementById("export-vitals-pdf")
        ?.addEventListener("click", exportVitalsPDF);
});
