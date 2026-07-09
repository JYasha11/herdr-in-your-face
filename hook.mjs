// Stage 1: prove the event hook fires.
// herdr runs this once per pane.agent_status_changed event, with the event
// payload in HERDR_PLUGIN_EVENT_JSON as {event, data}.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "{}");
const d = event.data ?? {};

const line =
  `${new Date().toISOString()} ` +
  `pane=${d.pane_id} agent=${d.display_agent ?? d.agent ?? "?"} ` +
  `status=${d.agent_status}`;

appendFileSync(join(process.env.HERDR_PLUGIN_STATE_DIR, "events.log"), line + "\n");
console.log(line); // stdout is captured by `herdr plugin log list`
