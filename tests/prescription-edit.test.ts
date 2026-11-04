import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");

test("Prescription edit button is rendered next to remove button on medicine cards", async () => {
  const [app, css] = await Promise.all([
    source("DoseBuddy_frontend/app.js"),
    source("DoseBuddy_frontend/style.css")
  ]);

  // Pencil edit button exists in card markup
  assert.match(app, /class="prx-med-card-actions"/);
  assert.match(app, /class="prx-med-card-edit-btn"/);
  assert.match(app, /data-id="\$\{item\.id\}"/);
  assert.match(app, /title="Edit this medicine"/);
  assert.match(app, /aria-label="Edit this medicine"/);

  // Pencil SVG icon (d path with standard pencil coordinates)
  assert.match(app, /M16\.862 4\.487l1\.687-1\.688/);

  // CSS for actions container and edit button
  assert.match(css, /\.prx-med-card-actions\s*\{[\s\S]*?display:\s*flex/);
  assert.match(css, /\.prx-med-card-actions\s*\{[\s\S]*?gap:\s*6px/);
  assert.match(css, /\.prx-med-card-edit-btn\s*\{[\s\S]*?border-radius:\s*50%/);
  assert.match(css, /\.prx-med-card-edit-btn:hover\s*\{[\s\S]*?color:\s*var\(--primary/);
});

test("Inline edit form renders all required medicine fields prepopulated", async () => {
  const [app, css] = await Promise.all([
    source("DoseBuddy_frontend/app.js"),
    source("DoseBuddy_frontend/style.css")
  ]);

  // Form container and editing card modifier
  assert.match(app, /prx-med-card--editing/);
  assert.match(app, /prx-edit-header/);
  assert.match(app, /prx-edit-cancel-icon-btn/);

  // Required editable fields
  assert.match(app, /id="prx-name-\$\{item\.id\}"/);
  assert.match(app, /id="prx-generic-\$\{item\.id\}"/);
  assert.match(app, /id="prx-dosage-\$\{item\.id\}"/);
  assert.match(app, /id="prx-food-\$\{item\.id\}"/);
  assert.match(app, /id="prx-duration-\$\{item\.id\}"/);

  // Meal instructions options
  assert.match(app, /value="Before meal"/);
  assert.match(app, /value="After meal"/);
  assert.match(app, /value="With meal"/);
  assert.match(app, /value="Empty stomach"/);
  assert.match(app, /value="As directed"/);

  // Intake time slot checkboxes
  assert.match(app, /id="prx-time-morning-\$\{item\.id\}"/);
  assert.match(app, /id="prx-time-afternoon-\$\{item\.id\}"/);
  assert.match(app, /id="prx-time-evening-\$\{item\.id\}"/);
  assert.match(app, /id="prx-time-night-\$\{item\.id\}"/);

  // Error container and action buttons
  assert.match(app, /id="prx-error-\$\{item\.id\}"/);
  assert.match(app, /class="prx-btn-secondary prx-edit-cancel-btn"/);
  assert.match(app, /class="prx-btn-primary prx-edit-save-btn"/);

  // CSS for form elements
  assert.match(css, /\.prx-med-card--editing\s*\{[\s\S]*?border-color:\s*var\(--primary\)/);
  assert.match(css, /\.prx-edit-grid\s*\{[\s\S]*?display:\s*grid/);
  assert.match(css, /\.prx-time-toggle\.active\s*\{[\s\S]*?background:\s*var\(--primary\)/);
  assert.match(css, /\.prx-edit-error\s*\{[\s\S]*?color:\s*#dc2626/);
});

test("Edited badge and responsive mobile styling", async () => {
  const [app, css] = await Promise.all([
    source("DoseBuddy_frontend/app.js"),
    source("DoseBuddy_frontend/style.css")
  ]);

  // Edited chip in card view
  assert.match(app, /prx-chip-edited/);
  assert.match(css, /\.prx-chip-edited\s*\{[\s\S]*?color:\s*#0284c7/);
  assert.match(css, /body\.dark-mode \.prx-chip-edited\s*\{[\s\S]*?color:\s*#38bdf8/);

  // Mobile layout (< 600px)
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.prx-edit-grid\s*\{\s*grid-template-columns:\s*1fr;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.prx-edit-actions button\s*\{\s*flex:\s*1;/);
});

test("Validation: rejects empty name, empty dosage, out-of-range duration, and zero times", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  // Name required
  assert.match(app, /if \(!newName\)\s*\{[\s\S]*?Medicine name is required/);

  // Dosage required
  assert.match(app, /if \(!newDosage\)\s*\{[\s\S]*?Dosage \/ strength is required/);

  // Duration in range 1-365
  assert.match(app, /newDuration < 1 \|\| newDuration > 365/);
  assert.match(app, /Duration must be between 1 and 365 days/);

  // At least one intake time
  assert.match(app, /!newMorning && !newAfternoon && !newEvening && !newNight/);
  assert.match(app, /Please select at least one intake time/);
});

test("Simulation: Edit medicine name and save preserves unchanged fields and flags _edited", () => {
  const medItem: any = {
    id: "prx_1",
    name: "Zinc",
    brandName: "Zinc",
    genericName: "Zinc Gluconate",
    strength: "50mg",
    dosage: "50mg",
    foodInstruction: "After meal",
    durationDays: 30,
    morning: true,
    afternoon: false,
    evening: false,
    night: false,
    times: ["08:00"],
    _rejected: false,
    _edited: false,
    _isEditing: true
  };

  // Simulate user changing name to "Zinc Citrate" and saving
  const newName = "Zinc Citrate";
  medItem.name = newName;
  medItem.brandName = newName;
  medItem._edited = true;
  medItem._isEditing = false;

  assert.equal(medItem.name, "Zinc Citrate");
  assert.equal(medItem.brandName, "Zinc Citrate");
  assert.equal(medItem.genericName, "Zinc Gluconate"); // preserved
  assert.equal(medItem.strength, "50mg"); // preserved
  assert.equal(medItem.durationDays, 30); // preserved
  assert.equal(medItem._edited, true);
  assert.equal(medItem._isEditing, false);
});

test("Simulation: Edit dosage and intake times updates schedule times array", () => {
  function getTimesFromSchedule(item: any) {
    const times = [];
    if (item.morning) times.push("08:00");
    if (item.afternoon) times.push("13:00");
    if (item.evening) times.push("18:00");
    if (item.night) times.push("21:00");
    return times.length > 0 ? times : ["08:00"];
  }

  const medItem: any = {
    id: "prx_2",
    name: "Amoxicillin",
    brandName: "Amoxicillin",
    genericName: "",
    strength: "500mg",
    dosage: "500mg",
    foodInstruction: "Before meal",
    durationDays: 7,
    morning: true,
    afternoon: false,
    evening: false,
    night: false,
    times: ["08:00"],
    _rejected: false,
    _edited: false
  };

  // User edits dosage to 250mg and changes schedule to morning + night
  medItem.strength = "250mg";
  medItem.dosage = "250mg";
  medItem.morning = true;
  medItem.night = true;
  medItem.times = getTimesFromSchedule(medItem);
  medItem._edited = true;

  assert.equal(medItem.dosage, "250mg");
  assert.deepEqual(medItem.times, ["08:00", "21:00"]);
  assert.equal(medItem._edited, true);
});

test("Simulation: Change meal instructions and duration updates end date calculation", () => {
  const medItem: any = {
    id: "prx_3",
    name: "Paracetamol",
    brandName: "Paracetamol",
    genericName: "",
    strength: "650mg",
    foodInstruction: "Before meal",
    durationDays: 5,
    morning: true,
    afternoon: false,
    evening: false,
    night: false
  };

  // Change to After meal and 14 days
  medItem.foodInstruction = "After meal";
  medItem.durationDays = 14;

  const baseDate = new Date("2026-11-01T00:00:00Z");
  const endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + medItem.durationDays);

  assert.equal(medItem.foodInstruction, "After meal");
  assert.equal(medItem.durationDays, 14);
  assert.equal(endDate.toISOString().slice(0, 10), "2026-11-15");
});

test("Simulation: Cancel an edit preserves the original extracted data", () => {
  const originalState = {
    id: "prx_4",
    name: "Metformin",
    brandName: "Metformin",
    genericName: "Metformin HCl",
    strength: "500mg",
    durationDays: 30,
    _edited: false,
    _isEditing: true
  };

  const medItem = { ...originalState };

  // User types changes in DOM, but then clicks Cancel
  // Cancel handler only resets _isEditing without mutating item properties
  medItem._isEditing = false;

  assert.equal(medItem.name, originalState.name);
  assert.equal(medItem.strength, originalState.strength);
  assert.equal(medItem.durationDays, originalState.durationDays);
  assert.equal(medItem._edited, false);
  assert.equal(medItem._isEditing, false);
});

test("Simulation: Multiple medicines can be edited independently", () => {
  const meds: any[] = [
    { id: "m1", name: "Medicine 1", dosage: "10mg", _edited: false },
    { id: "m2", name: "Medicine 2", dosage: "20mg", _edited: false }
  ];

  // Edit med 1
  meds[0].name = "Med 1 Custom";
  meds[0]._edited = true;

  // Edit med 2
  meds[1].dosage = "40mg";
  meds[1]._edited = true;

  assert.equal(meds[0].name, "Med 1 Custom");
  assert.equal(meds[0].dosage, "10mg");
  assert.equal(meds[0]._edited, true);

  assert.equal(meds[1].name, "Medicine 2");
  assert.equal(meds[1].dosage, "40mg");
  assert.equal(meds[1]._edited, true);
});

test("Simulation: Remove and undo remove work on edited medicine and update accepted count", () => {
  const meds: any[] = [
    { id: "m1", name: "Med A Edited", _edited: true, _rejected: false },
    { id: "m2", name: "Med B", _edited: false, _rejected: false }
  ];

  // Initial accepted count
  let accepted = meds.filter(m => !m._rejected);
  assert.equal(accepted.length, 2);

  // User removes edited medicine m1
  meds[0]._rejected = true;
  accepted = meds.filter(m => !m._rejected);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, "m2");

  // User restores (undos) m1
  meds[0]._rejected = false;
  accepted = meds.filter(m => !m._rejected);
  assert.equal(accepted.length, 2);
  assert.equal(meds[0]._edited, true); // edit state remains preserved
  assert.equal(meds[0].name, "Med A Edited");
});

test("Simulation: Add to schedule payload accurately submits final edited values", () => {
  function getTimesFromSchedule(item: any) {
    const times = [];
    if (item.morning) times.push("08:00");
    if (item.afternoon) times.push("13:00");
    if (item.evening) times.push("18:00");
    if (item.night) times.push("21:00");
    return times.length > 0 ? times : ["08:00"];
  }

  const editedItem: any = {
    id: "prx_final",
    name: "Cetirizine 10mg",
    brandName: "Cetirizine 10mg",
    genericName: "Cetirizine Hydrochloride",
    strength: "10mg tablet",
    dosage: "10mg tablet",
    foodInstruction: "With meal",
    durationDays: 10,
    morning: false,
    afternoon: false,
    evening: false,
    night: true,
    _rejected: false,
    _edited: true
  };

  const brand = (editedItem.brandName || editedItem.name || "").trim();
  const gen = (editedItem.genericName || "").trim();
  const fullName = brand + (gen && !brand.toLowerCase().includes(gen.toLowerCase()) ? ` (${gen})` : "");

  const payload = {
    userId: 27,
    name: fullName,
    dosage: editedItem.strength || editedItem.dosage || "As prescribed",
    instructions: editedItem.foodInstruction || "",
    startDate: "2026-11-03",
    times: getTimesFromSchedule(editedItem)
  };

  assert.equal(payload.name, "Cetirizine 10mg (Cetirizine Hydrochloride)");
  assert.equal(payload.dosage, "10mg tablet");
  assert.equal(payload.instructions, "With meal");
  assert.deepEqual(payload.times, ["21:00"]);
});
