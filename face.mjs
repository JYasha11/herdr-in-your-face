// The overlay UI for the In Your Face plugin.
//
// herdr starts this inside an overlay pane (entrypoint "face"); the pane
// lives exactly as long as this process. It redraws once per second, shows
// the longest-waiting blocked agent (others in the footer), and closes
// itself when nothing is blocked anymore — or when you press q.
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

// Stage 3 turns this into an escalation ladder of faces.
// (Plain strings, not template literals: art lines end in "\", which would
// escape a template literal's closing backtick.)
const FACE = [
  "        .-''''''''''''''-.",
  "      .'                  '.",
  "     /                      \\",
  "    |     ____      ____     |",
  "    |     \\___\\     \\___\\    |",
  "    |                        |",
  "    |                        |",
  "    |     ______________     |",
  "    |    '--------------'    |",
  "     \\                      /",
  "      '.                  .'",
  "        '-..............-'",
];
const HEADLINE = "AHEM.";

// Face lines are padded to one width so they all get the same centering
// offset — centering each line by its own length would skew the art.
const FACE_W = Math.max(...FACE.map((l) => l.length));
for (let i = 0; i < FACE.length; i++) FACE[i] = FACE[i].padEnd(FACE_W);

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
    if (k === "q" || k === "Q" || k === "\x03") shutdown(false);
  });
}
// If herdr closes the pane out from under us, still release the overlay slot.
for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) {
  process.on(sig, () => shutdown(true));
}

let tick = 0;
const timer = setInterval(render, 1000);
render();

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

function render() {
  tick++;
  // Every 5s, reconcile with reality: a pane can die without ever emitting a
  // status-change event, and a stale file must not pin the overlay open.
  if (tick % 5 === 1) heal();

  const entries = readBlocked();
  if (entries.length === 0) return shutdown(false);

  const top = entries[0];
  const lines = [...FACE, ""];
  lines.push(`\x1b[1m${HEADLINE}\x1b[0m`, "");
  lines.push(
    `${top.agent} in ${top.workspace_id} has been waiting for \x1b[1m${fmtDur(Date.now() - top.since)}\x1b[0m`,
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

function shutdown(paneAlreadyClosing) {
  clearInterval(timer);
  const claim = readJson(OVERLAY_PATH);
  if (claim?.pane === MY_PANE || claim?.pane === "opening") {
    try {
      unlinkSync(OVERLAY_PATH);
    } catch {}
  }
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
  if (!paneAlreadyClosing) {
    // Closing our own pane normally kills this process too; exit() below is
    // the fallback for running outside a herdr pane.
    spawnSync(HERDR, ["plugin", "pane", "close", MY_PANE], { stdio: "ignore" });
  }
  process.exit(0);
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
