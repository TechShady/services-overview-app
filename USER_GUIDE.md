# Services Overview App — User Guide

> **Disclaimer:** This is an unofficial community application built by a Dynatrace SE. It is not a supported Dynatrace product. File issues on [GitHub](https://github.com/TechShady/services-overview-app); there is no support SLA.

---

## Table of Contents

1. [What Is This App?](#1-what-is-this-app)
2. [Getting Started](#2-getting-started)
3. [Header Bar Reference](#3-header-bar-reference)
4. [Tab Navigation and Customization](#4-tab-navigation-and-customization)
5. [Overview Tab](#5-overview-tab)
6. [Summary Details Tab](#6-summary-details-tab)
7. [Metrics Tab](#7-metrics-tab)
8. [Reliability Tab](#8-reliability-tab)
9. [Quality Tab](#9-quality-tab)
10. [Performance Tab](#10-performance-tab)
11. [Dependencies & Impact Tab](#11-dependencies--impact-tab)
12. [Incidents & Changes Tab](#12-incidents--changes-tab)
13. [Detection & Analysis Tab](#13-detection--analysis-tab)
14. [Capacity & Sizing Tab](#14-capacity--sizing-tab)
15. [Cloud Waste Tab](#15-cloud-waste-tab)
16. [Incident Command Tab](#16-incident-command-tab)
17. [Failure Patterns Tab](#17-failure-patterns-tab)
18. [Team Reliability Tab](#18-team-reliability-tab)
19. [Cross-Cutting Features](#19-cross-cutting-features)
20. [Common Workflows](#20-common-workflows)
21. [Settings Reference](#21-settings-reference)

---

## 1. What Is This App?

The **Services Overview App** is a multi-tab SRE command center built on the Dynatrace Platform. It consolidates signals that would otherwise require navigating across multiple Dynatrace apps into a single unified interface:

- **RED metrics** (Rate, Errors, Duration) for every service in your fleet
- **Kubernetes workload health** — containers, nodes, pods, namespaces, clusters
- **Dependency topology** and blast radius simulation
- **SLO error budgets** using the Google SRE multi-window burn-rate model
- **Anomaly detection, anti-pattern detection, and correlation analysis**
- **Capacity planning and right-sizing recommendations**
- **Cloud waste estimation** (AWS and Azure)
- **Incident command co-pilot** with recommended next actions

The app queries your Dynatrace Grail data store in real time. All data shown is derived from your own telemetry — no external services are called.

---

## 2. Getting Started

### First Launch

The first time you open the app you will see an amber **disclaimer modal** reminding you this is not an official product. Dismiss it to proceed. If you check "Don't show again," the modal is suppressed permanently for your user account.

### Timeframe

The global timeframe selector in the top-right of the header controls the lookback window for all queries. The default is **last 7 days**. All tabs respect this selector; changing it refreshes the active tab immediately.

### Data Loading

Each tab loads its queries **lazily** — data is only fetched after you first visit that tab. The initial load after navigation may take a few seconds depending on your fleet size and the selected timeframe.

---

## 3. Header Bar Reference

| Control | Description |
|---------|-------------|
| **Timeframe** | Global time range for all queries (top-right). |
| **Metric-Stream** | Auto-refresh interval: Off / 30 s / 1 min / 5 min / 10 min. A spinner and "Xs ago" timestamp appear while active. |
| **AI Insights** | Toggle the AI analysis panel for the active tab. Shows deterministic observations (good / warning / critical / info) and prioritized recommendations. |
| **Explain** | Toggle Explain Mode. Adds bullet-point reasoning panels to each tab that explain the thresholds and decision logic behind the numbers. |
| **$ / req** | Dollar value per request. Used across the app to calculate revenue-at-risk estimates in Incident Command, Blast Radius, and the Overview KPI bar. |
| **Compare** | Appears on the Metrics, Quality, and Performance tabs. Overlays the previous period's data alongside the current period's data on all charts. |
| **Help (?)** | Opens the in-app help modal. |
| **Settings (gear)** | Opens the Settings modal (see [Section 21](#21-settings-reference)). |

---

## 4. Tab Navigation and Customization

The app uses a three-level tab hierarchy:

- **Top-level tabs** — 14 tabs visible across the top
- **Sub-tabs** — secondary tabs within a top-level tab
- **Sub-sub-tabs** — tertiary tabs within certain sub-tabs (e.g., Blast Radius modes, Right-Sizing modes)

### Showing, Hiding, and Reordering Tabs

All three levels are fully user-configurable:

1. Open **Settings** (gear icon in the header).
2. Go to the **Tab Visibility** section.
3. Toggle any tab on or off, or drag tabs to reorder them.

Changes are saved immediately to your Dynatrace user account and persist across sessions and devices.

---

## 5. Overview Tab

The Overview tab is the primary command center and the recommended starting point for any SRE standup or incident triage.

### KPI Bar

Five configurable metric cards displayed at the top of the page. Each card shows:

- **Current value** with a delta arrow and trend color (green = improving, red = degrading)
- **Inline sparkline** (88 × 28 px) showing the trend over the selected timeframe
- **Drill-through link** that opens the relevant Dynatrace app with entity and timeframe context pre-populated

**To customize the KPI bar:** Click the edit icon on any card to open the KPI selector. Available KPIs include total requests, average/P50/P90/P99 latency, failure rate, 5xx count, 4xx count, active problems, and more. Your selections are saved per user.

**Forecast:** Click anywhere on a sparkline to open the 7-day **Forecast Modal** with six selectable forecasting methods (see [Section 19](#19-cross-cutting-features)).

**Correlations:** Click the `↔` button on any KPI card to open the **Correlations Panel**, which ranks all fleet metrics by Pearson correlation strength against that KPI.

### Services Health Honeycomb

A color-coded tile per service:

- **Green** — healthy (no active problems)
- **Red** — problem detected

Click any tile to jump to that service's details in the Summary Details tab.

### Top 3 Risks

A ranked panel combining three signal types:

1. **Active Davis problems** — problems detected by the Davis AI engine
2. **SLO fast burn alerts** — services burning their error budget faster than the target rate
3. **Anomaly flags** — services whose current metrics deviate significantly from baseline

The three highest-priority items across all three signal types are surfaced here. Each item links to the relevant tab for deeper investigation.

### Problems Table

Full list of active Davis problems with:

- Affected entities
- Problem duration
- Root cause entity (if identified)
- Direct link into the Dynatrace Problems app

---

## 6. Summary Details Tab

### Service Details Sub-tab

The definitive RED metrics table for your fleet. One row per service, showing:

| Column | Description |
|--------|-------------|
| Status | Color-coded: green (no problems), red (active problem) |
| Service Name | Entity name with a link to the Dynatrace service entity |
| Requests | Total request count in the selected timeframe |
| Latency Avg | Average response time |
| Latency P50 / P90 / P99 | Percentile latency values |
| Failure Rate | Percentage of requests that resulted in an error |
| 5xx | Count of HTTP 5xx errors |
| 4xx | Count of HTTP 4xx errors |
| Problems | Count of active Davis problems |
| Owner | Team name from the `dt.owner` tag |
| Runbook | User-defined runbook link per service (click the edit icon to set) |
| Deployments | Recent deployment events for that service, shown inline |

**Setting runbook links:** Click the edit icon in the Runbook column for any service, enter the URL, and save. Links are stored in your Dynatrace user state and shared across users of the same app instance.

### Request Details Sub-tab

Per-endpoint performance data derived from distributed traces. One row per operation name + service combination, showing:

| Column | Description |
|--------|-------------|
| Endpoint | Operation name from the root span |
| Service | Parent service |
| Requests | Span count |
| Latency P50 / P90 / P99 | Percentile latency |
| Failure Rate | Percentage of spans with error status |
| P99 Anomaly | Badge indicating deviation from prior-period baseline: **yellow** = >20% deviation, **red** = >50% deviation |
| Error Breakdown | 5xx / 4xx / timeout / other categorization |

---

## 7. Metrics Tab

### Service Metrics Sub-tab

Time-series charts for up to N services (configurable via `chartTopN` in Settings). Eight chart dimensions are available:

- Requests Total
- Latency P50 / P75 / P90 / P99
- Failed Requests
- Failure Rate %
- HTTP 5xx
- HTTP 4xx
- By Status Code

**Compare Mode:** Toggle the Compare button in the header to overlay the previous period's data as a dashed line on every chart.

**Deployment overlay:** Deployment events are shown as vertical markers on every chart so you can visually correlate releases with metric changes.

### Process Metrics Sub-tab

Infrastructure-level resource consumption per process group instance:

- CPU Usage %
- Memory Usage %
- Memory Used (bytes)
- GC Suspension Time — multi-runtime aware (JVM, CLR, Go, Node.js)

Process restart events are overlaid on the charts as markers.

### K8s Workloads Sub-tab

Container-level CPU and memory vs configured limits, plus:

- **Node Resource Pressure table** — nodes exceeding 85% CPU or memory are flagged as PRESSURE
- **Pod Eviction / OOMKill event stream** — recent Kubernetes eviction and OOMKill events
- **HPA Scaling Events** — horizontal pod autoscaler scale-up and scale-down events
- **Namespace Rollup** — aggregated resource usage summarized per namespace

---

## 8. Reliability Tab

### SLO & Error Budget Sub-tab

Multi-window burn-rate analysis per service using the Google SRE method. For each service, burn rates are computed across four windows: **1 hour, 6 hours, 24 hours, and 72 hours**.

**Status levels:**

| Status | Meaning |
|--------|---------|
| OK | Budget is healthy |
| WARNING | Budget is below 20% remaining |
| EXHAUSTED | Budget is at or below 0% |

The default SLO target is **99.9%** (configurable in Settings via `sloTarget`).

**SLO Composite Groups:** Multiple services can be grouped into a composite SLO. Configure groups in the Settings modal.

### MTTR / MTTA Sub-tab

Mean Time to Resolve and Mean Time to Acknowledge analysis across closed Davis problems:

- **Environment benchmark percentile** — how your MTTR compares to the historical distribution
- **Linear trend forecast** — whether MTTR is improving or worsening over time
- **Repeat Offender tracking** — services that have caused 2 or more problems in the last 30 days are flagged

### Budget Forecast Sub-tab

Projects when each service's error budget will be exhausted at its current burn rate.

| Urgency | Meaning |
|---------|---------|
| EXHAUSTED | Budget is already gone |
| CRITICAL | Budget will be gone in < 24 hours |
| WARNING | Budget will be gone in < 72 hours |
| OK | Budget is healthy |

### Reliability Report Sub-tab

One-click executive summary generation. Click **Generate Report** to:

1. Aggregate a fleet summary, DORA metrics (Change Failure Rate, MTTR quartile), active problems, and SLO status
2. Export the result as a new **Dynatrace Notebook** document

The generated Notebook appears in your Dynatrace environment's Notebooks app with formatted sections and can be shared with stakeholders.

---

## 9. Quality Tab

### Scorecards Sub-tab

Composite health scores per service with letter grades A–F. The score is a weighted average of four dimensions:

| Dimension | Weight |
|-----------|--------|
| Failure Rate | 35% |
| Active Problems | 25% |
| Latency | 20% |
| 5xx Rate | 20% |

**Team Leaderboard:** Services are grouped by `dt.owner` tag. Team scores are averaged across all owned services.

**Compare Mode:** Toggle Compare in the header to overlay previous-period grades alongside current grades.

### Service Maturity Sub-tab

Eight-dimension maturity assessment per service:

1. Reliability
2. Performance
3. SLO Health
4. User Satisfaction
5. Anomaly Resilience
6. Dependency Resilience
7. Error Handling
8. Incident Response

**Maturity levels:** Advanced → Established → Developing → Initial

---

## 10. Performance Tab

### Endpoint Heatmap Sub-tab

An hourly heatmap grid showing per-service metric intensity across every hour of the selected timeframe. Toggle the metric dimension: P50 / P90 / P99 / Error Rate.

Color intensity scales from light (low) to dark (high). Cells with a 2σ deviation from the previous-week baseline are outlined in red, indicating a statistical anomaly at that hour.

### Apdex Sub-tab

Application Performance Index per service, calculated from span data using the T threshold (default 500ms, configurable via `apdexT` in Settings).

**Formula:** `(satisfied + tolerating / 2) / total`  
A span is *satisfied* if duration ≤ T, *tolerating* if duration ≤ 4T, and *frustrated* otherwise.

| Rating | Apdex Score |
|--------|-------------|
| Excellent | ≥ 0.94 |
| Good | 0.85 – 0.93 |
| Fair | 0.70 – 0.84 |
| Poor | 0.50 – 0.69 |
| Unacceptable | < 0.50 |

**Geographic segmentation:** Apdex scores broken down by cloud region.  
**User cohort segmentation:** Scores broken down by Mobile / Internal / Desktop.  
**Compare Mode:** Overlay previous-period Apdex scores.

### Flame Graph Sub-tab

Per-service span distribution profiler. Select a service from the dropdown to visualize how total trace duration is distributed across its operations.

- **Bar width** = that operation's share of total duration
- **Color** = error rate (green = 0%, yellow = 1–5%, red = >5%)
- Displays the top 50 operations by total duration

Use this tab to identify which operations are consuming the most wall-clock time or generating the most errors within a service.

---

## 11. Dependencies & Impact Tab

### Dependencies Sub-tab

An interactive **force-directed topology graph** showing service-to-service call relationships drawn from your distributed trace data.

**Edge color (latency heat):**

| Color | Meaning |
|-------|---------|
| Green | Latency ≤ 2× the P90/P50 ratio — healthy |
| Yellow | Latency 2–3× the ratio — degraded |
| Red | Latency > 3× the ratio — critical |

**Controls:**
- **Hide Healthy** toggle — removes healthy edges so only degraded paths remain visible
- **Change Impact Overlay** — highlights edges whose latency changed after the most recent deployment
- Hover any node or edge for a tooltip with exact metric values
- Click any node for a drill-through link to that service entity in Dynatrace

### Blast Radius Sub-tab

Failure impact simulation that models how a failure in one entity propagates across the fleet using breadth-first search (BFS) with probabilistic cascade weights.

**Nine simulation modes** (selectable via sub-sub-tabs):

| Mode | What is simulated |
|------|------------------|
| Services | Service-to-service call dependency cascade |
| Hosts | Which services would be affected if a host failed |
| Workloads | K8s Deployment/StatefulSet failure impact |
| Clusters | K8s cluster failure impact |
| Namespaces | K8s namespace failure impact |
| Nodes | K8s node failure impact |
| Pods | K8s pod failure impact |
| Containers | K8s container failure impact |
| Cloud Region | Regional outage simulation (AWS / Azure regions) |

**Services mode additional options:**
- **Weighting selector** — choose how failure probability is distributed across edges:
  - *Smart guess* — weighted by historical error rate and call volume
  - *Simple split* — uniform distribution across all dependencies
  - *Real edge %* — uses actual observed error rates per edge

**Business Impact Simulator:** Enter the `$ / req` value in the header. The simulator computes estimated revenue at risk based on the projected request volume lost to the cascade.

**SPOF Scanner:** Identifies Single Points of Failure — entities that, if they failed, would cascade to a disproportionately large fraction of the fleet.

---

## 12. Incidents & Changes Tab

### Incident Timeline Sub-tab

A merged chronological view of **Davis problems** and **deployment events** across the selected timeframe.

- **Root-cause grouping** collapses problems that share the same root cause entity into a single entry
- **Inline annotations** can be added to any timeline event (click the `+` icon)
- **Team assignment** — assign a problem to a team directly from the timeline

### Change Impact Sub-tab

Before/after analysis of each deployment's effect on service metrics. Compares a 2-hour pre-deployment window to a 2-hour post-deployment window.

| Verdict | Meaning |
|---------|---------|
| Regression | Metrics worsened significantly post-deploy |
| Warning | Metrics worsened moderately |
| Healthy | No meaningful change |
| Improved | Metrics improved post-deploy |
| Rollback Signal | Severe regression suggesting a rollback should be considered |

### Deploy Readiness Sub-tab

Pre-flight checklist scoring environment stability across 5 dimensions before a planned deployment.

| Verdict | Score Range |
|---------|-------------|
| GO | ≥ 80 |
| CAUTION | 60 – 79 |
| NO-GO | < 60 |

Use this tab to get a structured readiness signal before pushing a release to production.

### On-Call Health Sub-tab

Analyzes incident patterns over the selected timeframe to assess on-call burden and alert quality. Metrics shown:

| Metric | Description |
|--------|-------------|
| Total Incidents | Davis problem count in the period |
| Peak Hour | Hour of day with the most incidents |
| Peak Day | Day of week with the most incidents |
| Off-Hours % | Percentage of incidents occurring outside business hours |
| Weekend % | Percentage of incidents on weekends |
| Noise % | Incidents that auto-resolved in < 5 minutes (actionable signal vs. noise) |
| Avg MTTR | Mean time to resolve across all incidents in the period |

---

## 13. Detection & Analysis Tab

### Anomaly Detection Sub-tab

Compares current-period service metrics against a baseline period. Services are flagged as anomalous if:

- Latency change > 30%, **or**
- Error rate change > 2 percentage points

**Correlation detection:** Services that show co-occurring anomalies (even without a direct dependency) are grouped together as potentially correlated.

**Suppression rules:** Configure rules to suppress alerts for known noisy services or scheduled maintenance windows.

### Correlation Engine Sub-tab

Detects hidden relationships between services — pairs that degrade simultaneously despite having no direct dependency in your topology.

Uses **Pearson correlation** of failure rate time series across the selected timeframe. A time-lag variant detects cascading failures where one service degrades and another follows N minutes later.

Use this tab when you suspect a dependency that isn't visible in your trace topology (e.g., a shared database or a synchronous out-of-band call).

### Anti-Patterns Sub-tab

Detects four architectural anti-patterns in the dependency graph:

| Anti-Pattern | Detection Criteria |
|-------------|-------------------|
| Circular Dependency | Services that form a cycle in the call graph |
| Deep Call Chain | Chains longer than 3 hops from entry point to leaf |
| Fan-Out Storm | A service that makes calls to more than 5 downstream services |
| Critical Shared Dependency | A service that is called by more than 5 upstream services |

Each detected anti-pattern shows the involved services and a recommendation for remediation.

### Baselines Sub-tab

Snapshot the current metric state for any set of services as a named **baseline**, then compare future measurements against it.

- **Violation streaks** — if a service's metrics exceed the baseline by > 20% for multiple consecutive snapshots, it is flagged as a streak violator
- **CSV export** — export the baseline comparison data for offline analysis

> Note: Baselines are stored in browser localStorage. They are per-browser and are not shared with other users or other devices.

### Alert Rules Sub-tab

Configure custom threshold-based alerting against real-time service data.

**Creating a rule:**
1. Use the guided **wizard** to select a service, metric, comparator, and threshold
2. Or pick from the **template library** for common patterns (e.g., "failure rate > 5%", "P99 latency > 2s")

**Managing rules:**
- **Maintenance mode** — temporarily silence a rule without deleting it
- **Noise ratio analysis** — shows how often a rule would have fired historically, so you can tune thresholds before enabling

---

## 14. Capacity & Sizing Tab

### Right-Sizing Sub-tab

Resource optimization recommendations across eight infrastructure tiers (selectable via sub-sub-tabs):

- **Hosts**
- **Databases**
- **K8s Workloads, Clusters, Nodes, Namespaces, Pods, Containers, Services**

| Verdict | CPU Threshold | Memory Threshold |
|---------|--------------|-----------------|
| Under-provisioned | > 80% of limit | > 85% of limit |
| Over-provisioned | < 20% utilization | < 20% utilization |
| Optimal | Everything else | — |

Use this tab to identify candidates for resizing requests to your infrastructure team.

### Traffic Patterns Sub-tab

Request volume pattern analysis for capacity planning:

| Signal | Description |
|--------|-------------|
| Peak Hour | Hour of day with highest request volume |
| Trough Hour | Hour of day with lowest request volume |
| Trend | Compares average volume in the first half of the timeframe vs. the second half |
| Volatility | Coefficient of variation — how "spiky" traffic is |
| Peak-to-Trough Ratio | Multiplier between peak and trough volumes, used to size for burst capacity |

### What-If Sub-tab

Traffic growth and latency degradation simulation across three scenario types:

| Scenario | Model |
|----------|-------|
| Growth Projection | Logarithmic latency model — projects how latency degrades as traffic grows |
| Latency Degradation | Maps P99 → error rate impact at various latency multipliers |
| Combined (Flash Sale) | Combines traffic growth + latency degradation for extreme spike scenarios |

**Capacity Twin Simulator:** Adjust replicas, cache hit rate, and DB connection latency to model infrastructure changes.

**Resource Headroom Timeline:** Shows the projected number of days until various utilization thresholds are breached, assuming 5% weekly traffic growth.

---

## 15. Cloud Waste Tab

Detects dangling cloud resources in AWS and Azure and estimates monthly waste.

### KPI Summary

| KPI | Description |
|-----|-------------|
| Estimated Monthly Waste | Total waste estimate across all providers and resource types |
| AWS Waste | AWS-specific waste estimate |
| Azure Waste | Azure-specific waste estimate |
| Dangling Candidates | Count of resources identified as potentially dangling |

### Top Waste Drivers Table

| Column | Description |
|--------|-------------|
| Provider | AWS or Azure |
| Resource Type | e.g., Load Balancer, Volume, IP Address |
| Signal | The heuristic that flagged this resource (e.g., "no attached instances", "zero traffic") |
| Dangling | Whether the resource is confirmed dangling |
| Confidence | Confidence level of the heuristic (Low / Medium / High) |
| Est. Monthly Cost | Estimated monthly cost of this resource |

> This tab is a **heuristic prioritization tool** for directing manual investigation, not an invoice reconciliation system. Always verify findings in your cloud console before decommissioning resources.

---

## 16. Incident Command Tab

An autonomous incident co-pilot that surfaces the most actionable information during an active incident.

### Information Panels

| Panel | Description |
|-------|-------------|
| Likely Root Cause | The entity most likely causing the incident, linked to the Dynatrace entity, with a confidence percentage |
| Impacted Services | Count of services affected by the current incident |
| Revenue at Risk | Projected revenue impact using the `$ / req` header value and impacted request volume |
| Top Correlated Link | The strongest correlated service pair involved in the incident |

### Recommended Actions

Three ranked next actions are displayed. Switch between three operational modes:

| Mode | Focus |
|------|-------|
| Stabilize | Actions to stop the bleeding and reduce impact immediately |
| Mitigate | Actions to reduce the severity while a fix is prepared |
| Recovery | Actions to safely restore normal service and verify resolution |

Use this tab as your first stop when an active incident is declared.

---

## 17. Failure Patterns Tab

Fleet anomaly fingerprinting. Groups recurring anomaly patterns across services into pattern families.

Each pattern shows:

| Field | Description |
|-------|-------------|
| Pattern Label | A fingerprint label describing the anomaly signature |
| Confidence | Score from 0–100% indicating how strongly this pattern matches |
| Occurrences | How many times this pattern has been observed across the fleet |
| Playbook | Recommended response playbook for this pattern |
| Drill-through | Link to the specific services and timeframes involved |

Use this tab to identify recurring failure modes that may warrant a long-term architectural fix.

---

## 18. Team Reliability Tab

An owner-based reliability leaderboard grouped by the `dt.owner` tag on service entities.

| Column | Description |
|--------|-------------|
| Team | Team name from the `dt.owner` tag |
| Services | Number of services owned by this team |
| Avg Failure Rate | Average failure rate across all owned services |
| At-Risk Services | Count of owned services with active problems or exhausted SLO budgets |
| Deploy Regressions | Count of deployments in the period that received a Regression verdict |
| Reliability Score | Composite score from 0–100 with a color-coded badge |

**Reliability Score color coding:**

| Color | Score Range |
|-------|-------------|
| Green | ≥ 80 |
| Yellow | 60 – 79 |
| Red | < 60 |

---

## 19. Cross-Cutting Features

These features appear across multiple tabs.

### Forecast Modal

Click any sparkline on a KPI card to open a 7-day time-series forecast overlay. Six forecasting methods are available — all computed client-side:

| Method | Best For |
|--------|----------|
| Holt-Winters | Seasonal data with trend |
| Triple Exponential Smoothing | Smooth trends with seasonality |
| Prophet | Complex seasonal patterns |
| ARIMA (5,1,2) | Stationary time series |
| SARIMA (3,1,1) | Seasonal ARIMA |
| Linear Regression | Simple linear trends |

### Correlations Panel

Click the `↔` button on any KPI card to open the Correlations Panel. All fleet metrics are ranked by Pearson correlation coefficient against the selected KPI.

Filter by minimum correlation strength: 30% / 50% / 70%. Use this to find which other metrics move together with the one you're investigating.

### Compare Mode

Available on the Metrics, Quality, and Performance tabs. Toggles an overlay of the previous period's data (using the same duration as the current timeframe, shifted back by that duration) alongside all current-period charts.

### AI Insights Panel

Toggle via the **AI Insights** button in the header. Displays a deterministic analysis panel for the active tab with:

- A summary of current tab state
- Severity-tagged observations (good / warning / critical / info)
- Prioritized recommendations

This analysis is computed from the same data shown in the tab, not a generative model — it applies deterministic rules to surface patterns.

### Explain Mode

Toggle via the **Explain** button in the header. Adds an Explainability Panel to each tab showing bullet-point reasoning for every threshold and decision rule used on that tab. Use this to understand why a service is flagged and to verify the logic before acting on it.

### Annotation Layer

Every chart has a thin annotation strip above the chart area. Click the `+` button to add an annotation:

| Type | Color | Use For |
|------|-------|---------|
| Incident | Red | Mark when an incident was declared |
| Maintenance | Yellow | Mark planned maintenance windows |
| Deployment | Blue | Mark deployment events (manual entry) |
| Note | Grey | General notes tied to a timestamp |

Annotations appear on every chart's timeline strip and are shared across all users of the app (stored in Dynatrace App State).

---

## 20. Common Workflows

### Daily Fleet Health Check (SRE Standup)

1. Open the **Overview** tab — scan the KPI bar and Services Health Honeycomb for immediate red flags.
2. Review the **Top 3 Risks** panel for the highest-priority items.
3. Check the **Problems Table** for active incident details.
4. Click any KPI drill-through link to open the relevant Dynatrace app for deeper context.

### Service Incident Investigation

1. **Overview** — identify the problem in the honeycomb or problems table.
2. **Summary Details → Service Details** — confirm which service is degraded (RED metrics + problem count).
3. **Summary Details → Request Details** — pinpoint which endpoints are failing (P99 anomaly badges).
4. **Dependencies & Impact → Blast Radius** — quantify cascade impact across the fleet.
5. **Incident Command** — get ranked next actions and root cause with confidence.
6. **Detection & Analysis → Correlation Engine** — find hidden correlated services not in the dependency graph.

### Pre-Deployment Readiness Check

1. **Incidents & Changes → Deploy Readiness** — check GO / CAUTION / NO-GO verdict.
2. **Reliability → SLO & Error Budget** — confirm no services are exhausted or on a fast burn rate.
3. **Detection & Analysis → Anomaly Detection** — verify no services are currently anomalous before adding more load.

### Post-Deployment Change Impact Analysis

1. **Incidents & Changes → Change Impact** — review deployment verdicts (Regression / Warning / Healthy / Improved / Rollback Signal).
2. **Incidents & Changes → Incident Timeline** — correlate the deployment timestamp with any subsequent problems.
3. **Metrics → Service Metrics** — inspect the deployment event overlay on timeseries charts.

### SLO Health and Error Budget Management

1. **Reliability → SLO & Error Budget** — check multi-window burn rates, identify services in WARNING or EXHAUSTED state.
2. **Reliability → Budget Forecast** — see projected exhaustion times at current burn rate.
3. **Reliability → MTTR / MTTA** — review historical resolution times and repeat offenders.
4. **Reliability → Reliability Report** — generate and export a Notebook-based executive report.

### Capacity Planning

1. **Capacity & Sizing → Traffic Patterns** — understand peak hours, volatility, and traffic trend direction.
2. **Capacity & Sizing → What-If** — simulate traffic growth scenarios and latency degradation.
3. **Capacity & Sizing → Right-Sizing** — identify over/under-provisioned hosts, K8s workloads, and databases.
4. **Cloud Waste** — identify dangling resources and monthly waste by provider.

### Team Ownership Review

1. **Team Reliability** — view reliability scores and at-risk services grouped by team.
2. **Quality → Scorecards** — drill into individual service grades (A–F) per team.
3. **Quality → Service Maturity** — assess 8-dimension maturity scores across teams.
4. **Detection & Analysis → Alert Rules** — configure team-specific alert thresholds and maintenance windows.

---

## 21. Settings Reference

Open Settings via the gear icon in the header.

### Query Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `topN` | 1000 | Maximum number of records returned in detail tables. Reduce this if queries are slow. |
| `chartTopN` | 10 | Maximum number of series shown in time-series charts. |
| `problemsLookbackHours` | 7 | Hours to look back when querying active Davis problems. |
| `sloTarget` | 99.9% | SLO target threshold used for error budget calculations across all services. |
| `apdexT` | 500ms | Apdex satisfied threshold (T value) in milliseconds. |

### Tab Visibility Manager

Drag-and-drop panel for configuring visibility and ordering at all three tab levels. Changes are saved to your Dynatrace user account immediately.

### Annotation List

View and delete all timeline annotations created by any user. Annotations are stored in Dynatrace App State and are shared across all users.

### Runbook Links

Manage user-defined runbook URLs per service. These links appear inline in the Service Details table.

### SLO Composite Groups

Define composite SLO groups that aggregate the error budget across multiple services into a single SLO view.

---

*For bugs and feature requests, open an issue at [https://github.com/TechShady/services-overview-app](https://github.com/TechShady/services-overview-app).*
