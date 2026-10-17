import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function appSource(): Promise<string> {
  return readFile(new URL("../DoseBuddy_frontend/app.js", import.meta.url), "utf8");
}

function sliceFn(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected to find ${signature}`);
  // Walk braces from the first '{' after the signature to find the function body end.
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces for ${signature}`);
}

// Build a sandbox with the three sound functions wired to injected mocks.
async function loadSoundFns(opts: { soundPref?: boolean; playImpl?: () => any } = {}) {
  const source = await appSource();
  const playReminderSound = sliceFn(source, "function playReminderSound(");
  const playNotifSound = sliceFn(source, "function _playNotifSound(");
  const playMissedDoseAlert = sliceFn(source, "function playMissedDoseAlert(");

  const logs: string[] = [];
  const play = opts.playImpl || (() => Promise.resolve());
  const audioEl: any = {
    play: () => { playCalls.count++; return play(); },
    currentTime: 0, volume: 0, muted: false, loop: false
  };
  const playCalls = { count: 0 };
  const sandbox = {
    loadFromLS: (_k: string, def: any) => ({ ...def, "sound-alerts": opts.soundPref !== false }),
    NOTIF_PREFS_KEY: "notif",
    stopReminderAudio: () => {},
    document: { getElementById: (id: string) => (id === "notify-sound" ? audioEl : null) },
    console: { log: (m: string) => logs.push(String(m)), warn: (m: string) => logs.push(String(m)) },
    activeReminderAudio: null as any,
    audioUnlocked: false
  };
  const factory = new Function(
    "loadFromLS", "NOTIF_PREFS_KEY", "stopReminderAudio", "document", "console",
    `let activeReminderAudio = null; let audioUnlocked = false;
     ${playReminderSound}\n${playNotifSound}\n${playMissedDoseAlert}
     return { playReminderSound, _playNotifSound, playMissedDoseAlert };`
  );
  const fns = factory(sandbox.loadFromLS, sandbox.NOTIF_PREFS_KEY, sandbox.stopReminderAudio, sandbox.document, sandbox.console);
  return { fns, playCalls, logs };
}

test("all reminder sound paths reference the single original asset notify-sound.mp3", async () => {
  const source = await appSource();
  // The single <audio> asset id is used by the shared player.
  assert.ok(source.includes('getElementById("notify-sound")'), "shared player resolves #notify-sound");
  // No synthesized tone remains anywhere.
  assert.ok(!source.includes("_playAlertTone"), "_playAlertTone must be removed and referenced nowhere");
  assert.ok(!source.includes("Tries Web Audio tone first"), "stale tone-first comment must be gone");
  // The missed and test entry points delegate to the one shared player.
  const missed = sliceFn(source, "function playMissedDoseAlert(");
  const notif = sliceFn(source, "function _playNotifSound(");
  assert.ok(/playReminderSound\(/.test(missed), "playMissedDoseAlert delegates to playReminderSound");
  assert.ok(/playReminderSound\(/.test(notif), "_playNotifSound delegates to playReminderSound");
  // The Enable-sound button plays the mp3 (not a tone).
  assert.ok(source.includes('playReminderSound("Enable sound")'), "Enable-sound button uses the shared mp3 player");
});

test("foreground dose sound plays whenever a tab is open (not gated on subscription)", async () => {
  const source = await appSource();
  // The page plays the single reminder asset whenever a DoseBuddy tab is open, even
  // for push-subscribed users, because desktop OS notification sounds are unreliable.
  // The old `if (!hasActivePushSubscription)` sound gate must be gone from every
  // foreground dose path so the MP3 is the dependable in-tab alert.
  const soundGateCount = (source.match(/if \(!hasActivePushSubscription\) \{/g) || []).length;
  assert.equal(soundGateCount, 0,
    "no foreground dose sound path is gated on !hasActivePushSubscription anymore");
  // The reminder fire still plays through the one shared player.
  const trigger = sliceFn(source, "function triggerDoseNotification(");
  assert.ok(/playReminderSound\(\);/.test(trigger),
    "triggerDoseNotification plays the shared reminder sound");
  // The explicit settings button still plays on user action.
  assert.ok(source.includes('playReminderSound("Enable sound")'), "Enable-sound button plays unconditionally");
  // In-tab de-duplication still prevents the SAME dose from re-firing its sound:
  // the fired-key guard remains the mechanism, not the subscription flag.
  assert.ok(source.includes("firedReminderKeys"), "in-tab fired-key guard still present");
});

test("a single reminder fire plays the mp3 exactly once", async () => {
  const { fns, playCalls } = await loadSoundFns();
  fns.playReminderSound();
  assert.equal(playCalls.count, 1);
});

test("a single missed-dose alert plays the mp3 exactly once", async () => {
  const { fns, playCalls } = await loadSoundFns();
  fns.playMissedDoseAlert();
  assert.equal(playCalls.count, 1);
});

test("test-sound entry point routes through the one shared player", async () => {
  const { fns, playCalls } = await loadSoundFns();
  fns._playNotifSound("Test sound");
  assert.equal(playCalls.count, 1);
});

test("sound alerts disabled preference suppresses playback", async () => {
  const { fns, playCalls } = await loadSoundFns({ soundPref: false });
  fns.playReminderSound();
  fns.playMissedDoseAlert();
  assert.equal(playCalls.count, 0);
});

test("blocked audio (NotAllowedError) does not throw from the shared player", async () => {
  const { fns, playCalls } = await loadSoundFns({
    playImpl: () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }))
  });
  let threw = false;
  let result: any;
  try { result = fns.playReminderSound(); } catch { threw = true; }
  // Let the rejected play() microtask settle; the .catch inside must swallow it.
  await new Promise(r => setTimeout(r, 0));
  assert.equal(threw, false, "a blocked play() must never throw to the caller");
  assert.equal(result, true, "the player returns truthy having started the attempt");
  assert.equal(playCalls.count, 1);
});
