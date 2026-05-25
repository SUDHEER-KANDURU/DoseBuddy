const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase)
    ? window.APP_CONFIG.apiBase
    : "https://dosebuddy-production.up.railway.app/api";
const LS_CURRENT_USER_KEY = "dosebuddy_current_user";

let currentUser = null;
let logs = [];
let medsCache = [];
let medsCacheDate = null;
let lastReminderKey = null;
let weeklyChart = null;

const ACTIVITY_TYPES = {
    MEDICINE_ADDED:        { icon: "💊", dot: "activity-dot-added",    badge: "badge-blue",   label: "Medicine Added"    },
    DOSE_TAKEN:            { icon: "✅", dot: "activity-dot-taken",    badge: "badge-green",  label: "Dose Taken"        },
    DOSE_MISSED:           { icon: "⚠️", dot: "activity-dot-missed",   badge: "badge-red",    label: "Missed Dose"       },
    DOSE_SCHEDULED:        { icon: "📅", dot: "activity-dot-pending",  badge: "badge-blue",   label: "Dose Scheduled"    },
    BMI_CALCULATED:        { icon: "📊", dot: "activity-dot-bmi",      badge: "badge-purple", label: "BMI Updated"       },
    SYMPTOM_CHECK:         { icon: "🩺", dot: "activity-dot-symptom",  badge: "badge-orange", label: "Symptom Check"     },
    AI_MEDICINE_INFO:      { icon: "🔍", dot: "activity-dot-ai",       badge: "badge-purple", label: "Medicine Search"   },
    PROFILE_UPDATED:       { icon: "👤", dot: "activity-dot-profile",  badge: "badge-blue",   label: "Profile Updated"   },
    MEDICINE_DELETED:      { icon: "🗑️", dot: "activity-dot-missed",   badge: "badge-red",    label: "Medicine Removed"  },
    PASSWORD_CHANGED:      { icon: "🔒", dot: "activity-dot-profile",  badge: "badge-green",  label: "Security Update"   },
    PRESCRIPTION_UPLOADED: { icon: "📄", dot: "activity-dot-added",    badge: "badge-blue",   label: "Prescription"      },
    VITALS_LOGGED:         { icon: "🩺", dot: "activity-dot-bmi",      badge: "badge-green",  label: "Vitals Logged"     },
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
        const response = await fetch(`${API_BASE}/activities/recent/${currentUser.id}?limit=10`);
        if (!response.ok) {
            throw new Error("Failed to fetch activities");
        }

        const activities = await response.json();

        if (!activities || activities.length === 0) {
            container.innerHTML = `
                <div class="activity-empty">
                    <span class="activity-empty-icon">📋</span>
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
                        <span class="activity-icon-emoji" aria-hidden="true">${def.icon}</span>
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
                <span class="activity-empty-icon">⚠️</span>
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
        await fetch(`${API_BASE}/logs/mark-missed-batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(missedEntries),
        });
    } catch (err) {
        console.error("logMissedDoseActivities error:", err);
    }
}

let scheduledTimeouts = [];
let activeReminderAudio = null;


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
   
    document.body.addEventListener("click", () => {
        const audio = document.getElementById("notify-sound");
        if (audio) {
            audio.load(); 
        }
    }, { once: true });
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

    
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
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
    } else {
        showAuthView();
        setThemeToggleVisible(false);
    }
    setInterval(checkReminders, 30000);
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

    setupLegalModals();

    document.getElementById("su-password")?.addEventListener("input", (e) => {
        updatePasswordStrength(e.target.value, "su-pw-fill", "su-pw-label", "su-pw-strength");
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
                dob: document.getElementById("su-dob")?.value || "",
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
    ["su-name-error","su-email-error","su-pw-error","su-phone-error","su-dob-error",
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
    const res = await fetch(`${API_BASE}/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (errorElem) errorElem.textContent = data.message || "Signup failed.";
        return;
    }

    const user = await res.json();

    try {
        const fullProfile = await fetchFullProfile(user.id);
        currentUser = fullProfile || user;
        saveToLS(LS_CURRENT_USER_KEY, currentUser);
        showAppViews();
        switchView("dashboard-view");
        showToast(`Welcome to DoseBuddy, ${currentUser.name || ""}! 🎉`, "success", 4000);
    } catch (err) {
        console.error("Post-signup processing error:", err);
        currentUser = user;
        saveToLS(LS_CURRENT_USER_KEY, currentUser);
        showAppViews();
        switchView("dashboard-view");
        showToast(`Welcome to DoseBuddy, ${currentUser.name || ""}! 🎉`, "success", 4000);
    }
}

async function handleLoginApi(email, password, errorElem) {
    const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
    });

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errorElem.textContent = data.message || "Login failed.";
        return;
    }

    const user = await res.json();

    try {
        const fullProfile = await fetchFullProfile(user.id);
        currentUser = fullProfile || user;
        saveToLS(LS_CURRENT_USER_KEY, currentUser);
        showAppViews();
        switchView("dashboard-view");
        showToast(`Welcome back, ${currentUser.name || ""}!`, "success", 3000);
    } catch (err) {
        console.error("Post-login processing error:", err);
        currentUser = user;
        saveToLS(LS_CURRENT_USER_KEY, currentUser);
        showAppViews();
        switchView("dashboard-view");
        showToast(`Welcome back, ${currentUser.name || ""}!`, "success", 3000);
    }
}

async function fetchFullProfile(userId) {
    if (!userId) return null;
    try {
        const res = await fetch(`${API_BASE}/user/profile/${userId}`);
        if (!res.ok) {
            console.warn("fetchFullProfile: server returned", res.status);
            return null;
        }
        return await res.json();
    } catch (e) {
        console.error("fetchFullProfile error:", e);
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
        showAuthView();
    }

    if (menuLogoutBtn) {
        menuLogoutBtn.addEventListener("click", () => {
            doLogout();
            closeUserMenu();
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

    const todayStr = new Date().toISOString().split("T")[0];
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
            const res = await fetch(`${API_BASE}/medications/add`, {
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

            await renderDashboard();
            await renderReports();
            await refreshActivityFeed();
        } catch (err) {
            console.error(err);
            errorText.textContent = "Error connecting to server.";
            showToast("Error connecting to server.", "error");
        }
    });
}

async function renderDashboard() {
    if (!currentUser) return;

    const dateElem = document.getElementById("dashboard-date");
    const noMedsMsg = document.getElementById("no-meds-message");
    const tbody = document.getElementById("schedule-body");
    const scheduleTable = document.getElementById("schedule-table");
    const statsElem = document.getElementById("today-stats");

    if (!dateElem || !tbody || !scheduleTable || !noMedsMsg) return;

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    let headerText = `For ${todayStr}`;
    let medsUrl;

    if (currentUser.role === "CAREGIVER" && currentUser.patientEmail) {
        headerText += ` · Patient: ${currentUser.patientEmail}`;
        medsUrl = `${API_BASE}/medications/today-by-email/${encodeURIComponent(
            currentUser.patientEmail
        )}`;
    } else {
        medsUrl = `${API_BASE}/medications/today/${currentUser.id}`;
    }

    dateElem.textContent = headerText;

    tbody.innerHTML = "";
    noMedsMsg.style.display = "none";
    scheduleTable.style.display = "table";

    try {
        const logsRes = await fetch(`${API_BASE}/logs/history/${currentUser.id}`);
        logs = logsRes.ok ? await logsRes.json() : [];

        const medsRes = await fetch(medsUrl);
        if (!medsRes.ok) throw new Error("Failed to load medicines");
        const meds = await medsRes.json();

        medsCache = meds;
        medsCacheDate = todayStr;

        if (!Array.isArray(meds) || meds.length === 0) {

            document.getElementById("totalDoses").textContent = 0;
            document.getElementById("takenDoses").textContent = 0;
            document.getElementById("pendingDoses").textContent = 0;
            document.getElementById("adherence").textContent = "0%";

            noMedsMsg.style.display = "block";
            scheduleTable.style.display = "none";
            if (statsElem) statsElem.textContent = "";
            clearScheduledTimeouts();
            return;
        }

        const nowMinutes = today.getHours() * 60 + today.getMinutes();
        let totalDoses = 0;
        let takenDoses = 0;
        let missedDoses = 0;

        meds.forEach((med) => {
            if (!Array.isArray(med.times)) return;
            med.times.forEach((timeObj) => {
                totalDoses++;
                const tr = document.createElement("tr");
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
                    btn.textContent = doseStatus === "TAKEN" ? "✔" : "Missed";
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
                        await renderReports();
                        await refreshActivityFeed();
                    });
                }

                    let deleteBtn = null;

                    if (timeObj === med.times[0]) {
                        deleteBtn = document.createElement("button");
                        deleteBtn.textContent = "Delete";
                        deleteBtn.className = "action-btn action-btn-delete";

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
        const percent = totalDoses === 0 ? 0 : Math.round((takenDoses / totalDoses) * 100);

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
        scheduleNotificationsForToday();
        scheduleMedicineReminders();

        await logMissedDoseActivities(meds, todayStr);

        loadLatestBmi();

        renderRecentActivity();
        renderStreakPanel();
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
        if (!Array.isArray(med.times)) return;
        med.times.forEach(t => {
            const time       = (t.timeOfDay || "").substring(0, 5);
            const [h, m]     = time.split(":").map(Number);
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
    notifStore = [...newItems, ...existing].slice(0, 20);

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

    try {
        const res = await fetch(`${API_BASE}/medications/${medId}`, {
            method: "DELETE",
        });
        if (!res.ok) {
            console.error("Failed to delete medicine.");
            return;
        }

        try { await renderDashboard(); } catch(e) { console.warn("Dashboard refresh failed"); }
        try { await renderReports();   } catch(e) { console.warn("Reports refresh failed"); }
        try { await refreshActivityFeed(); } catch(e) { console.warn("Activity refresh failed"); }
    } catch (err) {
        console.error(err);
    }
}

async function renderHistory() {
    if (!currentUser) return;

    const tbody = document.getElementById("history-body");
    const empty = document.getElementById("history-empty");
    if (!tbody || !empty) return;

    tbody.innerHTML = "";

    try {
        const res = await fetch(`${API_BASE}/logs/history/${currentUser.id}`);
        if (!res.ok) throw new Error("Failed to load history");
        const items = await res.json();

        logs = items;

        if (items.length === 0) {
            empty.style.display = "flex";
            return;
        }
        empty.style.display = "none";

        const takenCount = items.filter(l => (l.status || "").toLowerCase() === "taken").length;
        const missedCount = items.filter(l => (l.status || "").toLowerCase() === "missed").length;
        const pendingCount = items.filter(l => (l.status || "").toLowerCase() === "pending").length;
        const totalCount = items.length;
        const adherencePct = totalCount > 0 ? Math.round((takenCount / totalCount) * 100) : 0;

        const takenCountEl = document.getElementById("hist-taken-count");
        const missedCountEl = document.getElementById("hist-missed-count");
        const pendingCountEl = document.getElementById("hist-pending-count");
        const adherencePctEl = document.getElementById("hist-adherence-pct");

        if (takenCountEl) takenCountEl.textContent = takenCount;
        if (missedCountEl) missedCountEl.textContent = missedCount;
        if (pendingCountEl) pendingCountEl.textContent = pendingCount;
        if (adherencePctEl) adherencePctEl.textContent = adherencePct + "%";

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
            else if (statusLower === "missed")  {
                statusPill.classList.add("status-missed");
                const icon = document.createElement("span");
                icon.textContent = "⚠️";
                icon.style.marginRight = "4px";
                statusPill.insertBefore(icon, statusPill.firstChild);
            }
            else                                
            statusPill.classList.add("status-pending");
            statusPill.textContent += log.status;
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
        const res = await fetch(`${API_BASE}/logs/mark`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            console.error("Failed to save log");
        } else {
            // Recalculate streak after a dose is taken
            recalculateStreak();
        }
    } catch (err) {
        console.error(err);
    }
}

async function markDoseMissed(userId, medId, dateStr, timeStr) {
    if (!userId || !medId || !dateStr || !timeStr) return;
    try {
        await fetch(`${API_BASE}/logs/mark-missed-batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify([{ userId, medicationId: medId, date: dateStr, time: timeStr }]),
        });
        // Recalculate streak after a missed dose
        recalculateStreak();
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

async function renderReports() {
    if (!currentUser) return;

    const dashEmpty = document.getElementById("reports-empty");
    const dashCtx   = document.getElementById("weekly-chart");

    const rptCtx    = document.getElementById("weekly-chart-reports");
    const rptEmpty  = document.getElementById("reports-empty-page");

    if (!dashCtx) return;

    try {
        const res = await fetch(`${API_BASE}/logs/summary/week/${currentUser.id}`);
        if (!res.ok) throw new Error("Failed to load summary");
        const data = await res.json();

        const labels      = data.map((d) => d.date.substring(5)); // MM-DD
        const takenValues  = data.map((d) => d.takenCount  || 0);
        const missedValues = data.map((d) => d.missedCount || 0);
        const hasData = takenValues.some((v) => v > 0) || missedValues.some((v) => v > 0);

        if (dashEmpty) {
            dashEmpty.style.display = hasData ? "none" : "block";
            if (!hasData) dashEmpty.textContent = "Chart will appear after you mark some doses as taken.";
        }

        if (weeklyChart) weeklyChart.destroy();

        const chartConfig = {
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
                plugins: {
                    legend: { display: true, position: "top", labels: { boxWidth: 12, font: { size: 11 }, color: "#4a4540" } },
                },
                scales: {
                    x: { grid: { color: "rgba(0,0,0,0.05)" }, ticks: { color: "#8c8278" } },
                    y: { beginAtZero: true, ticks: { precision: 0, color: "#8c8278" }, grid: { color: "rgba(0,0,0,0.05)" } },
                },
            },
        };

        weeklyChart = new Chart(dashCtx, chartConfig);

        if (rptCtx) {
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
                    plugins: {
                        legend: { display: true, position: "top", labels: { boxWidth: 12, font: { size: 11 }, color: "#4a4540" } },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => ` ${ctx.parsed.y} dose(s) ${ctx.dataset.label.toLowerCase()}`,
                            },
                        },
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: "#8c8278" } },
                        y: { beginAtZero: true, ticks: { precision: 0, color: "#8c8278" }, grid: { color: "rgba(0,0,0,0.05)" } },
                    },
                },
            });
        }

        try {
            const statsRes = await fetch(`${API_BASE}/logs/adherence/stats/${currentUser.id}`);
            if (statsRes.ok) {
                const stats = await statsRes.json();

                const totalEl = document.getElementById("rpt-total-doses");
                const takenEl = document.getElementById("rpt-taken-doses");
                const missedEl = document.getElementById("rpt-missed-doses");
                const adherEl = document.getElementById("rpt-adherence");

                if (totalEl) totalEl.textContent = stats.totalDoses || 0;
                if (takenEl) takenEl.textContent = stats.takenDoses || 0;
                if (missedEl) missedEl.textContent = stats.missedDoses || 0;
                if (adherEl) adherEl.textContent = (stats.adherencePercentage || 0) + "%";

                const missedCard = document.getElementById("missed-doses-card");
                const missedTodayEl = document.getElementById("missed-today");
                const missedWeekEl = document.getElementById("missed-week");
                const missedMonthEl = document.getElementById("missed-month");
                const mostMissedMedEl = document.getElementById("most-missed-med");
                const mostMissedCountEl = document.getElementById("most-missed-count");
                const missedAlertBanner = document.getElementById("missed-alert-banner");
                const mdsSuccessPanel = document.getElementById("mds-success-panel");

                if (missedCard && stats.missedDoses > 0) {
                    missedCard.style.display = "block";

                    if (missedTodayEl) missedTodayEl.textContent = stats.missedToday || 0;
                    if (missedWeekEl) missedWeekEl.textContent = stats.missedThisWeek || 0;
                    if (missedMonthEl) missedMonthEl.textContent = stats.missedThisMonth || 0;

                    if (mostMissedMedEl) {
                        mostMissedMedEl.textContent = stats.mostMissedMedicine || "\u2014";
                    }
                    if (mostMissedCountEl) {
                        const count = stats.mostMissedCount || 0;
                        mostMissedCountEl.textContent = count > 0 ? `${count} time${count > 1 ? 's' : ''}` : "";
                    }

                    const adherence = stats.adherencePercentage || 0;
                    if (missedAlertBanner && mdsSuccessPanel) {
                        if (adherence < 70) {
                            missedAlertBanner.style.display = "flex";
                            mdsSuccessPanel.style.display = "none";
                            const alertTextEl = document.getElementById("missed-alert-text");
                            if (alertTextEl) {
                                if (adherence < 50) {
                                    alertTextEl.textContent = `Your adherence is critically low at ${adherence}%. Please consult your healthcare provider and enable stronger reminders.`;
                                } else {
                                    alertTextEl.textContent = `Your adherence dropped to ${adherence}%. Try enabling reminders or adjusting your medication schedule.`;
                                }
                            }
                        } else {
                            missedAlertBanner.style.display = "none";
                            mdsSuccessPanel.style.display = "flex";
                        }
                    }

                    renderMissedMiniChart(labels, missedValues);

                } else if (missedCard) {
                    missedCard.style.display = "none";
                }
            }
        } catch (statsErr) {
            console.warn("Could not load adherence stats:", statsErr);
        }

        // Render streak analytics in reports
        renderReportsStreak();

    } catch (err) {
        console.error(err);
        if (dashEmpty) { dashEmpty.style.display = "block"; dashEmpty.textContent = "Could not load weekly summary."; }
        if (rptEmpty)  { rptEmpty.style.display  = "flex"; }
    }
}

function stopReminderAudio() {
    if (activeReminderAudio) {
        activeReminderAudio.pause();
        activeReminderAudio.currentTime = 0;
        activeReminderAudio = null;
    }
}

function triggerDoseNotification(med, dateStr, displayTime) {
    if (!currentUser) return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    const key = `${currentUser.id}-${med.id}-${dateStr}-${displayTime}`;

    if (getDoseStatus(currentUser.id, med.id, dateStr, displayTime) === "TAKEN") return;
    if (lastReminderKey === key) return;

    lastReminderKey = key;

    const notification = new Notification("DoseBuddy Reminder", {
        body: `${med.name} (${med.dosage}) at ${displayTime}`,
        icon: "https://cdn-icons-png.flaticon.com/512/2966/2966327.png",
    });

    notification.onclick = () => {
        window.focus();
        switchView("dashboard-view");
        stopReminderAudio();
    };

    const audio = document.getElementById("notify-sound");
    if (audio) {
        stopReminderAudio();
        audio.currentTime = 0;
        audio.volume = 1;
        audio.loop = false;
        audio.play().catch(err => {
            console.warn("Reminder sound blocked:", err);
        });
        activeReminderAudio = audio;
    }
}

function clearScheduledTimeouts() {
    scheduledTimeouts.forEach((id) => clearTimeout(id));
    scheduledTimeouts = [];
}

function scheduleNotificationsForToday() {
    if (!currentUser) return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (!medsCache || medsCache.length === 0) return;

    clearScheduledTimeouts();

    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    if (medsCacheDate !== todayStr) return;

    const nowMs = now.getTime();

    medsCache.forEach((med) => {
        if (!Array.isArray(med.times)) return;

        med.times.forEach((timeObj) => {
            const rawTime = timeObj.timeOfDay || "";
            const displayTime = rawTime.substring(0, 5);

            const [h, m] = displayTime.split(":").map(Number);
            const doseDate = new Date(now);
            doseDate.setHours(h, m, 0, 0);

            const delayMs = doseDate.getTime() - nowMs;
            if (delayMs <= 0 || delayMs > 12 * 60 * 60 * 1000) return;

            const alreadyTaken =
                getDoseStatus(currentUser.id, med.id, todayStr, displayTime) ===
                "TAKEN";
            if (alreadyTaken) return;

            const timeoutId = setTimeout(() => {
                triggerDoseNotification(med, todayStr, displayTime);
            }, delayMs);

            scheduledTimeouts.push(timeoutId);
        });
    });
}

function checkReminders(){

    if (!currentUser) return;
    if (!medsCache || medsCache.length === 0) return;

    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];

    if (medsCacheDate !== todayStr) return;

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    let changed = false;
    const toMarkMissed = [];

    for (const med of medsCache){

        if (!Array.isArray(med.times)) continue;

        for (const timeObj of med.times){

            const rawTime = timeObj.timeOfDay || "";
            const displayTime = rawTime.substring(0,5);

            const [h,m] = displayTime.split(":").map(Number);
            const doseMinutes = h*60 + m;

            const diff = nowMinutes - doseMinutes;

            if (diff >= 0 && diff <= 1){
                triggerDoseNotification(med, todayStr, displayTime);
                changed = true;
            }

            if (diff > 5){
                const status = getDoseStatus(currentUser.id, med.id, todayStr, displayTime);
                if (status !== "TAKEN" && status !== "MISSED"){
                    toMarkMissed.push({
                        userId: currentUser.id,
                        medicationId: med.id,
                        date: todayStr,
                        time: displayTime
                    });
                    changed = true;
                }
            }
        }
    }

    if (toMarkMissed.length > 0){
        fetch(`${API_BASE}/logs/mark-missed-batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(toMarkMissed),
        })
        .then(() => {
            renderDashboard();
            renderReports();
            refreshActivityFeed();
        })
        .catch(err => console.error("checkReminders missed-batch error:", err));
    } else if (changed){
        renderDashboard();
    }
}

function scheduleMedicineReminders(){

    clearScheduledTimeouts();

    if(!medsCache || medsCache.length === 0) return;

    const now = new Date();
    const today = now.toISOString().split("T")[0];

    for(const med of medsCache){

        if(!Array.isArray(med.times)) continue;

        for(const t of med.times){

            const timeStr = (t.timeOfDay || "").substring(0,5);
            if(!timeStr) continue;

            const [h,m] = timeStr.split(":").map(Number);

            const reminderTime = new Date();
            reminderTime.setHours(h,m,0,0);

            const delay = reminderTime.getTime() - now.getTime();

            if(delay <= 0) continue;

            const timeoutId = setTimeout(()=>{
                triggerDoseNotification(med, today, timeStr);

                
                const missTimeout = setTimeout(()=>{
                    if (!currentUser) return;
                    const status = getDoseStatus(currentUser.id, med.id, today, timeStr);
                    if(status !== "TAKEN" && status !== "MISSED"){
                        markDoseMissed(currentUser.id, med.id, today, timeStr)
                            .then(() => {
                                renderDashboard();
                                renderReports();
                                refreshActivityFeed();
                            });
                    }
                }, 5 * 60 * 1000); 

                scheduledTimeouts.push(missTimeout);

            }, delay);

            scheduledTimeouts.push(timeoutId);
        }
    }
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

    if (!_aiLock()) return;

    resultBox.textContent = "Thinking with AI...";

    try {
        const res = await fetch(
            `${API_BASE}/medicine/ai-info?name=${encodeURIComponent(name)}`
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

    if (!_aiLock()) return;

    resultBox.style.display = "block";
    resultBox.textContent = "Thinking with AI...";
    setButtonLoading(submitBtn, true, "Processing...");

    try {
        const res = await fetch(
            `${API_BASE}/medicine/ai-info?name=${encodeURIComponent(query)}`
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

    if (!_aiLock()) return;

    resultBox.style.display = "block";
    resultBox.textContent = "Analyzing symptoms with AI...";
    setButtonLoading(submitBtn, true, "Analyzing...");

    try {
        const res = await fetch(`${API_BASE}/medicine/symptom-check`, {
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

        if (!_aiLock()) return;

        result.textContent = "Analyzing symptoms with AI...";

        try{

            const res = await fetch(`${API_BASE}/medicine/symptom-check`,{
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
        const response = await fetch(`${API_BASE}/bmi/calculate`, {
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
        showToast("BMI calculated successfully! 🎉", "success");

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
        const response = await fetch(`${API_BASE}/bmi/calculate`, {
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
        displayBmiResultView(data);
        displayHealthInsightsView(data);
        showToast("BMI calculated successfully! 🎉", "success");

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
        const response = await fetch(`${API_BASE}/bmi/latest/${currentUser.id}`);
        
        if (response.ok) {
            const data = await response.json();
            
            const h = document.getElementById("bmi-height");
            const w = document.getElementById("bmi-weight");
            if (h) h.value = data.height;
            if (w) w.value = data.weight;

            const hv = document.getElementById("bmi-height-view");
            const wv = document.getElementById("bmi-weight-view");
            if (hv) hv.value = data.height;
            if (wv) wv.value = data.weight;

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
    statusIcon.textContent = categoryInfo.icon;
    statusText.textContent = categoryInfo.label;
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
    statusIcon.textContent = categoryInfo.icon;
    statusText.textContent = categoryInfo.label;
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
            insightsHTML += `<li>${suggestion}</li>`;
        });
        insightsHTML += '</ul></div>';
    }
    
    if (data.dietRecommendations && data.dietRecommendations.length > 0) {
        insightsHTML += '<div class="insight-section">';
        insightsHTML += '<h4 class="insight-section-title">Diet Recommendations</h4>';
        insightsHTML += '<ul class="insight-list">';
        data.dietRecommendations.forEach(recommendation => {
            insightsHTML += `<li>${recommendation}</li>`;
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
            label: "Below Healthy Weight",
            icon: "⚠️",
            className: "status-underweight"
        },
        "NORMAL": {
            label: "Healthy Weight",
            icon: "✔",
            className: "status-normal"
        },
        "OVERWEIGHT": {
            label: "Above Healthy Weight",
            icon: "⚡",
            className: "status-overweight"
        },
        "OBESE": {
            label: "Obesity Range",
            icon: "🔴",
            className: "status-obese"
        }
    };

    return categories[category] || categories["NORMAL"];
}

function setupThemeFromStorage() {
    const stored = localStorage.getItem("theme");
    const initial = stored === "dark" ? "dark" : "light";
    applyTheme(initial);
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
    { key: "MEDICINE OVERVIEW",       icon: "💊", label: "Medicine Overview"       },
    { key: "DOSAGE INFORMATION",      icon: "📋", label: "Dosage Information"      },
    { key: "COMMON USES",             icon: "✅", label: "Common Uses"             },
    { key: "WARNINGS & PRECAUTIONS",  icon: "⚠️", label: "Warnings & Precautions" },
    { key: "SIDE EFFECTS",            icon: "🔍", label: "Side Effects"            },
    { key: "WHEN TO CONSULT A DOCTOR",icon: "🩺", label: "When to Consult a Doctor"},
];

function formatMedicineResponse(text) {
    if (!text) return "";

    // Clean markdown artifacts
    const clean = text
        .replace(/\*\*/g, "")
        .replace(/\*/g, "")
        .replace(/#{1,6}\s*/g, "");

    // Build a map of section key → content by splitting on known headings
    const sectionMap = {};
    let remainder = clean;

    // Build a regex that matches any of the section headings (with colon)
    const headingPattern = new RegExp(
        "(" + MED_SECTIONS.map(s => s.key.replace(/[&]/g, "\\&") + ":").join("|") + ")",
        "gi"
    );

    const parts = remainder.split(headingPattern);
    // parts alternates: [pre-text, heading, content, heading, content, ...]
    let lastKey = null;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part) continue;

        // Check if this part is a heading
        const matchedSection = MED_SECTIONS.find(s =>
            part.toUpperCase().startsWith(s.key)
        );
        if (matchedSection) {
            lastKey = matchedSection.key;
        } else if (lastKey) {
            sectionMap[lastKey] = (sectionMap[lastKey] || "") + part;
        }
    }

    // If no structured sections found, fall back to generic formatting
    if (Object.keys(sectionMap).length === 0) {
        return formatAiText(text);
    }

    // Render structured card
    let html = '<div class="med-response-card">';

    MED_SECTIONS.forEach(section => {
        const content = sectionMap[section.key];
        if (!content || !content.trim()) return;

        const formattedContent = content.trim()
            .replace(/\n\s*[-•]\s*/g, "\n• ")   // normalise bullet chars
            .replace(/^[-•]\s*/gm, "• ")
            .split("\n")
            .filter(line => line.trim())
            .map(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith("•")) {
                    return `<li>${escapeHtml(trimmed.slice(1).trim())}</li>`;
                }
                return `<p class="med-section-text">${escapeHtml(trimmed)}</p>`;
            })
            .join("");

        // Wrap consecutive <li> elements in a <ul>
        const wrappedContent = formattedContent
            .replace(/(<li>.*?<\/li>)+/gs, match => `<ul class="med-section-list">${match}</ul>`);

        html += `
            <div class="med-section">
                <div class="med-section-header">
                    <span class="med-section-icon">${section.icon}</span>
                    <span class="med-section-title">${section.label}</span>
                </div>
                <div class="med-section-body">${wrappedContent}</div>
            </div>`;
    });

    // Append disclaimer line if present (last sentence after all sections)
    const disclaimerMatch = clean.match(/Always consult[^.]+\./i);
    if (disclaimerMatch) {
        html += `<div class="med-response-disclaimer">${escapeHtml(disclaimerMatch[0])}</div>`;
    }

    html += "</div>";
    return html;
}

function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function formatAiText(text){

    if(!text) return "";

    return text
        .replace(/#{1,6}\s*/g,"")

        .replace(/\*\*/g,"")
        .replace(/\*/g,"")

        .replace(/^\.\s*/gm,"")
        .replace(/\n\s*\n/g,"\n")
        .replace(/Medicine Type:/g,'<div class="ai-heading">Medicine Type</div>')
        .replace(/What It Is Used For:/g,'<div class="ai-heading">What It Is Used For</div>')
        .replace(/How It Helps the Body:/g,'<div class="ai-heading">How It Helps the Body</div>')
        .replace(/General Safety Notes:/g,'<div class="ai-heading">General Safety Notes</div>')
        .replace(/Possible Causes:/g,'<div class="ai-heading">Possible Causes</div>')
        .replace(/What the Person Can Do:/g,'<div class="ai-heading">What You Can Do</div>')
        .replace(/When to See a Doctor:/g,'<div class="ai-heading">When to See a Doctor</div>')

        .replace(/^- /gm,"• ")
        .replace(/\n/g,"<br>");
}

function setupPrescriptionUpload() {
    const fileInput   = document.getElementById("prescription-file-input");
    const browseBtn   = document.getElementById("prescription-browse-btn");
    const dropZone    = document.getElementById("prescription-drop-zone");
    const fileNameEl  = document.getElementById("prescription-file-name");
    const autofillBtn = document.getElementById("prescription-autofill-btn");
    const errorEl     = document.getElementById("prescription-error");
    const infoEl      = document.getElementById("prescription-info");

    if (!fileInput || !browseBtn || !dropZone || !autofillBtn) {
        console.warn("[Prescription] Setup skipped — elements not found in DOM.");
        return;
    }

    let selectedFile = null;

    browseBtn.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files[0]) setFile(fileInput.files[0]);
    });

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        const file = e.dataTransfer.files[0];
        if (file) setFile(file);
    });

    function setFile(file) {
        selectedFile = file;
        fileNameEl.textContent = `Selected: ${file.name}`;
        errorEl.textContent = "";
        infoEl.textContent = "";
        infoEl.style.color = "";
    }

    autofillBtn.addEventListener("click", async () => {
        errorEl.textContent = "";
        infoEl.textContent  = "";
        infoEl.style.color  = "";

        if (!selectedFile) {
            errorEl.textContent = "Please select a prescription file first.";
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

        autofillBtn.textContent = "Processing...";
        autofillBtn.disabled    = true;
        autofillBtn.classList.add("btn-loading");

        try {
            const formData = new FormData();
            formData.append("file", selectedFile);

            const uploadRes = await fetch(`${API_BASE}/prescription/upload`, {
                method: "POST",
                body:   formData
            });


            if (!uploadRes.ok) {
                const errData = await uploadRes.json().catch(() => ({}));
                errorEl.textContent = errData.message || "Failed to parse prescription.";
                return;
            }

            const responseData = await uploadRes.json();

            const medicines    = responseData.medicines   || responseData; 
            const parseQuality = responseData.parseQuality || "";

            if (!Array.isArray(medicines)) {
                errorEl.textContent = "Unexpected response from server. Please try again.";
                return;
            }

            if (medicines.length === 0) {
                infoEl.style.color = "#b45309";
                infoEl.textContent = "No medicines could be detected. Try a clearer image or check the file format.";
                return;
            }


            fillMedicineForm(medicines[0]);

            const todayStr = new Date().toISOString().split("T")[0];
            const endDate  = new Date();
            endDate.setDate(endDate.getDate() + 30);
            const endDateStr = endDate.toISOString().split("T")[0];

            let savedCount = 0;
            let failCount  = 0;

            for (const med of medicines) {
                const name   = (med.medicineName || "").trim();
                const dosage = (med.dosage || "").trim();

                if (!name) {
                    console.warn("[Prescription] Skipping entry with no medicineName:", med);
                    failCount++;
                    continue;
                }

                const times = Array.isArray(med.times) && med.times.length > 0
                    ? med.times.slice(0, 4).map(normalizeTime).filter(t => /^\d{2}:\d{2}$/.test(t))
                    : ["08:00"];

                const payload = {
                    userId:       currentUser.id,
                    name,
                    dosage:       dosage || "As prescribed",
                    instructions: (med.instructions || "").trim(),
                    startDate:    todayStr,
                    endDate:      endDateStr,
                    times
                };


                try {
                    const saveRes = await fetch(`${API_BASE}/medications/add`, {
                        method:  "POST",
                        headers: { "Content-Type": "application/json" },
                        body:    JSON.stringify(payload)
                    });


                    if (saveRes.ok) {
                        savedCount++;
                    } else {
                        const saveErr = await saveRes.text().catch(() => "");
                        console.error("[Prescription] Save failed for", name, ":", saveErr);
                        failCount++;
                    }
                } catch (saveEx) {
                    console.error("[Prescription] Network error saving", name, ":", saveEx);
                    failCount++;
                }
            }

            if (savedCount > 0) {
                infoEl.style.color = "#15803d";
                infoEl.textContent = savedCount === 1
                    ? "1 medicine saved from prescription."
                    : `${savedCount} medicines saved from prescription.`;
                if (failCount > 0) infoEl.textContent += ` (${failCount} could not be saved.)`;
                showToast(infoEl.textContent, "success");
            } else {
                infoEl.style.color = "#b91c1c";
                infoEl.textContent = "Medicines were detected but could not be saved. Please try again.";
            }

            if (savedCount > 0) {
                try { await renderDashboard();     } catch(e) { console.warn("Dashboard refresh failed"); }
                try { await renderReports();       } catch(e) { console.warn("Reports refresh failed"); }
                try { await refreshActivityFeed(); } catch(e) { console.warn("Activity refresh failed"); }
            }

        } catch (err) {
            console.error("[Prescription] Unexpected error:", err);
            errorEl.textContent = "Error: " + err.message;
        } finally {
            autofillBtn.textContent = "Auto Fill from Prescription";
            autofillBtn.disabled    = false;
            autofillBtn.classList.remove("btn-loading");
        }
    });

    function fillMedicineForm(result) {
        const nameEl  = document.getElementById("med-name");
        const doseEl  = document.getElementById("med-dosage");
        const instrEl = document.getElementById("med-instructions");

        if (nameEl)  nameEl.value  = result.medicineName  || "";
        if (doseEl)  doseEl.value  = result.dosage        || "";
        if (instrEl) instrEl.value = result.instructions  || "";

        const timeIds = ["time-1", "time-2", "time-3"];
        timeIds.forEach((id, i) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = (Array.isArray(result.times) && result.times[i])
                ? normalizeTime(result.times[i])
                : "";
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

function openModal(id) {
    const modal    = document.getElementById(id);
    const backdrop = document.getElementById("modal-backdrop");
    if (!modal || !backdrop) return;
    backdrop.classList.add("backdrop-visible");
    modal.classList.add("modal-open");
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
}

function closeAllModals() {
    document.querySelectorAll(".modal.modal-open").forEach(m => m.classList.remove("modal-open"));
    const backdrop = document.getElementById("modal-backdrop");
    if (backdrop) backdrop.classList.remove("backdrop-visible");
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
    currentUser = null;
    saveToLS(LS_CURRENT_USER_KEY, null);
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

async function openProfileSettingsModal() {
    if (!currentUser || !currentUser.id) {
        showToast("Please log in first.", "error");
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/user/profile/${currentUser.id}`);
        if (!res.ok) throw new Error("Failed to fetch profile");
        const profile = await res.json();

        currentUser = { ...currentUser, ...profile };
        saveToLS(LS_CURRENT_USER_KEY, currentUser);

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
            "ps-dob":       profile.dob             || "",
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

        openModal("modal-profile");
    } catch (err) {
        console.error("Error fetching profile:", err);
        showToast("Failed to load profile data.", "error");
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
            dob:              document.getElementById("ps-dob")?.value               || "",
            gender:           document.getElementById("ps-gender")?.value            || "",
            emergencyContact: document.getElementById("ps-emergency")?.value.trim()  || ""
        };

        const saveBtn = document.getElementById("ps-save-btn");
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving..."; }

        try {
            const res = await fetch(`${API_BASE}/user/profile/${currentUser.id}`, {
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
        "missed-alerts": true,
        "daily-summary": false,
        "sound-alerts": true,
        "email-notifs": false,
    });

    document.querySelectorAll(".toggle-switch[data-pref]").forEach(btn => {
        const pref = btn.dataset.pref;
        const on   = saved[pref] !== undefined ? saved[pref] : btn.classList.contains("active");
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-checked", String(on));
    });

    openModal("modal-notif");
}

document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".toggle-switch[data-pref]").forEach(btn => {
        btn.addEventListener("click", () => {
            const isOn = btn.classList.toggle("active");
            btn.setAttribute("aria-checked", String(isOn));
        });
    });

    document.getElementById("notif-save-btn")?.addEventListener("click", () => {
        const prefs = {};
        document.querySelectorAll(".toggle-switch[data-pref]").forEach(btn => {
            prefs[btn.dataset.pref] = btn.classList.contains("active");
        });
        saveToLS(NOTIF_PREFS_KEY, prefs);
        closeModal("modal-notif");
        showToast("Notification preferences saved!", "success");
    });
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
        btn.addEventListener("click", () => {
            const input = document.getElementById(btn.dataset.target);
            if (!input) return;
            input.type = input.type === "password" ? "text" : "password";
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
            const res = await fetch(`${API_BASE}/user/change-password/${currentUser.id}`, {
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

const NOTIF_ICONS = {
    missed:      { emoji: "⏰", color: "notif-icon-orange" },
    reminder:    { emoji: "💊", color: "notif-icon-blue"   },
    adherence:   { emoji: "🏆", color: "notif-icon-green"  },
    ai:          { emoji: "🤖", color: "notif-icon-purple" },
    info:        { emoji: "ℹ️",  color: "notif-icon-blue"   },
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
            <div class="notif-item-icon ${icon.color}">${icon.emoji}</div>
            <div class="notif-item-body">
                <p class="notif-item-title">${item.title}</p>
                <p class="notif-item-desc">${item.desc}</p>
                <span class="notif-item-time">${timeAgo(item.ts)}</span>
            </div>
            ${item.unread ? '<span class="notif-item-dot"></span>' : ""}
        `;
        div.addEventListener("click", () => {
            item.unread = false;
            div.classList.remove("notif-item-unread");
            div.querySelector(".notif-item-dot")?.remove();
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
    notifStore.unshift({ id: `${type}-${Date.now()}`, type, title, desc, unread: true, ts: Date.now() });
    notifStore = notifStore.slice(0, 20);
    refreshNotifBadge();
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("notif-mark-all-btn")?.addEventListener("click", () => {
        notifStore.forEach(n => n.unread = false);
        renderNotificationPanel();
        refreshNotifBadge();
    });

    document.getElementById("notif-clear-btn")?.addEventListener("click", () => {
        notifStore = [];
        renderNotificationPanel();
        refreshNotifBadge();
    });
});


const ONBOARDING_KEY = "dosebuddy_onboarding_done";

const ONBOARDING_STEPS = [
    {
        title:  "Welcome to DoseBuddy 👋",
        desc:   "Your personal medicine reminder and health companion. Let us show you around in a few quick steps.",
        target: null,
        pos:    "center",
    },
    {
        title:  "Sidebar Navigation 🗂️",
        desc:   "Use the sidebar to switch between Dashboard, Add Medicine, Reports, History, and AI tools.",
        target: "#user-menu",
        pos:    "right",
    },
    {
        title:  "Add Your Medicines 💊",
        desc:   "Click Add Medicine to set up your medication schedule. You can also upload a prescription to auto-fill.",
        target: "[data-view='add-medicine-view']",
        pos:    "right",
    },
    {
        title:  "Notification Bell 🔔",
        desc:   "Click the bell to see missed doses, reminders, and health tips. The badge shows unread count.",
        target: "#notification-bell",
        pos:    "bottom",
    },
    {
        title:  "Your Profile 👤",
        desc:   "Click your avatar to access Profile Settings, Notification Preferences, Help, and Security.",
        target: "#nav-user-avatar",
        pos:    "bottom",
    },
    {
        title:  "Dark Mode 🌙",
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
    nextBtn.textContent = step === ONBOARDING_STEPS.length - 1 ? "Finish ✔" : "Next →";

    overlay.style.display  = "block";
    tooltip.style.display  = "block";

    if (data.target) {
        const el = document.querySelector(data.target);
        if (el) {
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
    tooltip.style.transform = "translate(-50%, -50%)";

    if (!data.target) return;

    const el = document.querySelector(data.target);
    if (!el) return;

    const r   = el.getBoundingClientRect();
    const tw  = 280;
    const th  = 160;
    const gap = 14;

    if (data.pos === "right") {
        tooltip.style.top       = `${Math.min(r.top, window.innerHeight - th - 20)}px`;
        tooltip.style.left      = `${r.right + gap}px`;
        tooltip.style.transform = "none";
    } else if (data.pos === "bottom") {
        tooltip.style.top       = `${r.bottom + gap}px`;
        tooltip.style.left      = `${Math.max(8, r.left + r.width / 2 - tw / 2)}px`;
        tooltip.style.transform = "none";
    }
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
        const res = await fetch(`${API_BASE}/vitals/latest/${currentUser.id}`);
        if (!res.ok) { clearVitalsSummaryCards(); return; }
        const data = await res.json();
        renderVitalsSummaryCards(data);
        checkVitalsAlerts(data);
    } catch (e) {
        clearVitalsSummaryCards();
    }
}

async function loadVitalsHistory() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/vitals/history/${currentUser.id}`);
        if (!res.ok) { renderVitalsTable([]); return; }
        const data = await res.json();
        renderVitalsTable(data);
        renderVitalsInsights(data);
    } catch (e) {
        renderVitalsTable([]);
    }
}

async function loadVitalsTrend(period) {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/vitals/trend/${currentUser.id}?period=${period}`);
        if (!res.ok) { renderVitalsCharts([]); return; }
        const data = await res.json();
        renderVitalsCharts(data);
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
        const res = await fetch(`${API_BASE}/vitals/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const err = await res.json();
            document.getElementById("vf-general-err").textContent = err.message || "Failed to save vitals.";
            return;
        }
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
    if (d.bpStatus === "HIGH_STAGE2") alerts.push("⚠️ Blood pressure is critically high — consult a doctor.");
    else if (d.bpStatus === "HIGH_STAGE1") alerts.push("⚠️ Blood pressure is elevated.");
    if (d.bpStatus === "LOW") alerts.push("⚠️ Blood pressure is low.");
    if (d.sugarStatus === "HIGH") alerts.push("⚠️ Blood sugar is high.");
    if (d.sugarStatus === "LOW")  alerts.push("⚠️ Blood sugar is low — risk of hypoglycemia.");
    if (d.tempStatus === "FEVER") alerts.push("🌡️ Fever detected — temperature above 38.5°C.");
    if (d.heartRateStatus === "HIGH") alerts.push("💓 Heart rate is elevated.");
    if (d.heartRateStatus === "LOW")  alerts.push("💓 Heart rate is low (bradycardia).");

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
        const res = await fetch(`${API_BASE}/vitals/${id}`, { method: "DELETE" });
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
        container.innerHTML = '<p class="empty-state"><span class="empty-icon">💡</span> Log vitals to see personalized health insights.</p>';
        return;
    }

    const insights = generateVitalsInsights(records);
    if (insights.length === 0) {
        container.innerHTML = '<p class="empty-state"><span class="empty-icon">✅</span> All vitals look normal. Keep it up!</p>';
        return;
    }

    container.innerHTML = insights.map(i =>
        `<div class="vitals-insight-item insight-${i.type}">
            <span class="vitals-insight-icon">${i.icon}</span>
            <span class="vitals-insight-text">${i.text}</span>
        </div>`
    ).join("");
}

function generateVitalsInsights(records) {
    const insights = [];
    const recent7 = records.slice(0, Math.min(records.length, 7));

    const bpRecords = recent7.filter(r => r.bpSystolic != null && r.bpDiastolic != null);
    if (bpRecords.length > 0) {
        const avgSys = bpRecords.reduce((s, r) => s + r.bpSystolic, 0) / bpRecords.length;
        const avgDia = bpRecords.reduce((s, r) => s + r.bpDiastolic, 0) / bpRecords.length;
        if (avgSys >= 140 || avgDia >= 90) {
            insights.push({ type: "alert", icon: "⚠️", text: `Blood pressure has been consistently high this week (avg ${Math.round(avgSys)}/${Math.round(avgDia)} mmHg). Consider consulting a doctor.` });
        } else if (avgSys >= 130) {
            insights.push({ type: "warning", icon: "📈", text: `BP slightly elevated this week (avg ${Math.round(avgSys)}/${Math.round(avgDia)} mmHg). Monitor closely.` });
        } else if (avgSys < 90) {
            insights.push({ type: "warning", icon: "📉", text: `Blood pressure appears low this week. Stay hydrated and consult a doctor if symptoms persist.` });
        } else {
            insights.push({ type: "good", icon: "✅", text: `Blood pressure is within normal range this week (avg ${Math.round(avgSys)}/${Math.round(avgDia)} mmHg).` });
        }
    }

    const sugarRecords = recent7.filter(r => r.bloodSugar != null);
    if (sugarRecords.length >= 2) {
        const avgSugar = sugarRecords.reduce((s, r) => s + r.bloodSugar, 0) / sugarRecords.length;
        const maxSugar = Math.max(...sugarRecords.map(r => r.bloodSugar));
        const minSugar = Math.min(...sugarRecords.map(r => r.bloodSugar));
        const fluctuation = maxSugar - minSugar;
        if (avgSugar > 200) {
            insights.push({ type: "alert", icon: "🩸", text: `Blood sugar is consistently high (avg ${Math.round(avgSugar)} mg/dL). Seek medical advice.` });
        } else if (fluctuation > 80) {
            insights.push({ type: "warning", icon: "📊", text: `Sugar levels fluctuating frequently (range: ${Math.round(minSugar)}–${Math.round(maxSugar)} mg/dL). Maintain consistent meal timing.` });
        } else if (avgSugar < 70) {
            insights.push({ type: "alert", icon: "⚡", text: `Blood sugar is low on average (${Math.round(avgSugar)} mg/dL). Risk of hypoglycemia — consult your doctor.` });
        } else {
            insights.push({ type: "good", icon: "✅", text: `Blood sugar levels are stable this week (avg ${Math.round(avgSugar)} mg/dL).` });
        }
    }

    const weightRecords = records.filter(r => r.weight != null).slice(0, 7);
    if (weightRecords.length >= 2) {
        const first = weightRecords[weightRecords.length - 1].weight;
        const last  = weightRecords[0].weight;
        const diff  = Math.abs(last - first);
        if (diff < 0.5) {
            insights.push({ type: "info", icon: "⚖️", text: `Weight stable over last ${weightRecords.length} readings (${last} kg).` });
        } else if (last > first) {
            insights.push({ type: "info", icon: "📈", text: `Weight increased by ${diff.toFixed(1)} kg over recent readings.` });
        } else {
            insights.push({ type: "info", icon: "📉", text: `Weight decreased by ${diff.toFixed(1)} kg over recent readings.` });
        }
    }

    const hrRecords = recent7.filter(r => r.heartRate != null);
    if (hrRecords.length > 0) {
        const avgHr = hrRecords.reduce((s, r) => s + r.heartRate, 0) / hrRecords.length;
        if (avgHr > 100) {
            insights.push({ type: "warning", icon: "💓", text: `Heart rate elevated this week (avg ${Math.round(avgHr)} bpm). Consider reducing stress and caffeine.` });
        } else if (avgHr < 55) {
            insights.push({ type: "info", icon: "💓", text: `Resting heart rate is low (avg ${Math.round(avgHr)} bpm). This may be normal for athletes.` });
        }
    }

    const tempRecords = recent7.filter(r => r.temperature != null);
    if (tempRecords.length > 0) {
        const maxTemp = Math.max(...tempRecords.map(r => r.temperature));
        if (maxTemp > 38.5) {
            insights.push({ type: "alert", icon: "🌡️", text: `Fever recorded (${maxTemp}°C). Rest, stay hydrated, and consult a doctor if it persists.` });
        } else if (maxTemp > 37.5) {
            insights.push({ type: "warning", icon: "🌡️", text: `Slightly elevated temperature recorded (${maxTemp}°C). Monitor closely.` });
        }
    }

    return insights;
}

async function renderStreakPanel() {
    if (!currentUser) return;

    try {
        const res = await fetch(`${API_BASE}/streaks/${currentUser.id}`);
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
        const res = await fetch(`${API_BASE}/streaks/recalculate/${currentUser.id}`, {
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
            showToast(`🔥 ${streak}-day streak! Keep it up!`, "success", 4000);
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
        if (currentStreak === 0)       fireEl.textContent = "💊";
        else if (currentStreak < 3)    fireEl.textContent = "🔥";
        else if (currentStreak < 7)    fireEl.textContent = "🔥";
        else if (currentStreak < 30)   fireEl.textContent = "⚡";
        else                           fireEl.textContent = "🏆";
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
    pct.textContent = progress >= 100 ? "✓" : progress + "%";
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
                ${!badge.unlocked ? '<span class="badge-lock-icon">🔒</span>' : ""}
                <span class="badge-emoji">${badge.icon}</span>
                <span class="badge-title">${badge.title}</span>
                <span class="badge-desc">${badge.description}</span>
            </div>`;
    }).join("");
}


async function renderReportsStreak() {
    if (!currentUser) return;

    try {
        const res = await fetch(`${API_BASE}/streaks/recalculate/${currentUser.id}`, {
            method: "POST"
        });
        if (!res.ok) return;
        const data = await res.json();

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
    } catch (err) {
        console.warn("Reports streak load failed:", err);
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

function filterByPeriod(items, period, dateField) {
    if (period === "all") return items;
    const days = parseInt(period, 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);
    return items.filter(item => {
        const d = new Date(item[dateField]);
        return d >= cutoff;
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


async function exportReportsPDF() {
    if (!currentUser) { showToast("Please log in first", "error"); return; }
    const btn = document.getElementById("export-reports-pdf");
    const restore = setExportLoading(btn, "Generating…");

    try {
        const period = document.getElementById("reports-export-period")?.value || "all";
        const now = new Date();

        const [histRes, statsRes, bmiRes, vitalsRes, streakRes] = await Promise.all([
            fetch(`${API_BASE}/logs/history/${currentUser.id}`),
            fetch(`${API_BASE}/logs/adherence/stats/${currentUser.id}`),
            fetch(`${API_BASE}/bmi/latest/${currentUser.id}`),
            fetch(`${API_BASE}/vitals/history/${currentUser.id}`),
            fetch(`${API_BASE}/streaks/${currentUser.id}`)
        ]);

        const history  = histRes.ok  ? await histRes.json()  : [];
        const stats    = statsRes.ok ? await statsRes.json() : {};
        const bmi      = bmiRes.ok   ? await bmiRes.json()   : null;
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
        const res = await fetch(`${API_BASE}/logs/history/${currentUser.id}`);
        if (!res.ok) throw new Error("Failed to fetch history");
        const history = await res.json();
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

        const taken   = history.filter(l => l.status === "TAKEN").length;
        const missed  = history.filter(l => l.status === "MISSED").length;
        const total   = history.length;
        const adh     = total > 0 ? Math.round((taken / total) * 100) : 0;

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
        const [vitalsRes, bmiRes] = await Promise.all([
            fetch(`${API_BASE}/vitals/history/${currentUser.id}`),
            fetch(`${API_BASE}/bmi/latest/${currentUser.id}`)
        ]);
        const vitals = vitalsRes.ok ? await vitalsRes.json() : [];
        const bmi    = bmiRes.ok   ? await bmiRes.json()    : null;
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
