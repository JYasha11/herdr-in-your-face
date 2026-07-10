// The overlay UI for the In Your Face plugin. herdr starts this inside an
// overlay pane; the pane lives exactly as long as this process. It redraws
// once per second, shows the longest-waiting blocked agent (others in the
// footer), escalates over time, and closes itself when nothing is blocked
// anymore — or when you press q.
//
// It reads the blocked/ dir that hook.mjs maintains: one JSON file per
// blocked pane; a pane is released by deleting its file.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const MY_PANE = process.env.HERDR_PANE_ID;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR;
const BLOCKED_DIR = join(STATE_DIR, "blocked");
const OVERLAY_PATH = join(STATE_DIR, "overlay.json");

// ---------------------------------------------------------------- faces ---

// The escalation ladder. Every face shares one outline; only the six
// middle rows (eyes + mouth) change per stage, so the layout never jumps.
// (Plain strings, not template literals: art lines end in "\", which would
// escape a template literal's closing backtick.)
const FACE_TOP = [
  "        .-''''''''''''''-.",
  "      .'                  '.",
  "     /                      \\",
];
const FACE_BOTTOM = [
  "     \\                      /",
  "      '.                  .'",
  "        '-..............-'",
];
const MIDDLES = {
  annoyed: [
    "    |     ____      ____     |",
    "    |     \\___\\     \\___\\    |",
    "    |                        |",
    "    |                        |",
    "    |     ______________     |",
    "    |    '--------------'    |",
  ],
  concerned: [
    "    |     __         __      |",
    "    |    ( o )      ( o )    |",
    "    |                        |",
    "    |                        |",
    "    |        ________        |",
    "    |       /        \\       |",
  ],
  screaming: [
    "    |    \\(O)/     \\(O)/     |",
    "    |       __________       |",
    "    |      |          |      |",
    "    |      | AAAAAAAA |      |",
    "    |      |__________|      |",
    "    |                        |",
  ],
};

// Time thresholds (from the moment the agent blocked) at which each stage
// takes over. From config.json; the env var is a dev knob that beats it
// (forwarded by hook.mjs via `plugin pane open --env`).
const STAGES_MS = process.env.IYF_STAGES_MS
  ? process.env.IYF_STAGES_MS.split(",").map(Number)
  : loadConfig().stage_seconds.map((s) => s * 1000);

const STAGES = [
  { middle: MIDDLES.annoyed, headline: "AHEM.", color: "" },
  { middle: MIDDLES.concerned, headline: "HELLO? HELLO?", color: "\x1b[33m" },
  { middle: MIDDLES.screaming, headline: "AAAAAAAAAAAAAAAH!!", color: "\x1b[1;31m" },
].map((s) => ({ ...s, face: padBlock([...FACE_TOP, ...s.middle, ...FACE_BOTTOM]) }));

// Highest stage whose threshold the wait has passed; below the first
// threshold (possible when the grace period is shorter) stay on stage 0.
function stageFor(elapsedMs) {
  let i = 0;
  for (let s = 0; s < STAGES_MS.length && s < STAGES.length; s++) {
    if (elapsedMs >= STAGES_MS[s]) i = s;
  }
  return STAGES[i];
}

// Pad lines to one width so they all get the same centering offset —
// centering each line by its own length would skew the art.
function padBlock(lines) {
  const w = Math.max(...lines.map((l) => l.length));
  return lines.map((l) => l.padEnd(w));
}

// ------------------------------------------------------------- the face ---

let faceTimer;

function runFace() {
  // Replace the grace timer's "opening" placeholder with our real pane id:
  // we own the one-overlay slot now.
  writeJson(OVERLAY_PATH, { pane: MY_PANE, at: Date.now() });

  process.stdout.write("\x1b[?25l\x1b[2J"); // hide cursor, clear

  // q / Ctrl-C dismisses the overlay (it stays away until the next blocked
  // event — being dismissable is part of not being obnoxious). Deliberately
  // NOT matching Esc: terminals deliver focus/paste notifications as
  // \x1b-prefixed byte sequences on stdin, which would false-trigger it.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (b) => {
      const k = b.toString();
      if (k === "q" || k === "Q" || k === "\x03") shutdownFace(false);
    });
  }
  // If herdr closes the pane out from under us, still release the overlay slot.
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) {
    process.on(sig, () => shutdownFace(true));
  }

  faceTimer = setInterval(renderFace, 1000);
  renderFace();
}

let tick = 0;

function renderFace() {
  tick++;
  // Every 5s, reconcile with reality: a pane can die without ever emitting a
  // status-change event, and a stale file must not pin the overlay open.
  if (tick % 5 === 1) heal();

  const entries = readBlocked();
  if (entries.length === 0) return shutdownFace(false);

  const top = entries[0];
  const elapsed = Date.now() - top.since;
  const stage = stageFor(elapsed);
  const paint = (l) => (stage.color ? stage.color + l + "\x1b[0m" : l);
  const lines = stage.face.map(paint);
  lines.push("", `\x1b[1m${stage.color}${stage.headline}\x1b[0m`, "");
  lines.push(
    `${top.agent} in ${top.workspace_id} has been waiting for \x1b[1m${fmtDur(elapsed)}\x1b[0m`,
  );
  if (entries.length > 1) {
    const others = entries
      .slice(1)
      .map((e) => `${e.agent} (${fmtDur(Date.now() - e.since)})`)
      .join(", ");
    lines.push("", `\x1b[2malso ignored: ${others}\x1b[0m`);
  }
  lines.push("", `\x1b[2mq to dismiss — or go answer your agent\x1b[0m`);
  draw(lines);
}

function readBlocked() {
  let files;
  try {
    files = readdirSync(BLOCKED_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // dir doesn't exist yet = nothing blocked
  }
  return files
    .map((f) => readJson(join(BLOCKED_DIR, f)))
    .filter(Boolean)
    .sort((a, b) => a.since - b.since);
}

function heal() {
  const res = spawnSync(HERDR, ["pane", "list"], { encoding: "utf8" });
  if (res.status !== 0) return; // server unreachable: change nothing
  let live;
  try {
    live = new Map(JSON.parse(res.stdout).result.panes.map((p) => [p.pane_id, p.agent_status]));
  } catch {
    return;
  }
  for (const e of readBlocked()) {
    if (live.get(e.pane_id) !== "blocked") {
      try {
        unlinkSync(join(BLOCKED_DIR, encodeURIComponent(e.pane_id) + ".json"));
      } catch {}
    }
  }
}

function shutdownFace(paneAlreadyClosing) {
  clearInterval(faceTimer);
  const claim = readJson(OVERLAY_PATH);
  if (claim?.pane === MY_PANE || claim?.pane === "opening") {
    try {
      unlinkSync(OVERLAY_PATH);
    } catch {}
  }
  closePane(paneAlreadyClosing);
}

// --------------------------------------------------------------- shared ---

function closePane(paneAlreadyClosing) {
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
  if (!paneAlreadyClosing) {
    // Closing our own pane normally kills this process too; exit() below is
    // the fallback for running outside a herdr pane.
    spawnSync(HERDR, ["plugin", "pane", "close", MY_PANE], { stdio: "ignore" });
  }
  process.exit(0);
}

function draw(lines) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const padTop = Math.max(0, Math.floor((rows - lines.length) / 2));
  const centered = lines.map((l) => {
    const visible = l.replace(/\x1b\[[0-9;]*m/g, "").length; // ANSI codes take no width
    return " ".repeat(Math.max(0, Math.floor((cols - visible) / 2))) + l;
  });
  process.stdout.write("\x1b[2J\x1b[H" + "\n".repeat(padTop) + centered.join("\n"));
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  // temp file + rename, so a concurrent reader never sees a half-written file
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

// User config from HERDR_PLUGIN_CONFIG_DIR/config.json; every key optional,
// bad values fall back to defaults. (Duplicated in hook.mjs so each script
// stays self-contained.)
function loadConfig() {
  const defaults = { grace_seconds: 30, stage_seconds: [30, 120, 300], suppress_when_focused: true };
  const raw = readJson(join(process.env.HERDR_PLUGIN_CONFIG_DIR ?? "", "config.json")) ?? {};
  const cfg = { ...defaults };
  if (Number.isFinite(raw.grace_seconds) && raw.grace_seconds >= 0) cfg.grace_seconds = raw.grace_seconds;
  if (Array.isArray(raw.stage_seconds)) {
    const stages = raw.stage_seconds.filter((s) => Number.isFinite(s) && s >= 0);
    if (stages.length > 0) cfg.stage_seconds = stages;
  }
  if (typeof raw.suppress_when_focused === "boolean") cfg.suppress_when_focused = raw.suppress_when_focused;
  return cfg;
}

// ----------------------------------------------------------- entry point ---
// Last in the file on purpose: this runs at module load, so everything above
// (functions hoist, but const/let don't) must already be initialized. A
// mid-file entry branch caused two temporal-dead-zone crashes during
// development; don't move it back up.

runFace();
