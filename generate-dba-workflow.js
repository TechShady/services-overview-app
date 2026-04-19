const fs = require("fs");

const dashboard = JSON.parse(
  fs.readFileSync(
    "C:/Users/john.kelly/Downloads/DBA Monitoring - Disk, Queries & Resources.json",
    "utf8"
  )
);

// Collect all data tiles with DQL queries (skip markdown tiles and data record tiles that start with 'data ')
const dataTiles = [];
const tiles = dashboard.tiles;
for (const key of Object.keys(tiles)) {
  const t = tiles[key];
  if (t.type === "data" && t.query) {
    dataTiles.push({
      key,
      title: t.title || "",
      query: t.query,
    });
  }
}

// Generate a task name from the tile
function makeTaskName(tile, idx) {
  if (tile.title && tile.title.trim()) {
    return tile.title
      .replace(/[^a-zA-Z0-9 ]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .toLowerCase()
      .slice(0, 50);
  }
  // For untitled tiles, derive from query
  const q = tile.query.trim().toLowerCase();
  if (q.includes("critical_disks")) return "critical_disks_count";
  if (q.includes("warning_disks")) return "warning_disks_count";
  if (q.includes("total_db_calls")) return "total_db_calls";
  if (q.includes("slow_queries")) return "slow_queries_count";
  if (q.includes("hosts_high_cpu")) return "hosts_high_cpu_count";
  if (q.includes("hosts_high_memory")) return "hosts_high_memory_count";
  return "tile_" + tile.key;
}

// Add timeframe filter to DQL queries
function addTimeframe(query) {
  const trimmed = query.trim();
  // If query starts with "data " (like data record(...)), don't add timeframe
  if (trimmed.toLowerCase().startsWith("data ")) return trimmed;

  // For timeseries: add ", from: @d-1d, to: @d" before any newline after the timeseries line
  if (trimmed.toLowerCase().startsWith("timeseries")) {
    // Check if it already has a from: clause on the first line
    const lines = trimmed.split("\n");
    const firstLine = lines[0];
    if (firstLine.includes("from:")) {
      // Replace existing from/to
      lines[0] = firstLine
        .replace(/from:\s*now\(\)-\d+d/, "from: @d-1d")
        .replace(/to:\s*now\(\)/, "to: @d");
      if (!lines[0].includes("to:")) {
        lines[0] = lines[0].replace(/(from:\s*@d-1d)/, "$1, to: @d");
      }
      return lines.join("\n");
    }
    // Find the end of the timeseries command (before the first pipe or newline with pipe)
    // The timeseries command might span multiple lines (like tile 29)
    // Find the first | that's a pipe command (not inside the timeseries)
    let timeseriesEnd = -1;
    let braceDepth = 0;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === "{") braceDepth++;
      if (trimmed[i] === "}") braceDepth--;
      if (trimmed[i] === "|" && braceDepth === 0 && i > 0) {
        timeseriesEnd = i;
        break;
      }
    }
    if (timeseriesEnd === -1) {
      // No pipe, append to end
      return trimmed + ", from: @d-1d, to: @d";
    }
    // Insert before the first pipe
    const before = trimmed.slice(0, timeseriesEnd).trimEnd();
    const after = trimmed.slice(timeseriesEnd);
    // Check if there's already a comma or params
    return before + ", from: @d-1d, to: @d\n" + after;
  }

  // For fetch queries: add ", from: @d-1d, to: @d" after "fetch <source>"
  if (trimmed.toLowerCase().startsWith("fetch ")) {
    const lines = trimmed.split("\n");
    const firstLine = lines[0].trim();
    // e.g. "fetch spans" or "fetch events"
    if (!firstLine.includes(",") && !firstLine.includes("from:")) {
      lines[0] = firstLine + ", from: @d-1d, to: @d";
    }
    return lines.join("\n");
  }

  return trimmed;
}

// Add limit 25 if no limit exists
function addLimit(query) {
  if (/\blimit\b/i.test(query)) return query;
  return query.trimEnd() + "\n| limit 25";
}

// Fix user_events -> user.events
function fixUserEvents(query) {
  return query.replace(/\buser_events\b/g, "user.events");
}

// Process all tiles into tasks
const tasks = {};
const dqlTaskNames = [];
const promptTaskNames = [];
let xPos = -Math.floor(dataTiles.length / 2);

for (let i = 0; i < dataTiles.length; i++) {
  const tile = dataTiles[i];
  let taskName = makeTaskName(tile, i);

  // Ensure unique
  let suffix = 2;
  let uniqueName = taskName;
  while (tasks[uniqueName]) {
    uniqueName = taskName + "_" + suffix++;
  }
  taskName = uniqueName;

  let query = tile.query;
  query = fixUserEvents(query);
  query = addTimeframe(query);
  query = addLimit(query);

  // DQL task
  tasks[taskName] = {
    name: taskName,
    input: { query },
    action: "dynatrace.automations:execute-dql-query",
    position: { x: xPos + i, y: 1 },
    description: "Make use of Dynatrace Grail data in your workflow.",
    predecessors: [],
  };
  dqlTaskNames.push(taskName);

  // Prompt task
  const promptName = taskName + "_prompt";
  const tileTitle = tile.title || taskName.replace(/_/g, " ");
  const titleForReport =
    tileTitle.charAt(0).toUpperCase() + tileTitle.slice(1);

  tasks[promptName] = {
    name: promptName,
    input: {
      config: "disabled",
      prompt: `Provide a report for the following use case:\n## ${titleForReport} Analysis Report\n`,
      autoTrim: true,
      instruction:
        "Provide a Summary, Insights, Observations and Recommendations.",
      supplementary: `Format examples in tables instead of bulleted lists.\nWhere applicable convert units for readability, e.g. 1000000000 bytes is 1 TiB.\nWhere applicable show relative percentages, e.g. 100 used and 1000 allocatable is 10% utilized.\nUse this analysis:\n{{result("${taskName}")["records"]}}\n`,
    },
    action: "dynatrace.davis.copilot.workflow.actions:davis-copilot",
    position: { x: xPos + i, y: 2 },
    conditions: { states: { [taskName]: "OK" } },
    description: "Prompt the Dynatrace Intelligence generative AI",
    predecessors: [taskName],
  };
  promptTaskNames.push(promptName);
}

// Overall prompt task
const overallPromptConditions = {};
for (const pn of promptTaskNames) {
  overallPromptConditions[pn] = "OK";
}

const overallSupplementary =
  "Format examples in tables instead of bulleted lists.\nUse this analysis:\n" +
  promptTaskNames.map((pn) => `{{result("${pn}").text}}`).join("\n") +
  "\n\n";

tasks["overall_prompt"] = {
  name: "overall_prompt",
  input: {
    config: "disabled",
    prompt:
      "Provide a report for the following use case:\n## DBA Monitoring - Disk, Queries & Resources Executive Report",
    autoTrim: true,
    instruction:
      "Provide a Summary, Insights, Observations and Recommendations.",
    supplementary: overallSupplementary,
  },
  action: "dynatrace.davis.copilot.workflow.actions:davis-copilot",
  position: { x: 0, y: 3 },
  conditions: { states: overallPromptConditions },
  description: "Prompt the Dynatrace Intelligence generative AI",
  predecessors: [...promptTaskNames],
};

// Exec email
tasks["email_exec_report"] = {
  name: "email_exec_report",
  input: {
    cc: [],
    to: ["john.kelly@dynatrace.com"],
    bcc: [],
    content:
      '#\n# Dashboard Overall Summary \n#\n{{result("overall_prompt").text}}\n',
    subject:
      "Dynatrace DBA Monitoring Dashboard Executive Summary Report",
  },
  action: "dynatrace.email:send-email",
  position: { x: 1, y: 4 },
  conditions: { states: { overall_prompt: "OK" } },
  description: "Send email",
  predecessors: ["overall_prompt"],
};

// Detail email
const detailEmailContent =
  '#\n# Dashboard Overall Summary\n#\n{{result("overall_prompt").text}}\n#\n# Dashboard Tile Summary\n#\n' +
  promptTaskNames.map((pn) => `{{result("${pn}").text}}`).join("\n") +
  "\n";

tasks["email_dashboard_report"] = {
  name: "email_dashboard_report",
  input: {
    cc: [],
    to: ["john.kelly@dynatrace.com"],
    bcc: [],
    content: detailEmailContent,
    subject: "Dynatrace DBA Monitoring Dashboard Tile Report",
  },
  action: "dynatrace.email:send-email",
  position: { x: -1, y: 4 },
  conditions: { states: { overall_prompt: "OK" } },
  description: "Send email",
  predecessors: ["overall_prompt"],
};

// Build workflow
const workflow = {
  title: "DBA Monitoring - Disk, Queries & Resources",
  description:
    "This Workflow generates DBA Monitoring reports and emails to the specified addresses.",
  ownerType: "USER",
  isPrivate: true,
  schemaVersion: 4,
  trigger: {},
  result: null,
  type: "STANDARD",
  input: {},
  hourlyExecutionLimit: 10,
  guide:
    "# DBA Monitoring Report\nAutomatic DQL-based analysis of database disks, queries, and resource utilization. This Workflow queries Grail and provides data to Dynatrace Intelligence for recommendations.\n\n# Setup\n1. Test with a manual Run.\n2. If everything works as expected, change the Trigger to a schedule.",
  tasks,
};

const outPath =
  "C:/Users/john.kelly/Downloads/DBA-Monitoring-Workflow.workflow.json";
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), "utf8");
console.log("Written to", outPath);
console.log("DQL tasks:", dqlTaskNames.length);
console.log("Prompt tasks:", promptTaskNames.length);
console.log(
  "Total tasks:",
  Object.keys(tasks).length,
  "(DQL + Prompts + overall_prompt + 2 emails)"
);
console.log("Task names:", Object.keys(tasks).join(", "));
