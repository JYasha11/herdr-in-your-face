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

// stage 6 makes this configurable; the env var is a dev/testing override
const GRACE_MS = Number(process.env.IYF_GRACE_MS) || 30_000;

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "jyasha11.in-your-face";
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR;
const BLOCKED_DIR = join(STATE_DIR, "blocked");
const OVERLAY_PATH = join(STATE_DIR, "overlay.json");

// ":" in pane ids is unfriendly to filenames; the encoding is reversible
const blockedPath = (paneId) => join(BLOCKED_DIR, encodeURIComponent(paneId) + ".json");

if (process.argv[2] === "grace-timer") {
  await graceTimer(process.argv[3], Number(process.argv[4]));
} else {
  handleEvent();
}

function handleEvent() {
  const d = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}").data ?? {};
  if (!d.pane_id) return;

  if (d.agent_status === "blocked") {
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
    // stage 4: credit (Date.now() - entry.since) to the shame ledger here.
    // The overlay watches the blocked/ dir and closes itself once it's empty.
    console.log(`released: ${d.pane_id} after ${Math.round((Date.now() - entry.since) / 1000)}s`);
  }
}

async function graceTimer(paneId, since) {
  await new Promise((r) => setTimeout(r, GRACE_MS));

  const entry = readJson(blockedPath(paneId));
  // Released meanwhile, or re-blocked at a different timestamp (that block
  // spawned its own timer) — either way this timer no longer owns the pane.
  if (!entry || entry.since !== since) return;
  if (!claimOverlaySlot()) return; // an overlay is already up; it lists everyone

  const res = spawnSync(
    HERDR,
    ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "face", "--focus"],
    { encoding: "utf8" },
  );
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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
