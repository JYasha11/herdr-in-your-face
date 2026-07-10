# herdr-in-your-face

Your AI agent has been sitting there, blocked, waiting for you to approve one
command, for eleven minutes. You are reading Hacker News. This plugin knows.

**herdr-in-your-face** is ["Incredibly In Your Face"](https://marketplace.visualstudio.com/items?itemName=VirejDasani.incredibly-in-your-face)
for [herdr](https://herdr.dev): when any agent in your herd goes `blocked` and
stays that way past a grace period, a giant ASCII face takes over your screen
and escalates — mildly annoyed, then concerned, then wide-eyed screaming in
bold red — until you deal with your agent (or press `q` and live with
yourself).

It is a joke plugin that is secretly a productivity tool. The face goes away
the instant your agent does.

## Screenshot

<!-- GIF/screenshot placeholder: the three escalation stages, and the footer
     with multiple blocked agents. Record with e.g. vhs or asciinema. -->

```
        .-''''''''''''''-.
      .'                  '.
     /                      \
    |    \(O)/     \(O)/     |
    |       __________       |
    |      |          |      |
    |      | AAAAAAAA |      |
    |      |__________|      |
    |                        |
     \                      /
      '.                  .'
        '-..............-'

        AAAAAAAAAAAAAAAH!!

   claude in api-server has been waiting for 5m 12s

     q to dismiss — or go answer your agent
```

## Install

```sh
herdr plugin install JYasha11/herdr-in-your-face
```

For local development:

```sh
git clone https://github.com/JYasha11/herdr-in-your-face.git
herdr plugin link ./herdr-in-your-face
```

Requires herdr ≥ 0.7.3 and Node.js ≥ 18 (no npm packages — the scripts use
only Node built-ins). Linux and macOS; Windows is not supported in v1 (herdr's
Windows build is still in preview and this plugin's overlay/TTY behavior is
untested there).

## Behavior

- When an agent transitions to `blocked`, a timer starts. Nothing visible
  happens during the grace period (default 30s) — brief prompts you answer
  quickly never trigger the face.
- Past the grace period, the overlay opens: big face, a live
  `<agent> in <workspace> has been waiting for 47s` counter, and — if several
  agents are blocked — a footer listing the others. One overlay at a time;
  the longest-waiting agent gets the spotlight.
- The face escalates at configurable thresholds (default 30s / 2min / 5min):
  annoyed → concerned (yellow) → screaming (bold red).
- If you're already focused on the blocked pane, the overlay stays away by
  default (you're clearly dealing with it) and appears if you look away.
- The overlay closes itself the moment no agent is blocked. `q` or `Ctrl-C`
  dismisses it early; it stays away until the next blocked event.

Want a running tally of your neglect? Install the companion plugin
[herdr-shame-report](https://github.com/JYasha11/herdr-shame-report) — fully
independent, pairs beautifully.

## Configuration

Create `config.json` in the plugin's config directory (find it with
`herdr plugin config-dir jyasha11.in-your-face`). Every key is optional;
invalid values fall back to defaults. Changes apply immediately — hooks
re-read the file on every event.

| key | default | meaning |
|---|---|---|
| `grace_seconds` | `30` | how long an agent must be blocked before the overlay appears |
| `stage_seconds` | `[30, 120, 300]` | seconds (from block start) at which each face stage takes over |
| `suppress_when_focused` | `true` | don't open the overlay while the blocked pane is focused |
| `placement` | `"overlay"` | **choose your level of abuse**: `"overlay"` takes over the whole herdr window (the intended experience); `"split"` opens the face as a side pane instead — same face, same escalation, less real estate. (`"tab"` and `"zoomed"` also accepted.) |

```json
{
  "grace_seconds": 45,
  "stage_seconds": [45, 180, 600],
  "suppress_when_focused": true,
  "placement": "split"
}
```

Note the default `overlay` covers your entire herdr window on purpose —
nothing underneath is paused or frozen; your agents and panes keep running,
and `q` puts everything back exactly as it was. If that's more face than you
want while juggling many panes, `"split"` is your setting.

## How it works

The manifest hooks herdr's `pane.agent_status_changed` event; on `blocked`,
`hook.mjs` records the pane in the plugin state dir and hands the grace wait
to a small detached timer process, which opens an overlay pane via the herdr
CLI (the entire plugin API is the CLI). The overlay pane runs `face.mjs`,
which redraws once a second, escalates by elapsed time, cross-checks
`herdr pane list` every 5s so a killed pane can't pin it open, and exits —
closing its own pane — when nothing is blocked. State is one file per fact
(a `blocked/` file per pane, an `overlay.json` lock taken with an exclusive
create), which is what makes concurrent event hooks safe.

## Testing

This is the manual test plan the plugin was actually built against. You can
fake an agent state on any pane — no real stuck agent required:

```sh
# use a shell pane's id (herdr pane current), then:
herdr pane report-agent <pane-id> --source test --agent claude --state blocked
herdr pane report-agent <pane-id> --source test --agent claude --state idle
```

1. **Hook fires**: fake `blocked`, then check
   `herdr plugin log list --plugin jyasha11.in-your-face` — a
   `blocked: <pane>, overlay in 30s unless released` line, exit 0.
2. **Overlay + release**: fake `blocked` on a *non-focused* pane, wait out
   the grace period, watch the overlay appear with a live timer; fake `idle`,
   watch it close within ~1s.
3. **Escalation**: set `stage_seconds` to `[3, 6, 9]` and `grace_seconds`
   to `3` in config.json, re-fake `blocked`, watch all three faces in 10
   seconds. Delete the config afterwards.
4. **Suppression**: with defaults, fake `blocked` on the pane you're focused
   on — no overlay. Focus a different pane — the face appears within ~5s.
5. **Multiple agents**: fake `blocked` on two panes — one overlay, the
   longest wait featured, the other in the footer.
6. **Dismissal**: press `q` — the overlay closes and stays away until the
   next blocked event.
7. **Real agent**: run Claude Code (or any agent herdr detects) in a pane,
   let it hit a permission prompt, ignore it past the grace period, get
   screamed at, approve the prompt, watch the face vanish.

Note for testing: herdr's own detection eventually overrides a *faked* state
on a plain shell pane (it can see there's no real agent), so long-running
fakes auto-release after a minute or so. Real agents don't flap like that.

Debugging: hook runs and their output are in
`herdr plugin log list --plugin jyasha11.in-your-face`; crashes of the
detached timer land in `error.log` in the plugin state dir.

## Security note

herdr plugins are ordinary code running on your machine with your
permissions — there is no sandbox. This one is ~500 lines across two scripts
and a manifest, dependency-free, and calls nothing but the herdr CLI and the
filesystem. Skim the source before installing. That advice goes for every
herdr plugin, not just this one.

## Credits

- Inspired by [Incredibly In Your Face](https://marketplace.visualstudio.com/items?itemName=VirejDasani.incredibly-in-your-face)
  by Virej Dasani, which does this to VS Code errors.
- Patterns borrowed from the official
  [herdr-plugin-examples](https://github.com/ogulcancelik/herdr-plugin-examples).

## License

[MIT](LICENSE)
