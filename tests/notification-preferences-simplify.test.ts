import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");

test("Notification Preferences modal UI is simplified with only two test actions", async () => {
  const html = await source("DoseBuddy_frontend/index.html");

  // Section title must be "Test Notifications"
  assert.ok(html.includes("Test Notifications"), "Must have section label 'Test Notifications'");

  // The 3 removed options must NOT appear in the test list
  assert.doesNotMatch(html, /<p class="pref-title">\s*Enable Reminder Sounds\s*<\/p>/);
  assert.doesNotMatch(html, /id="notif-enable-sound-btn"/);
  assert.doesNotMatch(html, /<p class="pref-title">\s*Test Background Push\s*<\/p>/);
  assert.doesNotMatch(html, /id="notif-test-push-btn"/);
  assert.doesNotMatch(html, /Test Local<\/button>/);

  // Exactly two test actions must be present
  assert.ok(html.includes('id="notif-test-sound-btn"'), "Test Sound button must exist");
  assert.ok(html.includes('id="notif-test-notification-btn"'), "Test Browser Notification button must exist");
  assert.ok(html.includes('id="notif-test-sound-result"'), "Test sound result container must exist");
  assert.ok(html.includes('id="notif-test-notification-result"'), "Test notification result container must exist");

  // Preserved channels and save buttons
  assert.ok(html.includes('data-pref="sound-alerts"'), "Sound Alerts toggle must be preserved");
  assert.ok(html.includes('id="notif-save-btn"'), "Save Preferences button must be preserved");
});

test("Test Sound respects the Sound Alerts toggle and plays reminder sound", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  // Verify Test Sound logic checks sound-alerts toggle & stored pref
  const soundHandlerStart = app.indexOf('document.getElementById("notif-test-sound-btn")');
  assert.ok(soundHandlerStart > 0, "Test sound click listener must exist");

  const soundHandler = app.slice(soundHandlerStart, soundHandlerStart + 1800);
  assert.ok(soundHandler.includes('data-pref="sound-alerts"'), "Must check sound-alerts toggle state");
  assert.ok(soundHandler.includes("primeAudioElement()"), "Must prime audio element on user gesture");
  assert.ok(soundHandler.includes('_playNotifSound("Test sound")') || soundHandler.includes('playReminderSound("Test sound")'), "Must play reminder sound");
  assert.ok(soundHandler.includes("Sound alerts are turned off"), "Must report disabled sound alerts");
});

test("Test Browser Notification requests permission if needed, explains unblock on denied, handles unsupported", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  const notifHandlerStart = app.indexOf('const testNotifBtn = document.getElementById("notif-test-notification-btn")');
  assert.ok(notifHandlerStart > 0, "Test browser notification click listener must exist");

  const notifHandler = app.slice(notifHandlerStart, notifHandlerStart + 3500);

  // 1. Unsupported browser check
  assert.ok(notifHandler.includes('!("Notification" in window)'), "Must check if Notification is supported");
  assert.ok(notifHandler.includes("Browser notifications are not supported in this browser"), "Must handle unsupported browser gracefully");

  // 2. Denied permission instructions
  assert.ok(notifHandler.includes('perm === "denied"') || notifHandler.includes('Notification.permission === "denied"'), "Must check for denied permission");
  assert.ok(notifHandler.includes("browser's address bar"), "Must explain how to enable notifications in browser settings");

  // 3. Permission request if not granted
  assert.ok(notifHandler.includes("Notification.requestPermission()"), "Must request permission if not yet granted");

  // 4. Real browser notification via showDoseBuddySystemNotification
  assert.ok(notifHandler.includes("showDoseBuddySystemNotification("), "Must send real test notification");
});

test("Notification preferences save and restore intact without breaking reminders or push", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  // Preferences save logic
  assert.match(app, /saveToLS\(NOTIF_PREFS_KEY,\s*prefs\)/);
  assert.match(app, /loadFromLS\(NOTIF_PREFS_KEY,/);

  // Scheduled reminder triggers still intact
  assert.match(app, /function scheduleMedicineReminders\s*\(/);
  assert.match(app, /function triggerDoseNotification\s*\(/);
  assert.match(app, /function playReminderSound\s*\(/);
  assert.match(app, /function enableDoseBuddyPush\s*\(/);
});

test("Modal styles support responsive layout and styled result containers", async () => {
  const css = await source("DoseBuddy_frontend/style.css");

  assert.ok(css.includes(".notif-test-result-msg"), ".notif-test-result-msg class must be styled");
  assert.ok(css.includes("body.dark-mode .notif-test-result-msg"), "Dark mode must style test result message");
});
