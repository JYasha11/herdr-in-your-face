# PLAN — herdr-in-your-face

Verified against **herdr 0.7.3** (installed during planning via the official
`install.sh` to `~/.local/bin/herdr`; Homebrew on this machine is broken —
`/opt/homebrew` isn't writable by user `j`, fixing it needs `sudo chown`).
All event names and payload shapes below come from `herdr api schema --json`
and the official example plugin, not from guessing.

## Language: Node.js (built-ins only)

- Node v22 is already on this machine; the plugin needs Node ≥ 18 (same bar as
  the official examples).
- JSON is native (state ledger, config, `HERDR_PLUGIN_EVENT_JSON` parsing) —
  no parser to write or install.
- `setInterval` + ANSI redraw make the live-updating overlay trivial; doing a
  ticking TUI in POSIX shell means `sleep`-loops and hand-rolled JSON via `jq`,
  which is not guaranteed to exist on Linux.
- The official `agent-telegram-notify` example is Node with zero npm packages —
  we copy its exact patterns, which keeps the code explainable.

TOML config was considered and rejected: Node has no built-in TOML parser, and
writing one violates "small + dependency-free". **Config is JSON.**

## Event mechanism: manifest `[[events]]` hook — confirmed, no watcher needed

The manifest supports exactly the event we need. Ground truth:

- Schema `subscription_event.$defs.SubscriptionEventKind` enum:
  `"pane.output_matched"`, `"pane.agent_status_changed"`, `"pane.scroll_changed"`.
- The official example's manifest uses it verbatim:

  ```toml
  [[events]]
  on = "pane.agent_status_changed"
  command = ["node", "notify.mjs"]
  ```

- Payload (`PaneAgentStatusChangedEvent`, from the schema — hook reads it from
  `HERDR_PLUGIN_EVENT_JSON` as `{event, data}`):
  - required: `pane_id` (string), `workspace_id` (string),
    `agent_status` (enum: `idle | working | blocked | done | unknown`)
  - optional: `agent`, `display_agent`, `custom_status`, `title` (string|null),
    `state_labels` (object)

So: **per-event hook commands, no long-lived watcher process.** The only
long-running process is the overlay pane itself, which is herdr's own pane
model (a pane *is* a process) — it lives only while the overlay is visible.

## Architecture

Three moving parts, two scripts:

1. **`hook.mjs`** — runs on every `pane.agent_status_changed` event.
   - `→ blocked`: writes `{pane_id: {since, agent, workspace_id}}` into
     `blocked.json` in `HERDR_PLUGIN_STATE_DIR`, then sleeps the grace period
     and re-checks; if that pane is still blocked (same timestamp) and no
     overlay is already open, runs
     `HERDR_BIN_PATH plugin pane open --plugin <id> --entrypoint face`.
     If `suppress_when_focused` is on and the blocked pane is focused at grace
     expiry, it re-checks every few seconds instead of opening.
   - `→ anything else` (or `done`): removes the `blocked.json` entry and adds
     the elapsed time to `ledger.json` (atomic write: tmp file + rename).
   - Also handles the `shame-report` action (invoked as `node hook.mjs report`,
     it opens the report pane via `HERDR_BIN_PATH`).
2. **`face.mjs`** — the overlay pane UI. Redraws once per second: picks the
   longest-waiting entry from `blocked.json`, renders the ASCII face for the
   current escalation stage, the `<agent> in <workspace> has been waiting for
   Ns` line, and a footer listing any other blocked agents. When
   `blocked.json` has no live entries left, it closes its own pane and exits.
   With argv `report` it renders the shame-report stats instead (static
   screen, any-key-to-close).
3. **`herdr-plugin.toml`** — wires it together:

   ```toml
   id = "<ns>.in-your-face"          # namespace TBD — see questions
   name = "In Your Face"
   version = "0.1.0"
   min_herdr_version = "0.7.3"       # the only version I can verify against
   description = "Incredibly In Your Face for blocked agents, plus a shame ledger."
   platforms = ["linux", "macos"]

   [[events]]
   on = "pane.agent_status_changed"
   command = ["node", "hook.mjs"]

   [[panes]]
   id = "face"
   title = "IN YOUR FACE"
   placement = "overlay"
   command = ["node", "face.mjs"]

   [[panes]]
   id = "report"
   title = "Shame report"
   placement = "overlay"
   command = ["node", "face.mjs", "report"]

   [[actions]]
   id = "shame-report"
   title = "Show the shame report"
   command = ["node", "hook.mjs", "report"]
   ```

   (The action shells out to `HERDR_BIN_PATH plugin pane open` because manifest
   command arrays can't expand env vars, and hardcoding `herdr` would violate
   the HERDR_BIN_PATH rule.)

## File layout

```
herdr-in-your-face/
├── herdr-plugin.toml
├── hook.mjs          # event hook + grace timer + ledger + report action
├── face.mjs          # overlay renderer (live face / shame report)
├── README.md
├── LICENSE           # MIT — need your name
├── .gitignore
└── PLAN.md           # this file; can be deleted before publishing
```

State (survives restarts, lives in `HERDR_PLUGIN_STATE_DIR`):
- `blocked.json` — currently-blocked panes (transient working state)
- `ledger.json` — `{days: {"YYYY-MM-DD": {seconds, events, longest}}, agents: {name: seconds}, all_time: {...}}`

Config (`HERDR_PLUGIN_CONFIG_DIR/config.json`), all optional:

| key                    | default          | meaning                              |
|------------------------|------------------|--------------------------------------|
| `grace_seconds`        | `30`             | wait before the overlay appears      |
| `stage_seconds`        | `[30, 120, 300]` | escalation thresholds (annoyed → concerned → screaming) |
| `suppress_when_focused`| `true`           | no overlay while the blocked pane is focused |

## Testing plan (how each stage gets verified)

`herdr pane report-agent <pane> --source test --agent claude --state blocked`
lets us fake a blocked agent from any shell pane — no need to actually stall
Claude Code for every test. Real-agent test comes at the end per your
definition of done. Stage 1 smoke test: fake a blocked state, then
`herdr plugin log list --plugin <id>` should show the hook's log line.

## Ambiguities / discrepancies found (docs vs binary)

1. **Two event-name spellings exist.** `schemas.event` (raw socket emissions)
   uses snake_case consts (`pane_agent_status_changed`); the subscription/
   manifest layer uses dotted names (`pane.agent_status_changed`). The docs
   only ever show dotted names for `[[events]]`, and the official example uses
   the dotted form — that's what we use.
2. **Manifest event-name list is not enumerated anywhere in the docs** (only
   examples: `worktree.created`, and the example plugin's
   `pane.agent_status_changed`). Notably there's no confirmed `pane.closed`
   hook. Consequence: if a blocked pane is closed outright (no status-change
   event), the hook never fires for it. Mitigation: `face.mjs` cross-checks
   liveness while rendering and drops dead panes, so the overlay can't get
   stuck; the ledger entry for a killed pane is finalized lazily.
3. **Does `herdr plugin pane open` print the new pane id?** RESOLVED during
   stage 2: yes — JSON at `.result.plugin_pane.pane.pane_id`. We don't need
   it anyway: `face.mjs` records its own `HERDR_PANE_ID` into `overlay.json`.
4. **`done` is a real `AgentStatus`** in the schema, but
   `herdr pane report-agent --state` and `herdr agent wait --status` only
   accept `idle|working|blocked|unknown`. Doesn't affect us (we only care
   about entering/leaving `blocked`), but noted since the docs imply symmetry.
5. **CLI reference page is incomplete** vs `--help` (e.g. `pane report-agent`,
   `pane send-keys`, `plugin config-dir` are undocumented on the page).
   Trusting the binary, per your rule.

## Lessons hit live during stage 2 (kept for the maintainer)

- **Never match a bare Esc byte as a dismiss key** in a raw-mode TUI:
  terminals deliver focus/paste notifications as `\x1b`-prefixed sequences on
  stdin, which false-trigger it. This manifested as the overlay closing
  within milliseconds of opening.
- **A single shared state JSON invites lost updates**: a grace timer's
  read-modify-write straddling two release events resurrected deleted
  entries. Fixed structurally — one file per blocked pane (release = unlink)
  and `overlay.json` claimed with an exclusive create (`wx`), which is an
  atomic one-overlay lock.
- `herdr pane read <id>` prints plain text, not JSON.
- Testing override: set `IYF_GRACE_MS` in the *server's* environment (export
  it before launching `herdr`) to shrink the grace period during manual
  tests; event hooks inherit the server env.
- **Event hooks inherit the server env; plugin pane processes get a clean
  one.** A knob meant for the pane must be forwarded via
  `herdr plugin pane open --env KEY=VALUE` (that's how `IYF_STAGES_MS`
  reaches `face.mjs`).
- **The overlay can shame itself.** herdr's agent screen-detection watches
  every pane; an overlay that prints agent names and "waiting" from a node
  process can get detected as a blocked agent, which re-feeds the plugin —
  a feedback loop we hit live (`w9:p5`). Two defenses: the hook ignores any
  event whose pane is the current overlay, and
  `herdr agent explain --file <render.txt> --agent claude` is the offline
  way to check whether rendered content trips a detection rule.
- **`const`/`let` don't hoist; entry code must come last.** Two separate
  crashes (report: `sum`/`longest` as const arrows; face: `let faceTimer`)
  from calling into code above declarations that hadn't initialized yet
  (temporal dead zone). The entry branch now sits at the bottom of face.mjs
  with a comment saying why.
- When faking states with `pane report-agent` on a plain shell pane,
  herdr's own detection eventually overrides the report (idle fallback), so
  the fake "agent" auto-releases after a minute or so. Real agents don't
  flap like this — it's a test artifact.
