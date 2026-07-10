// Event hook + grace timer for the In Your Face plugin.
//
// herdr runs `node hook.mjs` (no args) once per pane.agent_status_changed
// event, with the payload in HERDR_PLUGIN_EVENT_JSON as {event, data};
// data = {pane_id, workspace_id, agent_status, agent, display_agent, ...}.
//
// State layout (HERDR_PLUGIN_STATE_DIR) — one file per fact, so concurrent
// hook processes never rewrite each other's data:
//   blocked/<pane>.json  one per blocked pane; deleting it releases the pane
//   overlay.json         which pane is the overlay; also the "only one
//                        overlay" lock, taken with an exclusive create
//   error.log            failures from detached processes land here
//
// The grace wait runs in a detached copy of this script
// (`node hook.mjs grace-timer <pane_id> <since_ms>`) so the hook itself
// exits in milliseconds and herdr never babysits a sleeping process.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const CFG = loadConfig();
// the env var is a dev/testing override and beats the config file
const GRACE_MS = Number(process.env.IYF_GRACE_MS) || CFG.grace_seconds * 1000;

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "jyasha11.in-your-face";
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR;
const BLOCKED_DIR = join(STATE_DIR, "blocked");
const OVERLAY_PATH = join(STATE_DIR, "overlay.json");

// ":" in pane ids is unfriendly to filenames; the encoding is reversible
const blockedPath = (paneId) => join(BLOCKED_DIR, encodeURIComponent(paneId) + ".json");

if (process.argv[2] === "grace-timer") {
  // detached and stdio-less, so a crash here is invisible unless trapped
  try {
    await graceTimer(process.argv[3], Number(process.argv[4]));
  } catch (e) {
    appendFileSync(
      join(STATE_DIR, "error.log"),
      `${new Date().toISOString()} grace-timer crashed: ${e?.stack ?? e}\n`,
    );
  }
} else {
  handleEvent();
}

function handleEvent() {
  const d = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}").data ?? {};
  if (!d.pane_id) return;

  // Never track the overlay's own pane. Its rendered text (agent names,
  // "waiting", a node process) can trip herdr's agent screen-detection, and
  // the plugin shaming its own face is a feedback loop. Seen in the wild.
  const overlay = readJson(OVERLAY_PATH);
  if (overlay && d.pane_id === overlay.pane) return;

  if (d.agent_status === "blocked") {
    // Back-to-back transitions run their hooks concurrently, so this event
    // may already be stale (the pane released before we got here) — recording
    // it would leave an orphaned entry. Trust the pane's current status.
    if (currentStatus(d.pane_id) !== "blocked") return;
    mkdirSync(BLOCKED_DIR, { recursive: true });
    const since = Date.now();
    const entry = {
      pane_id: d.pane_id,
      since,
      agent: d.display_agent ?? d.agent ?? "agent",
      workspace_id: d.workspace_id,
    };
    try {
      // exclusive create: if the file exists this pane is already tracked
      // and the original grace timer stands
      writeFileSync(blockedPath(d.pane_id), JSON.stringify(entry, null, 2), { flag: "wx" });
    } catch {
      return;
    }
    spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "grace-timer", d.pane_id, String(since)],
      { detached: true, stdio: "ignore" },
    ).unref();
    console.log(`blocked: ${d.pane_id}, overlay in ${GRACE_MS / 1000}s unless released`);
  } else {
    const entry = readJson(blockedPath(d.pane_id));
    if (!entry) return; // wasn't blocked, nothing to release
    try {
      unlinkSync(blockedPath(d.pane_id));
    } catch {}
    // The overlay watches the blocked/ dir and closes itself once it's empty.
    console.log(`released: ${d.pane_id} after ${Math.round((Date.now() - entry.since) / 1000)}s`);
  }
}

async function graceTimer(paneId, since) {
  await sleep(GRACE_MS);

  // If the user is already looking at the blocked pane, screaming at them
  // adds nothing — hold off, and re-check until they look away (then scream)
  // or the pane is released (then stand down). Configurable.
  for (;;) {
    const entry = readJson(blockedPath(paneId));
    // Released meanwhile, or re-blocked at a different timestamp (that block
    // spawned its own timer) — either way this timer no longer owns the pane.
    if (!entry || entry.since !== since) return;
    if (!(CFG.suppress_when_focused && paneFocused(paneId))) break;
    await sleep(5000);
  }
  if (!claimOverlaySlot()) return; // an overlay is already up; it lists everyone

  const openArgs = ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "face", "--focus"];
  // Pane processes get a clean environment (unlike event hooks, which inherit
  // the server's), so the dev/testing knob must be forwarded explicitly.
  if (process.env.IYF_STAGES_MS) openArgs.push("--env", `IYF_STAGES_MS=${process.env.IYF_STAGES_MS}`);
  const res = spawnSync(HERDR, openArgs, { encoding: "utf8" });
  if (res.status !== 0) {
    // Couldn't open — log it (this process is detached, nothing else will)
    // and release the claim so a later timer can retry.
    appendFileSync(
      join(STATE_DIR, "error.log"),
      `${new Date().toISOString()} pane open failed status=${res.status} ` +
        `err=${res.error ?? ""} stderr=${(res.stderr ?? "").trim()}\n`,
    );
    const claim = readJson(OVERLAY_PATH);
    if (claim?.pane === "opening") {
      try {
        unlinkSync(OVERLAY_PATH);
      } catch {}
    }
  }
  // On success face.mjs replaces "opening" with its real pane id itself.
}

// Take the one-overlay-at-a-time lock. The exclusive create ("wx") means
// exactly one of two racing grace timers can win; the loser stands down.
function claimOverlaySlot() {
  const claim = JSON.stringify({ pane: "opening", at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(OVERLAY_PATH, claim, { flag: "wx" });
      return true;
    } catch {
      const cur = readJson(OVERLAY_PATH);
      // A held claim is stale if "opening" never materialized within 15s,
      // or if the recorded overlay pane is gone (face.mjs crashed).
      const stale = !cur
        ? true
        : cur.pane === "opening"
          ? Date.now() - cur.at > 15_000
          : !paneExists(cur.pane);
      if (!stale) return false;
      try {
        unlinkSync(OVERLAY_PATH);
      } catch {}
    }
  }
  return false;
}

function paneExists(paneId) {
  return spawnSync(HERDR, ["pane", "get", paneId], { stdio: "ignore" }).status === 0;
}

function paneFocused(paneId) {
  const res = spawnSync(HERDR, ["pane", "get", paneId], { encoding: "utf8" });
  if (res.status !== 0) return false; // pane gone: don't suppress on uncertainty
  try {
    return JSON.parse(res.stdout).result.pane.focused === true;
  } catch {
    return false;
  }
}

function currentStatus(paneId) {
  const res = spawnSync(HERDR, ["pane", "get", paneId], { encoding: "utf8" });
  if (res.status !== 0) return "gone";
  try {
    return JSON.parse(res.stdout).result.pane.agent_status;
  } catch {
    return "unknown";
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// User config from HERDR_PLUGIN_CONFIG_DIR/config.json; every key optional,
// bad values fall back to defaults. (Duplicated in face.mjs so each script
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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

