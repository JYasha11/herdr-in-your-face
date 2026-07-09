// Event hook + grace timer for the In Your Face plugin.
//
// herdr runs `node hook.mjs` (no args) once per pane.agent_status_changed
// event, with the payload in HERDR_PLUGIN_EVENT_JSON as {event, data};
// data = {pane_id, workspace_id, agent_status, agent, display_agent, ...}.
//
// The grace wait runs in a detached copy of this script
// (`node hook.mjs grace-timer <pane_id> <since_ms>`) so the hook itself
// exits in milliseconds and herdr never babysits a sleeping process.

import { readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

// stage 6 makes this configurable; the env var is a dev/testing override
const GRACE_MS = Number(process.env.IYF_GRACE_MS) || 30_000;

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "jyasha11.in-your-face";
const STATE_PATH = join(process.env.HERDR_PLUGIN_STATE_DIR, "blocked.json");

if (process.argv[2] === "grace-timer") {
  await graceTimer(process.argv[3], Number(process.argv[4]));
} else {
  handleEvent();
}

function handleEvent() {
  const d = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}").data ?? {};
  if (!d.pane_id) return;

  const state = readState();
  const entry = state.panes[d.pane_id];

  if (d.agent_status === "blocked") {
    if (entry) return; // already tracked; the original grace timer stands
    const since = Date.now();
    state.panes[d.pane_id] = {
      since,
      agent: d.display_agent ?? d.agent ?? "agent",
      workspace_id: d.workspace_id,
    };
    writeState(state);
    spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "grace-timer", d.pane_id, String(since)],
      { detached: true, stdio: "ignore" },
    ).unref();
    console.log(`blocked: ${d.pane_id}, overlay in ${GRACE_MS / 1000}s unless released`);
  } else if (entry) {
    delete state.panes[d.pane_id];
    writeState(state);
    // stage 4: credit (Date.now() - entry.since) to the shame ledger here.
    // The overlay watches blocked.json and closes itself once it's empty.
    console.log(`released: ${d.pane_id} after ${Math.round((Date.now() - entry.since) / 1000)}s`);
  }
}

async function graceTimer(paneId, since) {
  await new Promise((r) => setTimeout(r, GRACE_MS));

  const state = readState();
  const entry = state.panes[paneId];
  // Released meanwhile, or re-blocked at a different timestamp (that block
  // spawned its own timer) — either way this timer no longer owns the pane.
  if (!entry || entry.since !== since) return;

  // One overlay at a time. The slot is claimed with "opening" before the
  // pane exists; a claim is stale if it never materialized within 15s, and
  // a recorded pane id is stale if that pane is gone (face.mjs crashed).
  if (state.overlay) {
    const o = state.overlay;
    const stale =
      o.pane === "opening" ? Date.now() - o.at > 15_000 : !paneExists(o.pane);
    if (!stale) return;
  }
  state.overlay = { pane: "opening", at: Date.now() };
  writeState(state);

  const res = spawnSync(
    HERDR,
    ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "face", "--focus"],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    // Couldn't open — release the claim so a later timer can retry, and
    // leave a trace: this process is detached, so nothing else will.
    appendFileSync(
      join(process.env.HERDR_PLUGIN_STATE_DIR, "error.log"),
      `${new Date().toISOString()} pane open failed status=${res.status} ` +
        `err=${res.error ?? ""} stderr=${(res.stderr ?? "").trim()} stdout=${(res.stdout ?? "").trim()}\n`,
    );
    const s = readState();
    if (s.overlay?.pane === "opening") {
      s.overlay = null;
      writeState(s);
    }
  }
}

function paneExists(paneId) {
  return spawnSync(HERDR, ["pane", "get", paneId], { stdio: "ignore" }).status === 0;
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { panes: {}, overlay: null }; // first run (or unreadable): start clean
  }
}

function writeState(state) {
  // temp file + rename, so a concurrent reader never sees a half-written file
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}
