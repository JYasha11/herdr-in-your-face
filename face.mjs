// The overlay UIs for the In Your Face plugin. herdr starts this inside an
// overlay pane; the pane lives exactly as long as this process.
//
//   node face.mjs          the face: redraws once per second, shows the
//                          longest-waiting blocked agent (others in the
//                          footer), escalates over time, and closes itself
//                          when nothing is blocked anymore — or on q.
//   node face.mjs report   the shame report: static stats from the ledger,
//                          any ordinary key closes it.
//
// It reads the blocked/ dir that hook.mjs maintains: one JSON file per
// blocked pane; a pane is released by deleting its file.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const MY_PANE = process.env.HERDR_PANE_ID;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR;
const BLOCKED_DIR = join(STATE_DIR, "blocked");
const OVERLAY_PATH = join(STATE_DIR, "overlay.json");
const LEDGER_PATH = join(STATE_DIR, "ledger.jsonl");
const REPORT_PATH = join(STATE_DIR, "report.json");

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
// takes over. Stage 6 makes these configurable; the env var is a dev knob.
const STAGES_MS = (process.env.IYF_STAGES_MS ?? "30000,120000,300000")
  .split(",")
  .map(Number);

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

// ----------------------------------------------------------- entry point ---

if (process.argv[2] === "report") {
  runReport();
} else {
  runFace();
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
      // Winning the unlink is the claim to credit this wait to the ledger
      // (same rule as hook.mjs) — a pane killed without a release event
      // still gets its time counted, and never twice.
      try {
        unlinkSync(join(BLOCKED_DIR, encodeURIComponent(e.pane_id) + ".json"));
      } catch {
        continue;
      }
      creditLedger(LEDGER_PATH, e);
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

// ----------------------------------------------------------- the report ---

function runReport() {
  // Let hook.mjs know this pane is ours, so herdr's screen-detection can't
  // trick the plugin into shaming its own report (same guard as the face).
  writeJson(REPORT_PATH, { pane: MY_PANE, at: Date.now() });

  process.stdout.write("\x1b[?25l\x1b[2J");
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (b) => {
      // "Any key closes" — except \x1b-prefixed chunks, which are terminal
      // event sequences (focus, paste), not the user pressing a key.
      if (b[0] !== 0x1b) shutdownReport(false);
    });
  }
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) {
    process.on(sig, () => shutdownReport(true));
  }

  draw(reportLines());
}

function reportLines() {
  const waits = readLedger();
  const today = localDate();
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;

  const lines = [bold("THE SHAME REPORT"), ""];

  if (waits.length === 0) {
    lines.push("Nothing on the ledger. Either you answer your agents");
    lines.push("promptly, or this plugin just got installed.", "");
    lines.push(dim("The sheep are watching."));
    lines.push("", dim("press any key to close"));
    return lines;
  }

  const todayWaits = waits.filter((w) => w.date === today);
  lines.push(bold(`TODAY (${today})`));
  if (todayWaits.length === 0) {
    lines.push("No shame today. Yet.");
  } else {
    lines.push(
      `You kept the herd waiting ${bold(fmtDur(sum(todayWaits) * 1000))} ` +
        `across ${todayWaits.length} abandonment${todayWaits.length === 1 ? "" : "s"}.`,
    );
    const worst = longest(todayWaits);
    lines.push(
      `Longest single abandonment: ${bold(fmtDur(worst.seconds * 1000))} ` +
        `(${worst.agent} in ${worst.workspace})`,
    );
  }

  lines.push("", bold("ALL TIME"));
  lines.push(
    `${bold(fmtDur(sum(waits) * 1000))} of agents staring at the ceiling, ` +
      `over ${waits.length} event${waits.length === 1 ? "" : "s"}.`,
  );
  const record = longest(waits);
  lines.push(
    `Record abandonment: ${bold(fmtDur(record.seconds * 1000))} ` +
      `(${record.agent} in ${record.workspace}, ${record.date})`,
  );

  // hall of shame: total wait per agent, worst first
  const perAgent = new Map();
  for (const w of waits) perAgent.set(w.agent, (perAgent.get(w.agent) ?? 0) + w.seconds);
  const ranked = [...perAgent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  lines.push("", bold("HALL OF SHAME (time kept waiting)"));
  for (const [agent, seconds] of ranked) {
    lines.push(`${(agent + " ").padEnd(24, ".")} ${fmtDur(seconds * 1000)}`);
  }

  lines.push("", dim("The sheep remember."));
  lines.push("", dim("press any key to close"));
  return lines;
}

function readLedger() {
  let raw;
  try {
    raw = readFileSync(LEDGER_PATH, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null; // a torn line can't take the report down
      }
    })
    .filter((w) => w && typeof w.seconds === "number");
}

// function declarations (not const arrows): they're called from runReport(),
// which executes at module load, before a const on this line would initialize
function sum(waits) {
  return waits.reduce((t, w) => t + w.seconds, 0);
}
function longest(waits) {
  return waits.reduce((m, w) => (w.seconds > m.seconds ? w : m));
}

function localDate() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function shutdownReport(paneAlreadyClosing) {
  const marker = readJson(REPORT_PATH);
  if (marker?.pane === MY_PANE) {
    try {
      unlinkSync(REPORT_PATH);
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

// One finished wait = one appended JSON line. (Duplicated in hook.mjs so
// each script stays self-contained.)
function creditLedger(ledgerPath, entry) {
  const line = JSON.stringify({
    date: localDate(),
    agent: entry.agent,
    workspace: entry.workspace_id,
    pane: entry.pane_id,
    seconds: Math.round((Date.now() - entry.since) / 1000),
  });
  appendFileSync(ledgerPath, line + "\n");
}
