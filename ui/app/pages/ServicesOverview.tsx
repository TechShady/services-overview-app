import React, { useState, useMemo, useCallback } from "react";
import "./ServicesOverview.css";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Strong } from "@dynatrace/strato-components/typography";
import {
  HoneycombChart,
  TimeseriesChart,
} from "@dynatrace/strato-components/charts";
import type { HoneycombTileNumericData } from "@dynatrace/strato-components/charts";
import { CategoricalBarChart, convertToTimeseries } from "@dynatrace/strato-components-preview/charts";
import { Select, TextInput } from "@dynatrace/strato-components-preview/forms";
import { NumberInput } from "@dynatrace/strato-components/forms";
import { DataTable } from "@dynatrace/strato-components-preview/tables";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { Tabs, Tab } from "@dynatrace/strato-components/navigation";
import { Modal } from "@dynatrace/strato-components/overlays";
import { Button } from "@dynatrace/strato-components/buttons";
import { SettingIcon, HelpIcon } from "@dynatrace/strato-icons";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import {
  servicesHealthQuery,
  problemsQuery,
  serviceDetailsQuery,
  requestDetailsQuery,
  requestsTotalQuery,
  latencyP50Query,
  latencyP90Query,
  failedRequestsQuery,
  failureRateQuery,
  http5xxQuery,
  http4xxQuery,
  requestsByStatusCodeQuery,
  processCpuQuery,
  processMemoryPercentQuery,
  processMemoryUsedQuery,
  processGcTimeQuery,
  k8sCpuQuery,
  k8sMemoryQuery,
  deploymentEventsQuery,
  serviceDependenciesQuery,
  closedProblemsQuery,
  anomalyCurrentQuery,
  anomalyBaselineQuery,
  requestsTotalPrevQuery,
  latencyP90PrevQuery,
  failureRatePrevQuery,
  http5xxPrevQuery,
} from "../queries";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GREEN = "#0D9C29";
const YELLOW = "#FCD53F";
const RED = "#C21930";
const DEFAULT_TOP_N = 100;
const DEFAULT_PROBLEMS_LOOKBACK_HOURS = 7;
const DEFAULT_TIMEFRAME_DAYS = 7;
const DEFAULT_CHART_TOP_N = 10;
const DEFAULT_TENANT = "";
const DEFAULT_SLO_TARGET = 99.9;
const NOOP_QUERY = "fetch logs | limit 0";

interface AlertRule {
  id: string;
  metric: string;
  comparator: "gt" | "lt";
  threshold: number;
  serviceName?: string;
}

const ALERT_METRIC_OPTIONS = [
  { label: "Failure Rate %", value: "FailureRate" },
  { label: "Latency Avg (µs)", value: "Latency_Avg" },
  { label: "Latency P90 (µs)", value: "Latency_p90" },
  { label: "5xx Count", value: "5xx" },
  { label: "4xx Count", value: "4xx" },
];

const TIMEFRAME_OPTIONS = [
  { label: "2 hours", value: 0.083 },
  { label: "6 hours", value: 0.25 },
  { label: "1 day", value: 1 },
  { label: "2 days", value: 2 },
  { label: "3 days", value: 3 },
  { label: "7 days", value: 7 },
  { label: "14 days", value: 14 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
  { label: "365 days", value: 365 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function SectionHeader({ title }: { title: string }) {
  return (
    <div className="svc-section-header">
      <Heading level={5}>{title}</Heading>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="svc-loading">
      <ProgressCircle />
    </div>
  );
}

function ChartTile({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="svc-chart-tile">
      <div className="chart-title">{title}</div>
      {description && <div className="chart-description">{description}</div>}
      <div className="chart-body">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
const LINK_STYLE: React.CSSProperties = {
  color: "#6babf5",
  textDecoration: "none",
  cursor: "pointer",
};

export const ServicesOverview = () => {
  const envUrl = getEnvironmentUrl().replace(/\/$/, "");

  // --- State ---
  const [timeframeDays, setTimeframeDays] = useState<number>(DEFAULT_TIMEFRAME_DAYS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Settings state
  const [topN, setTopN] = useState<number>(DEFAULT_TOP_N);
  const [chartTopN, setChartTopN] = useState<number>(DEFAULT_CHART_TOP_N);
  const [problemsLookbackHours, setProblemsLookbackHours] = useState<number>(DEFAULT_PROBLEMS_LOOKBACK_HOURS);
  const [tenantId, setTenantId] = useState<string>(DEFAULT_TENANT);

  // Temp settings (for modal)
  const [tempTopN, setTempTopN] = useState<number>(DEFAULT_TOP_N);
  const [tempChartTopN, setTempChartTopN] = useState<number>(DEFAULT_CHART_TOP_N);
  const [tempProblemsLookback, setTempProblemsLookback] = useState<number>(DEFAULT_PROBLEMS_LOOKBACK_HOURS);
  const [tempTenantId, setTempTenantId] = useState<string>(DEFAULT_TENANT);

  // Column sizing persistence
  const [svcDetailColSizing, setSvcDetailColSizing] = useState<Record<string, number>>({});
  const [reqDetailColSizing, setReqDetailColSizing] = useState<Record<string, number>>({});
  const [problemsColSizing, setProblemsColSizing] = useState<Record<string, number>>({});

  // Enhancement state
  const [compareMode, setCompareMode] = useState(false);
  const [sloTarget, setSloTarget] = useState<number>(DEFAULT_SLO_TARGET);
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [newRuleMetric, setNewRuleMetric] = useState<string>("FailureRate");
  const [newRuleComparator, setNewRuleComparator] = useState<"gt" | "lt">("gt");
  const [newRuleThreshold, setNewRuleThreshold] = useState<number>(5);
  const [newRuleService, setNewRuleService] = useState<string>("");

  // --- Queries ---

  // Overview: Services Health
  const healthResult = useDql({ query: servicesHealthQuery(problemsLookbackHours) });
  const honeycombData: HoneycombTileNumericData[] = useMemo(() => {
    if (!healthResult.data?.records) return [];
    return healthResult.data.records.map((r) => ({
      value: (r["affected"] as string) === "Problem" ? 1 : 0,
      name: (r["entity.name"] as string) ?? "Unknown",
    }));
  }, [healthResult.data]);

  // Overview: Problems
  const problemsResult = useDql({ query: problemsQuery() });
  const problemsData = useMemo(() => {
    if (!problemsResult.data?.records) return [];
    return problemsResult.data.records.map((r) => ({
      Status: r["Status"] as string,
      Description: r["Description"] as string,
      Affected: r["Affected"] as string[],
      RootCause: r["RootCause"] as string,
      StartTime: r["StartTime"] as string,
      EndTime: r["EndTime"] as string,
      Duration: r["Duration"],
      "event.id": r["event.id"] as string,
    }));
  }, [problemsResult.data]);

  // Service Details
  const svcDetailsResult = useDql({
    query: serviceDetailsQuery(topN, problemsLookbackHours, timeframeDays),
  });
  const svcDetailsData = useMemo(() => {
    if (!svcDetailsResult.data?.records) return [];
    return svcDetailsResult.data.records.map((r) => ({
      Status: r["Status"] as string,
      Service: r["Service"] as string,
      "dt.entity.service": r["dt.entity.service"] as string,
      Requests: r["Requests"] as number,
      Latency_Avg: r["Latency_Avg"] as number,
      Latency_p50: r["Latency_p50"] as number,
      Latency_p90: r["Latency_p90"] as number,
      Latency_p99: r["Latency_p99"] as number,
      FailureRate: r["FailureRate"] as number,
      Failures: r["Failures"] as number,
      "5xx": r["5xx"] as number,
      "4xx": r["4xx"] as number,
      "event.id": r["event.id"] as string,
    }));
  }, [svcDetailsResult.data]);

  // Request Details
  const reqDetailsResult = useDql({
    query: requestDetailsQuery(topN, timeframeDays),
  });
  const reqDetailsData = useMemo(() => {
    if (!reqDetailsResult.data?.records) return [];
    return reqDetailsResult.data.records.map((r) => ({
      Service: r["Service"] as string,
      Request: r["Request"] as string,
      "dt.entity.service": r["dt.entity.service"] as string,
      Requests: (r["Requests"] as number) ?? 0,
      Latency_Avg: (r["Latency_Avg"] as number) ?? 0,
      Latency_p50: (r["Latency_p50"] as number) ?? 0,
      Latency_p90: (r["Latency_p90"] as number) ?? 0,
      Latency_p99: (r["Latency_p99"] as number) ?? 0,
      FailureRate: (r["FailureRate"] as number) ?? 0,
      Failures: (r["Failures"] as number) ?? 0,
      "5xx": (r["5xx"] as number) ?? 0,
      "4xx": (r["4xx"] as number) ?? 0,
    }));
  }, [reqDetailsResult.data]);

  // Service metric charts
  const reqTotalResult = useDql({ query: requestsTotalQuery(chartTopN, timeframeDays) });
  const latP50Result = useDql({ query: latencyP50Query(chartTopN, timeframeDays) });
  const latP90Result = useDql({ query: latencyP90Query(chartTopN, timeframeDays) });
  const failedReqResult = useDql({ query: failedRequestsQuery(chartTopN, timeframeDays) });
  const failRateResult = useDql({ query: failureRateQuery(chartTopN, timeframeDays) });
  const http5xxResult = useDql({ query: http5xxQuery(chartTopN, timeframeDays) });
  const http4xxResult = useDql({ query: http4xxQuery(chartTopN, timeframeDays) });
  const statusCodeResult = useDql({ query: requestsByStatusCodeQuery(chartTopN, timeframeDays) });

  // Process metric charts
  const procCpuResult = useDql({ query: processCpuQuery(chartTopN, timeframeDays) });
  const procMemPctResult = useDql({ query: processMemoryPercentQuery(chartTopN, timeframeDays) });
  const procMemUsedResult = useDql({ query: processMemoryUsedQuery(chartTopN, timeframeDays) });
  const procGcResult = useDql({ query: processGcTimeQuery(chartTopN, timeframeDays) });

  // K8s charts
  const k8sCpuResult = useDql({ query: k8sCpuQuery(chartTopN, timeframeDays) });
  const k8sMemResult = useDql({ query: k8sMemoryQuery(chartTopN, timeframeDays) });

  // Enhancement queries
  const deploymentsResult = useDql({ query: deploymentEventsQuery(timeframeDays) });
  const dependenciesResult = useDql({ query: serviceDependenciesQuery() });
  const closedProblemsResult = useDql({ query: closedProblemsQuery(timeframeDays) });
  const anomalyCurrentResult = useDql({ query: anomalyCurrentQuery(timeframeDays) });
  const anomalyBaselineResult = useDql({ query: anomalyBaselineQuery(timeframeDays) });

  // Comparison mode — previous period (no-op when disabled)
  const reqTotalPrev = useDql({ query: compareMode ? requestsTotalPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const latP90Prev = useDql({ query: compareMode ? latencyP90PrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const failRatePrev = useDql({ query: compareMode ? failureRatePrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const http5xxPrev = useDql({ query: compareMode ? http5xxPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });

  // Convert timeseries data for charts using Strato's built-in converter
  const toTs = (result: { data?: { records?: any; types?: any } | null }) =>
    result.data?.records ? convertToTimeseries(result.data.records, result.data.types) : [];

  const reqTotalTs = useMemo(() => toTs(reqTotalResult), [reqTotalResult.data]);
  const latP50Ts = useMemo(() => toTs(latP50Result), [latP50Result.data]);
  const latP90Ts = useMemo(() => toTs(latP90Result), [latP90Result.data]);
  const failedReqTs = useMemo(() => toTs(failedReqResult), [failedReqResult.data]);
  const failRateTs = useMemo(() => toTs(failRateResult), [failRateResult.data]);
  const http5xxTs = useMemo(() => toTs(http5xxResult), [http5xxResult.data]);
  const http4xxTs = useMemo(() => toTs(http4xxResult), [http4xxResult.data]);
  const statusCodeTs = useMemo(() => toTs(statusCodeResult), [statusCodeResult.data]);

  const procCpuTs = useMemo(() => toTs(procCpuResult), [procCpuResult.data]);
  const procMemPctTs = useMemo(() => toTs(procMemPctResult), [procMemPctResult.data]);
  const procMemUsedTs = useMemo(() => toTs(procMemUsedResult), [procMemUsedResult.data]);
  const procGcTs = useMemo(() => toTs(procGcResult), [procGcResult.data]);

  const k8sCpuTs = useMemo(() => toTs(k8sCpuResult), [k8sCpuResult.data]);
  const k8sMemTs = useMemo(() => toTs(k8sMemResult), [k8sMemResult.data]);

  // Comparison mode timeseries
  const reqTotalPrevTs = useMemo(() => toTs(reqTotalPrev), [reqTotalPrev.data]);
  const latP90PrevTs = useMemo(() => toTs(latP90Prev), [latP90Prev.data]);
  const failRatePrevTs = useMemo(() => toTs(failRatePrev), [failRatePrev.data]);
  const http5xxPrevTs = useMemo(() => toTs(http5xxPrev), [http5xxPrev.data]);

  // ─── SLO & Error Budget ───
  const sloData = useMemo(() => {
    if (!svcDetailsData.length) return [];
    const budgetPercent = 100 - sloTarget; // e.g., 0.1% for 99.9%
    const periodMinutes = timeframeDays * 24 * 60;
    return svcDetailsData.map((svc) => {
      const errorRate = (svc.FailureRate as number) ?? 0;
      const budgetUsed = budgetPercent > 0 ? (errorRate / budgetPercent) * 100 : 0;
      const budgetRemaining = Math.max(0, 100 - budgetUsed);
      const burnRate = budgetPercent > 0 ? errorRate / budgetPercent : 0;
      const minutesLeft = burnRate > 0 ? (budgetRemaining / 100) * periodMinutes / burnRate : periodMinutes;
      return {
        Service: svc.Service,
        "Error Rate %": Math.round(errorRate * 1000) / 1000,
        "SLO Target": `${sloTarget}%`,
        "Budget (%)": Math.round(budgetPercent * 10000) / 10000,
        "Budget Used %": Math.round(budgetUsed * 100) / 100,
        "Budget Remaining %": Math.round(budgetRemaining * 100) / 100,
        "Burn Rate": Math.round(burnRate * 100) / 100,
        Status: budgetRemaining <= 0 ? "EXHAUSTED" : budgetUsed >= 80 ? "WARNING" : "OK",
      };
    }).sort((a, b) => (b["Budget Used %"] ?? 0) - (a["Budget Used %"] ?? 0));
  }, [svcDetailsData, sloTarget, timeframeDays]);

  // ─── Service Scorecards ───
  const scorecardData = useMemo(() => {
    if (!svcDetailsData.length) return [];
    return svcDetailsData.map((svc) => {
      const errorRate = (svc.FailureRate as number) ?? 0;
      const latP90 = (svc.Latency_p90 as number) ?? 0;
      const latP50 = (svc.Latency_p50 as number) ?? 0;
      const hasProblem = svc.Status === "PROBLEM";
      const http5xx = (svc["5xx"] as number) ?? 0;
      const requests = (svc.Requests as number) ?? 0;
      const http5xxRate = requests > 0 ? (http5xx / requests) * 100 : 0;
      // Score components (0-100 each)
      const errorScore = Math.max(0, 100 - errorRate * 20); // 5% = 0
      const latencyScore = latP50 > 0 ? Math.max(0, Math.min(100, 100 - ((latP90 / latP50 - 1) * 50))) : 100;
      const problemScore = hasProblem ? 0 : 100;
      const http5xxScore = Math.max(0, 100 - http5xxRate * 100); // 1% = 0
      const score = Math.round(errorScore * 0.35 + latencyScore * 0.2 + problemScore * 0.25 + http5xxScore * 0.2);
      return {
        Service: svc.Service,
        Score: score,
        Grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F",
        "Error Score": Math.round(errorScore),
        "Latency Score": Math.round(latencyScore),
        "Problem Score": Math.round(problemScore),
        "5xx Score": Math.round(http5xxScore),
        Status: svc.Status,
      };
    }).sort((a, b) => b.Score - a.Score);
  }, [svcDetailsData]);

  // ─── Dependencies ───
  const dependenciesData = useMemo(() => {
    if (!dependenciesResult.data?.records) return [];
    return dependenciesResult.data.records.map((r) => ({
      Caller: (r["Caller"] as string) ?? "",
      Callee: (r["Callee"] as string) ?? "",
    }));
  }, [dependenciesResult.data]);

  // ─── Endpoint Heatmap ───
  const endpointHeatmapData: HoneycombTileNumericData[] = useMemo(() => {
    if (!reqDetailsData.length) return [];
    return reqDetailsData.map((r) => ({
      name: `${r.Service} — ${r.Request}`,
      value: (r.FailureRate as number) ?? 0,
    }));
  }, [reqDetailsData]);
  const endpointHeatmapColors = [
    { from: 0, to: 0.5, color: GREEN },
    { from: 0.5, to: 2, color: YELLOW },
    { from: 2, to: 100, color: RED },
  ];

  // ─── MTTR / MTTA ───
  const mttrData = useMemo(() => {
    if (!closedProblemsResult.data?.records) return { problems: [] as any[], mttr: 0, count: 0 };
    const problems = closedProblemsResult.data.records.map((r) => ({
      ID: (r["display_id"] as string) ?? "",
      Problem: (r["event.name"] as string) ?? "",
      Start: r["event.start"] ? new Date(r["event.start"] as string).toLocaleString() : "",
      End: r["event.end"] ? new Date(r["event.end"] as string).toLocaleString() : "",
      "Duration (min)": Math.round(((r["duration_minutes"] as number) ?? 0) * 10) / 10,
      "Root Cause": (r["root_cause_entity_name"] as string) ?? "",
    }));
    const durations = closedProblemsResult.data.records
      .map((r) => (r["duration_minutes"] as number) ?? 0)
      .filter((d) => d > 0);
    const mttr = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    return { problems, mttr, count: durations.length };
  }, [closedProblemsResult.data]);

  // ─── Anomaly Detection ───
  const anomalyData = useMemo(() => {
    const current = anomalyCurrentResult.data?.records;
    const baseline = anomalyBaselineResult.data?.records;
    if (!current || !baseline) return [];
    const baselineMap = new Map<string, Record<string, unknown>>();
    baseline.forEach((r) => { baselineMap.set(r["dt.entity.service"] as string, r); });
    return current.map((r) => {
      const svcId = r["dt.entity.service"] as string;
      const base = baselineMap.get(svcId);
      const curLatency = (r["avgLatencyP90"] as number) ?? 0;
      const curErrorRate = (r["errorRate"] as number) ?? 0;
      const curRequests = (r["avgRequests"] as number) ?? 0;
      const baseLatency = base ? ((base["avgLatencyP90"] as number) ?? 0) : 0;
      const baseErrorRate = base ? ((base["errorRate"] as number) ?? 0) : 0;
      const baseRequests = base ? ((base["avgRequests"] as number) ?? 0) : 0;
      const latencyChange = baseLatency > 0 ? ((curLatency - baseLatency) / baseLatency) * 100 : 0;
      const errorRateChange = baseErrorRate > 0 ? ((curErrorRate - baseErrorRate) / baseErrorRate) * 100 : curErrorRate > 0 ? 100 : 0;
      const requestsChange = baseRequests > 0 ? ((curRequests - baseRequests) / baseRequests) * 100 : 0;
      const isAnomaly = Math.abs(latencyChange) > 50 || Math.abs(errorRateChange) > 100 || curErrorRate > 5;
      return {
        Service: (r["Service"] as string) ?? "",
        "Latency P90 (now)": Math.round(curLatency),
        "Latency P90 (baseline)": Math.round(baseLatency),
        "Latency Change %": Math.round(latencyChange * 10) / 10,
        "Error Rate (now)": Math.round(curErrorRate * 1000) / 1000,
        "Error Rate (baseline)": Math.round(baseErrorRate * 1000) / 1000,
        "Error Rate Change %": Math.round(errorRateChange * 10) / 10,
        "Requests Δ %": Math.round(requestsChange * 10) / 10,
        Anomaly: isAnomaly ? "YES" : "—",
      };
    }).sort((a, b) => (b.Anomaly === "YES" ? 1 : 0) - (a.Anomaly === "YES" ? 1 : 0) || Math.abs(b["Latency Change %"]) - Math.abs(a["Latency Change %"]));
  }, [anomalyCurrentResult.data, anomalyBaselineResult.data]);

  // ─── Deployment Events ───
  const deploymentsData = useMemo(() => {
    if (!deploymentsResult.data?.records) return [];
    return deploymentsResult.data.records.map((r) => ({
      Time: r["timestamp"] ? new Date(r["timestamp"] as string).toLocaleString() : "",
      Event: (r["event.name"] as string) ?? "",
      Service: (r["serviceName"] as string) ?? "",
    }));
  }, [deploymentsResult.data]);

  // ─── Incident Timeline (combined) ───
  const timelineData = useMemo(() => {
    const events: { Time: string; Type: string; Description: string; Status: string; ts: number }[] = [];
    // Add problems
    problemsData.forEach((p) => {
      const ts = p.StartTime ? new Date(p.StartTime).getTime() : 0;
      events.push({ Time: p.StartTime, Type: "Problem", Description: p.Description, Status: p.Status, ts });
    });
    // Add deployments
    deploymentsData.forEach((d) => {
      const ts = d.Time ? new Date(d.Time).getTime() : 0;
      events.push({ Time: d.Time, Type: "Deployment", Description: d.Event, Status: "—", ts });
    });
    return events.sort((a, b) => b.ts - a.ts).map(({ ts, ...rest }) => rest);
  }, [problemsData, deploymentsData]);

  // ─── Alert Rule Evaluation ───
  const alertViolations = useMemo(() => {
    if (!alertRules.length || !svcDetailsData.length) return [];
    const violations: { Rule: string; Service: string; Metric: string; Value: number; Threshold: number }[] = [];
    for (const rule of alertRules) {
      for (const svc of svcDetailsData) {
        if (rule.serviceName && svc.Service !== rule.serviceName) continue;
        const value = (svc as any)[rule.metric] as number ?? 0;
        const violated = rule.comparator === "gt" ? value > rule.threshold : value < rule.threshold;
        if (violated) {
          violations.push({
            Rule: `${rule.metric} ${rule.comparator === "gt" ? ">" : "<"} ${rule.threshold}`,
            Service: svc.Service as string,
            Metric: rule.metric,
            Value: Math.round(value * 1000) / 1000,
            Threshold: rule.threshold,
          });
        }
      }
    }
    return violations;
  }, [alertRules, svcDetailsData]);

  const addAlertRule = useCallback(() => {
    const rule: AlertRule = {
      id: Date.now().toString(),
      metric: newRuleMetric,
      comparator: newRuleComparator,
      threshold: newRuleThreshold,
      serviceName: newRuleService || undefined,
    };
    setAlertRules((prev) => [...prev, rule]);
  }, [newRuleMetric, newRuleComparator, newRuleThreshold, newRuleService]);

  // --- Settings ---
  const handleOpenSettings = () => {
    setTempTopN(topN);
    setTempChartTopN(chartTopN);
    setTempProblemsLookback(problemsLookbackHours);
    setTempTenantId(tenantId);
    setSettingsOpen(true);
  };
  const handleSaveSettings = () => {
    setTopN(tempTopN);
    setChartTopN(tempChartTopN);
    setProblemsLookbackHours(tempProblemsLookback);
    setTenantId(tempTenantId);
    setSettingsOpen(false);
  };

  // --- Column Definitions ---
  const problemsColumns = useMemo(
    () => [
      {
        id: "Status",
        header: "Status",
        accessor: "Status",
        cell: ({ value }: { value: string }) => (
          <span className={`svc-status-badge ${value === "ACTIVE" ? "svc-status-active" : "svc-status-closed"}`}>
            {value}
          </span>
        ),
      },
      {
        id: "Description",
        header: "Description",
        accessor: "Description",
        cell: ({ value, rowData }: { value: string; rowData: any }) => {
          const eventId = rowData["event.id"];
          if (!eventId) return <span>{value}</span>;
          const url = `${envUrl}/ui/apps/dynatrace.davis.problems/problem/${eventId}`;
          return (
            <a href={url} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
              {value}
            </a>
          );
        },
      },
      {
        id: "Affected",
        header: "Affected",
        accessor: "Affected",
        cell: ({ value }: { value: string[] }) => (
          <span>{Array.isArray(value) ? value.join(", ") : String(value ?? "")}</span>
        ),
      },
      { id: "RootCause", header: "Root Cause", accessor: "RootCause" },
      { id: "StartTime", header: "Start Time", accessor: "StartTime" },
      { id: "EndTime", header: "End Time", accessor: "EndTime" },
      { id: "Duration", header: "Duration", accessor: "Duration" },
    ],
    []
  );

  const svcDetailsColumns = useMemo(
    () => [
      {
        id: "Status",
        header: "Status",
        accessor: "Status",
        cell: ({ value }: { value: string }) => (
          <span
            style={{
              display: "inline-block",
              padding: "2px 10px",
              borderRadius: 4,
              fontWeight: 700,
              fontSize: 12,
              background: value === "PROBLEM" ? RED : GREEN,
              color: "#fff",
            }}
          >
            {value === "PROBLEM" ? "PROBLEM" : "HEALTHY"}
          </span>
        ),
      },
      {
        id: "Service",
        header: "Service",
        accessor: "Service",
        cell: ({ value, rowData }: { value: string; rowData: any }) => {
          const svcId = rowData["dt.entity.service"];
          if (!svcId) return <span>{value}</span>;
          const url = `${envUrl}/ui/apps/dynatrace.distributedtracing/explorer?filter=dt.entity.service+%3D+${encodeURIComponent(svcId)}`;
          return (
            <a href={url} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
              {value}
            </a>
          );
        },
      },
      {
        id: "Requests",
        header: "Requests",
        accessor: "Requests",
        columnType: "number" as const,
      },
      { id: "Latency_Avg", header: "Latency Avg", accessor: "Latency_Avg", columnType: "number" as const },
      { id: "Latency_p50", header: "Latency P50", accessor: "Latency_p50", columnType: "number" as const },
      { id: "Latency_p90", header: "Latency P90", accessor: "Latency_p90", columnType: "number" as const },
      { id: "Latency_p99", header: "Latency P99", accessor: "Latency_p99", columnType: "number" as const },
      {
        id: "FailureRate",
        header: "Failure Rate %",
        accessor: "FailureRate",
        columnType: "number" as const,
        thresholds: [
          { comparator: "greater-than-or-equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" },
          { comparator: "greater-than-or-equal-to" as const, value: 2, backgroundColor: RED, color: "#fff" },
        ],
      },
      {
        id: "Failures",
        header: "Failures",
        accessor: "Failures",
        columnType: "number" as const,
        thresholds: [
          { comparator: "greater-than-or-equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" },
          { comparator: "greater-than-or-equal-to" as const, value: 1, backgroundColor: RED, color: "#fff" },
        ],
      },
      {
        id: "5xx",
        header: "5xx",
        accessor: "5xx",
        columnType: "number" as const,
        thresholds: [
          { comparator: "equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" },
          { comparator: "greater-than" as const, value: 0, backgroundColor: RED, color: "#fff" },
        ],
      },
      {
        id: "4xx",
        header: "4xx",
        accessor: "4xx",
        columnType: "number" as const,
        thresholds: [
          { comparator: "equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" },
          { comparator: "greater-than" as const, value: 0, backgroundColor: RED, color: "#fff" },
        ],
      },
    ],
    []
  );

  const reqDetailsColumns = useMemo(
    () => [
      {
        id: "Service",
        header: "Service",
        accessor: "Service",
        cell: ({ value, rowData }: { value: string; rowData: any }) => {
          const svcId = rowData["dt.entity.service"];
          if (!svcId) return <span>{value}</span>;
          const url = `${envUrl}/ui/apps/dynatrace.distributedtracing/explorer?filter=dt.entity.service+%3D+${encodeURIComponent(svcId)}`;
          return (
            <a href={url} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
              {value}
            </a>
          );
        },
      },
      {
        id: "Request",
        header: "Request",
        accessor: "Request",
        cell: ({ value, rowData }: { value: string; rowData: any }) => {
          const svcId = rowData["dt.entity.service"];
          if (!svcId || !value) return <span>{value}</span>;
          const url = `${envUrl}/ui/apps/dynatrace.distributedtracing/explorer?filter=dt.entity.service+%3D+${encodeURIComponent(svcId)}+AND+endpoint.name+%3D+${encodeURIComponent(value)}`;
          return (
            <a href={url} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
              {value}
            </a>
          );
        },
      },
      { id: "Requests", header: "Requests", accessor: "Requests", columnType: "number" as const },
      { id: "Latency_Avg", header: "Latency Avg", accessor: "Latency_Avg", columnType: "number" as const },
      { id: "Latency_p50", header: "Latency P50", accessor: "Latency_p50", columnType: "number" as const },
      { id: "Latency_p90", header: "Latency P90", accessor: "Latency_p90", columnType: "number" as const },
      { id: "Latency_p99", header: "Latency P99", accessor: "Latency_p99", columnType: "number" as const },
      {
        id: "FailureRate",
        header: "Failure Rate %",
        accessor: "FailureRate",
        columnType: "number" as const,
        thresholds: [
          { comparator: "greater-than-or-equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" },
          { comparator: "greater-than-or-equal-to" as const, value: 1, backgroundColor: YELLOW, color: "#000" },
          { comparator: "greater-than-or-equal-to" as const, value: 2, backgroundColor: RED, color: "#fff" },
        ],
      },
      {
        id: "Failures",
        header: "Failures",
        accessor: "Failures",
        columnType: "number" as const,
        thresholds: [
          { comparator: "greater-than-or-equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" },
          { comparator: "greater-than-or-equal-to" as const, value: 1, backgroundColor: RED, color: "#fff" },
        ],
      },
      {
        id: "5xx",
        header: "5xx",
        accessor: "5xx",
        columnType: "number" as const,
        thresholds: [
          { comparator: "equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" },
          { comparator: "greater-than" as const, value: 0, backgroundColor: RED, color: "#fff" },
        ],
      },
      {
        id: "4xx",
        header: "4xx",
        accessor: "4xx",
        columnType: "number" as const,
        thresholds: [
          { comparator: "equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" },
          { comparator: "greater-than" as const, value: 0, backgroundColor: YELLOW, color: "#000" },
        ],
      },
    ],
    []
  );

  // Honeycomb custom colors: 0 = Healthy (green), 1 = Problem (red)
  const honeycombColorRanges = [
    { from: 0, to: 0.5, color: GREEN },
    { from: 0.5, to: 2, color: RED },
  ];

  return (
    <div className="svc-overview">
      {/* ---- Filter Bar ---- */}
      <div className="svc-filter-bar">
        <Flex gap={16} alignItems="flex-end" flexWrap="wrap">
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "flex-end" }}>
            <Flex flexDirection="column" gap={4} style={{ minWidth: 140 }}>
              <Strong>Timeframe</Strong>
              <Select
                value={timeframeDays}
                onChange={(val) => {
                  if (val != null) setTimeframeDays(val as number);
                }}
              >
                <Select.Content>
                  {TIMEFRAME_OPTIONS.map((opt) => (
                    <Select.Option key={opt.value} value={opt.value}>
                      {opt.label}
                    </Select.Option>
                  ))}
                </Select.Content>
              </Select>
            </Flex>

            <Button variant="default" onClick={() => setHelpOpen(true)}>
              <Button.Prefix>
                <HelpIcon />
              </Button.Prefix>
            </Button>
            <Button variant={compareMode ? "emphasized" : "default"} onClick={() => setCompareMode(!compareMode)}>
              {compareMode ? "Compare: ON" : "Compare"}
            </Button>
            <Button variant="default" onClick={handleOpenSettings}>
              <Button.Prefix>
                <SettingIcon />
              </Button.Prefix>
            </Button>
          </div>
        </Flex>
      </div>

      {/* ---- Settings Modal ---- */}
      <Modal
        title="Settings"
        show={settingsOpen}
        onDismiss={() => setSettingsOpen(false)}
        size="small"
        footer={
          <Flex justifyContent="flex-end" gap={8}>
            <Button variant="emphasized" onClick={handleSaveSettings}>
              Save
            </Button>
          </Flex>
        }
      >
        <Flex flexDirection="column" gap={16} padding={16}>
          <Flex flexDirection="column" gap={4}>
            <Strong>Dynatrace Tenant ID</Strong>
            <input
              type="text"
              value={tempTenantId}
              onChange={(e) => setTempTenantId(e.target.value)}
              placeholder="e.g. abc12345"
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid rgba(99,130,191,0.3)",
                background: "rgba(30,35,55,0.8)",
                color: "#fff",
                fontSize: 13,
              }}
            />
          </Flex>
          <Flex flexDirection="column" gap={4}>
            <Strong>Table Top N (max rows)</Strong>
            <NumberInput value={tempTopN} onChange={(val) => setTempTopN(val ?? DEFAULT_TOP_N)} min={1} max={10000} />
          </Flex>
          <Flex flexDirection="column" gap={4}>
            <Strong>Chart Top N (max series)</Strong>
            <NumberInput
              value={tempChartTopN}
              onChange={(val) => setTempChartTopN(val ?? DEFAULT_CHART_TOP_N)}
              min={1}
              max={100}
            />
          </Flex>
          <Flex flexDirection="column" gap={4}>
            <Strong>Problems Lookback (hours)</Strong>
            <NumberInput
              value={tempProblemsLookback}
              onChange={(val) => setTempProblemsLookback(val ?? DEFAULT_PROBLEMS_LOOKBACK_HOURS)}
              min={1}
              max={720}
            />
          </Flex>
          <Flex flexDirection="column" gap={4}>
            <Strong>SLO Target (%)</Strong>
            <NumberInput
              value={sloTarget}
              onChange={(val) => setSloTarget(val ?? DEFAULT_SLO_TARGET)}
              min={90}
              max={100}
            />
          </Flex>
        </Flex>
      </Modal>

      {/* ---- Help Modal ---- */}
      <Modal title="Services Overview — Help Guide" show={helpOpen} onDismiss={() => setHelpOpen(false)} size="large">
        <div className="svc-help-content">
          <h3>Overview</h3>
          <p>
            The <strong>Services Overview</strong> app provides Observability SREs with a unified view of service health,
            request analytics, latency distributions, error rates, process-level resource usage, and Kubernetes workload
            metrics. It consolidates the key RED metrics (Rate, Errors, Duration) alongside infrastructure telemetry into
            a single pane of glass.
          </p>

          <h3>Filter Bar</h3>
          <ul>
            <li>
              <strong>Service</strong> — Multi-select dropdown with search. Filter all views to specific services. When
              empty, all services are shown.
            </li>
            <li>
              <strong>Timeframe</strong> — Controls the analysis window for all queries (2 hours to 365 days).
            </li>
            <li>
              <strong>Settings (⚙)</strong> — Configure Tenant ID, Table/Chart row limits, and Problems lookback window.
            </li>
          </ul>

          <h3>Tab: Overview</h3>
          <h4>Services Health (Honeycomb)</h4>
          <p>
            Each hexagon represents a service. <span style={{ color: GREEN }}>■ Green</span> = Healthy,{" "}
            <span style={{ color: RED }}>■ Red</span> = Active Problem. The honeycomb checks for active Davis problems
            over the configured lookback window (default: {DEFAULT_PROBLEMS_LOOKBACK_HOURS}h).
          </p>
          <h4>Problems List</h4>
          <p>
            Active and recently closed Davis problems with affected entities, root cause, duration, and status. Sorted by
            active-first, then by start time descending.
          </p>

          <h3>Tab: Service Details</h3>
          <p>
            Comprehensive table with one row per service showing aggregated metrics over the selected timeframe:
          </p>
          <table>
            <thead>
              <tr>
                <th>Column</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Status</td><td>PROBLEM (active Davis problem) or HEALTHY</td></tr>
              <tr><td>Service</td><td>Service entity name</td></tr>
              <tr><td>Requests</td><td>Total request count</td></tr>
              <tr><td>Latency Avg / P50 / P90 / P99</td><td>Response time percentiles (µs)</td></tr>
              <tr><td>Failure Rate %</td><td>Failures / Requests × 100</td></tr>
              <tr><td>Failures</td><td>Total failed request count</td></tr>
              <tr><td>5xx / 4xx</td><td>HTTP 5xx and 4xx error counts</td></tr>
            </tbody>
          </table>
          <h4>Color Thresholds</h4>
          <table>
            <thead>
              <tr>
                <th>Column</th>
                <th style={{ color: GREEN }}>Green</th>
                <th style={{ color: YELLOW }}>Yellow</th>
                <th style={{ color: RED }}>Red</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Failure Rate</td><td>0%</td><td>—</td><td>≥ 2%</td></tr>
              <tr><td>Failures</td><td>0</td><td>—</td><td>≥ 1</td></tr>
              <tr><td>5xx</td><td>0</td><td>—</td><td>≥ 1</td></tr>
              <tr><td>4xx</td><td>0</td><td>—</td><td>≥ 1</td></tr>
              <tr><td>Status</td><td>HEALTHY</td><td>—</td><td>PROBLEM</td></tr>
            </tbody>
          </table>

          <h3>Tab: Request Details</h3>
          <p>
            Per-endpoint breakdown derived from distributed traces (<code>fetch spans</code>). Each row is a unique
            Service + Endpoint combination with request count, latency percentiles, failure rate, and HTTP error counts.
          </p>
          <h4>Color Thresholds</h4>
          <table>
            <thead>
              <tr>
                <th>Column</th>
                <th style={{ color: GREEN }}>Green</th>
                <th style={{ color: YELLOW }}>Yellow</th>
                <th style={{ color: RED }}>Red</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Failure Rate</td><td>0%</td><td>≥ 1%</td><td>≥ 2%</td></tr>
              <tr><td>Failures</td><td>0</td><td>—</td><td>≥ 1</td></tr>
              <tr><td>5xx</td><td>0</td><td>—</td><td>&gt; 0</td></tr>
              <tr><td>4xx</td><td>0</td><td>&gt; 0</td><td>—</td></tr>
            </tbody>
          </table>

          <h3>Tab: Service Metrics</h3>
          <p>
            Timeseries line charts for the top services (configurable in Settings):
          </p>
          <ul>
            <li><strong>Requests Total</strong> — <code>dt.service.request.count</code></li>
            <li><strong>Latency P50 / P90</strong> — <code>dt.service.request.response_time</code> percentiles</li>
            <li><strong>Failed Requests</strong> — <code>dt.service.request.failure_count</code></li>
            <li><strong>Failure Rate %</strong> — failures / total × 100</li>
            <li><strong>5xx / 4xx Errors</strong> — requests filtered by HTTP status code ranges</li>
            <li><strong>Requests by Status Code</strong> — stacked by <code>http.response.status_code</code></li>
          </ul>

          <h3>Tab: Process Metrics</h3>
          <p>
            Top processes by resource usage:
          </p>
          <ul>
            <li><strong>CPU Usage %</strong> — <code>dt.process.cpu.usage</code></li>
            <li><strong>Memory Usage %</strong> — <code>dt.process.memory.usage</code></li>
            <li><strong>Memory Used</strong> — <code>dt.process.memory.working_set_size</code></li>
            <li><strong>GC Suspension Time</strong> — JVM, CLR, Go, Node.js garbage collection</li>
          </ul>

          <h3>Tab: K8s Workloads</h3>
          <p>
            Kubernetes workload resource consumption:
          </p>
          <ul>
            <li><strong>CPU Usage</strong> — <code>dt.kubernetes.container.cpu_usage</code></li>
            <li><strong>Memory Working Set</strong> — <code>dt.kubernetes.container.memory_working_set</code> plus limits overlay</li>
          </ul>

          <h3>Settings</h3>
          <table>
            <thead>
              <tr>
                <th>Setting</th>
                <th>Default</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Dynatrace Tenant ID</td><td>(auto)</td><td>Environment ID for deep-link URLs</td></tr>
              <tr><td>Table Top N</td><td>{DEFAULT_TOP_N}</td><td>Max rows in Service/Request detail tables</td></tr>
              <tr><td>Chart Top N</td><td>{DEFAULT_CHART_TOP_N}</td><td>Max series per timeseries chart</td></tr>
              <tr><td>Problems Lookback</td><td>{DEFAULT_PROBLEMS_LOOKBACK_HOURS}h</td><td>Hours to look back for active problems</td></tr>
              <tr><td>SLO Target</td><td>{DEFAULT_SLO_TARGET}%</td><td>SLO target for error budget calculations</td></tr>
            </tbody>
          </table>

          <h3>New Features</h3>

          <h4>Compare Mode</h4>
          <p>Toggle the <strong>Compare</strong> button in the filter bar to show previous-period timeseries charts below the current Service Metrics. Compares the selected timeframe against the equivalent prior period.</p>

          <h4>Deployment Correlation</h4>
          <p>When deployment events (<code>CUSTOM_DEPLOYMENT</code>) exist, they appear at the top of the Service Metrics tab as a table. Correlate deploys with latency spikes or error increases.</p>

          <h4>SLO & Error Budget</h4>
          <p>Computes error budgets based on the configured SLO target. Shows budget consumption, burn rate, and status (OK / WARNING / EXHAUSTED) per service. Configurable SLO target in Settings.</p>

          <h4>Service Scorecards</h4>
          <p>Composite health score (0–100) per service, weighted: Error Rate (35%), Latency P90/P50 ratio (20%), Problem Status (25%), 5xx Rate (20%). Grades: A (≥90), B (≥75), C (≥60), D (≥40), F (&lt;40).</p>

          <h4>Dependencies</h4>
          <p>Pulls service-to-service call relationships from entity data. Shows Caller → Callee pairs with counts of unique callers and callees.</p>

          <h4>Endpoint Heatmap</h4>
          <p>Honeycomb visualization of endpoint failure rates. Green (&lt;0.5%), Yellow (0.5–2%), Red (&gt;2%). Quickly identify which endpoints are experiencing failures.</p>

          <h4>MTTR / MTTA</h4>
          <p>Mean Time To Resolve computed from closed Davis problems. Shows average resolution time in minutes and hours with per-problem breakdown. Color thresholds: Green (&lt;30m), Yellow (30–120m), Red (&gt;120m).</p>

          <h4>Anomaly Detection</h4>
          <p>Compares current period vs a 4× baseline period. Flags anomalies when: latency change &gt;50%, error rate change &gt;100%, or error rate &gt;5%. No ML — simple threshold deviation detection.</p>

          <h4>Incident Timeline</h4>
          <p>Combines Davis problems and deployment events into a single chronological view. See the full sequence: deploy → spike → problem opened → resolved.</p>

          <h4>Alert Rules</h4>
          <p>Define custom threshold rules (e.g., "Failure Rate &gt; 5%"). Rules are evaluated against current Service Details data. Violations are shown in real-time. Rules persist for the current session.</p>

          <h3>Tips for SREs</h3>
          <ul>
            <li>Use the <strong>Service filter</strong> to narrow down to services you own.</li>
            <li>Check <strong>Overview → Problems</strong> first to see active incidents.</li>
            <li>Use <strong>Service Details</strong> to compare failure rates across all services at a glance.</li>
            <li>Drill into <strong>Request Details</strong> to find the specific endpoints driving errors.</li>
            <li>Correlate <strong>Process Metrics</strong> with service latency to identify resource bottlenecks.</li>
            <li>Use <strong>Scorecards</strong> for a quick health ranking of all services.</li>
            <li>Check <strong>SLO & Error Budget</strong> to see which services are burning through their budget.</li>
            <li>Use <strong>Anomaly Detection</strong> to catch regressions vs baseline.</li>
            <li>Set up <strong>Alert Rules</strong> for metrics you care about — violations highlight instantly.</li>
            <li>Column widths are remembered within each tab session — resize to your preference.</li>
          </ul>
        </div>
      </Modal>

      {/* ---- Main Content ---- */}
      <Flex flexDirection="column" padding={16} gap={16}>
        <Tabs>
          {/* ═══════════════════════ Overview ═══════════════════════ */}
          <Tab title="Overview">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Services Status & Problems" />
              <div className="svc-overview-row">
                <div className="svc-honeycomb-tile">
                  <Heading level={6}>Services (Current Status)</Heading>
                  {healthResult.isLoading ? (
                    <LoadingState />
                  ) : (
                    <HoneycombChart
                      data={honeycombData}
                      colorScheme={honeycombColorRanges}
                      showLabels
                      height="100%"
                    >
                      <HoneycombChart.Legend hidden />
                    </HoneycombChart>
                  )}
                </div>
                <div className="svc-table-tile">
                  <Heading level={6}>Problems</Heading>
                  {problemsResult.isLoading ? (
                    <LoadingState />
                  ) : (
                    <DataTable
                      data={problemsData}
                      columns={problemsColumns}
                      sortable
                      resizable
                      columnSizing={problemsColSizing}
                      onColumnSizingChange={setProblemsColSizing}
                    >
                      <DataTable.Pagination defaultPageSize={10} />
                    </DataTable>
                  )}
                </div>
              </div>
            </Flex>
          </Tab>

          {/* ═══════════════════════ Service Details ═══════════════════════ */}
          <Tab title="Service Details">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Service Summary" />
              {svcDetailsResult.isLoading ? (
                <LoadingState />
              ) : (
                <div className="svc-table-tile">
                  <DataTable
                    data={svcDetailsData}
                    columns={svcDetailsColumns}
                    sortable
                    resizable
                    columnSizing={svcDetailColSizing}
                    onColumnSizingChange={setSvcDetailColSizing}
                  >
                    <DataTable.Pagination defaultPageSize={25} />
                  </DataTable>
                </div>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ Request Details ═══════════════════════ */}
          <Tab title="Request Details">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Request Summary" />
              {reqDetailsResult.isLoading ? (
                <LoadingState />
              ) : (
                <div className="svc-table-tile">
                  <DataTable
                    data={reqDetailsData}
                    columns={reqDetailsColumns}
                    sortable
                    resizable
                    columnSizing={reqDetailColSizing}
                    onColumnSizingChange={setReqDetailColSizing}
                  >
                    <DataTable.Pagination defaultPageSize={25} />
                  </DataTable>
                </div>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ Service Metrics ═══════════════════════ */}
          <Tab title="Service Metrics">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              {/* Deployment Events Banner */}
              {deploymentsData.length > 0 && (
                <>
                  <SectionHeader title={`Recent Deployments (${deploymentsData.length})`} />
                  <div className="svc-table-tile">
                    <DataTable
                      data={deploymentsData.slice(0, 10)}
                      columns={[
                        { id: "Time", header: "Time", accessor: "Time" },
                        { id: "Event", header: "Deployment", accessor: "Event" },
                        { id: "Service", header: "Service", accessor: "Service" },
                      ]}
                      sortable
                    >
                      <DataTable.Pagination defaultPageSize={5} />
                    </DataTable>
                  </div>
                </>
              )}

              <SectionHeader title="Metrics" />
              <div className="svc-chart-grid-4">
                <ChartTile title="Requests Total" description="Sum of dt.service.request.count by service">
                  <TimeseriesChart data={reqTotalTs as any} loading={reqTotalResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile title="Latency P50" description="Median response time (µs)">
                  <TimeseriesChart data={latP50Ts as any} loading={latP50Result.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile title="Latency P90" description="90th percentile response time (µs)">
                  <TimeseriesChart data={latP90Ts as any} loading={latP90Result.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile title="Failure Rate %" description="Failure percentage by service">
                  <TimeseriesChart data={failRateTs as any} loading={failRateResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
              </div>
              <div className="svc-chart-grid-4">
                <ChartTile title="Requests by Status Code" description="Grouped by http.response.status_code">
                  <TimeseriesChart data={statusCodeTs as any} loading={statusCodeResult.isLoading} variant="bar" gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile title="Failed Requests" description="Sum of dt.service.request.failure_count">
                  <TimeseriesChart data={failedReqTs as any} loading={failedReqResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile title="5xx Errors" description="HTTP 500-599 responses">
                  <TimeseriesChart data={http5xxTs as any} loading={http5xxResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile title="4xx Errors" description="HTTP 400-499 responses">
                  <TimeseriesChart data={http4xxTs as any} loading={http4xxResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
              </div>

              {/* Comparison Mode — Previous Period */}
              {compareMode && (
                <>
                  <SectionHeader title="Previous Period Comparison" />
                  <div className="svc-chart-grid-4">
                    <ChartTile title="Requests Total (Previous)" description="Previous period">
                      <TimeseriesChart data={reqTotalPrevTs as any} loading={reqTotalPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </ChartTile>
                    <ChartTile title="Latency P90 (Previous)" description="Previous period">
                      <TimeseriesChart data={latP90PrevTs as any} loading={latP90Prev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </ChartTile>
                    <ChartTile title="Failure Rate % (Previous)" description="Previous period">
                      <TimeseriesChart data={failRatePrevTs as any} loading={failRatePrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </ChartTile>
                    <ChartTile title="5xx Errors (Previous)" description="Previous period">
                      <TimeseriesChart data={http5xxPrevTs as any} loading={http5xxPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </ChartTile>
                  </div>
                </>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ Process Metrics ═══════════════════════ */}
          <Tab title="Process Metrics">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Process Resource Usage" />
              <div className="svc-chart-grid-2">
                <ChartTile title="Process CPU Usage %" description="avg(dt.process.cpu.usage) by process & host">
                  <TimeseriesChart data={procCpuTs as any} loading={procCpuResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile title="Process Memory Usage %" description="avg(dt.process.memory.usage) by process & host">
                  <TimeseriesChart data={procMemPctTs as any} loading={procMemPctResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile title="Process Memory Used" description="avg(dt.process.memory.working_set_size)">
                  <TimeseriesChart data={procMemUsedTs as any} loading={procMemUsedResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile title="GC Suspension Time %" description="JVM, CLR, Go, Node.js GC pause time">
                  <TimeseriesChart data={procGcTs as any} loading={procGcResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
              </div>
            </Flex>
          </Tab>

          {/* ═══════════════════════ K8s Workloads ═══════════════════════ */}
          <Tab title="K8s Workloads">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Kubernetes Workload Metrics" />
              <div className="svc-chart-grid-2">
                <ChartTile title="K8s Workload CPU Usage" description="avg(dt.kubernetes.container.cpu_usage) by workload">
                  <TimeseriesChart data={k8sCpuTs as any} loading={k8sCpuResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
                <ChartTile
                  title="K8s Workload Memory Usage"
                  description="Working set memory + limits per workload"
                >
                  <TimeseriesChart data={k8sMemTs as any} loading={k8sMemResult.isLoading} gapPolicy="connect">
                    <TimeseriesChart.Legend hidden />
                  </TimeseriesChart>
                </ChartTile>
              </div>
            </Flex>
          </Tab>

          {/* ═══════════════════════ SLO & Error Budget ═══════════════════════ */}
          <Tab title="SLO & Error Budget">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title={`SLO: ${sloTarget}% — Error Budget Analysis`} />
              <Flex gap={16} flexWrap="wrap">
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Services at Risk</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: RED }}>{sloData.filter((s) => s.Status !== "OK").length}</div>
                </div>
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Budget Exhausted</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: RED }}>{sloData.filter((s) => s.Status === "EXHAUSTED").length}</div>
                </div>
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Warning</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: YELLOW }}>{sloData.filter((s) => s.Status === "WARNING").length}</div>
                </div>
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Healthy</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: GREEN }}>{sloData.filter((s) => s.Status === "OK").length}</div>
                </div>
              </Flex>
              {svcDetailsResult.isLoading ? <LoadingState /> : (
                <div className="svc-table-tile">
                  <DataTable
                    data={sloData}
                    columns={[
                      { id: "Service", header: "Service", accessor: "Service" },
                      { id: "ErrorRate", header: "Error Rate %", accessor: "Error Rate %", columnType: "number" as const },
                      { id: "SloTarget", header: "SLO Target", accessor: "SLO Target" },
                      { id: "BudgetUsed", header: "Budget Used %", accessor: "Budget Used %", columnType: "number" as const,
                        thresholds: [
                          { comparator: "less-than" as const, value: 80, backgroundColor: GREEN, color: "#000" },
                          { comparator: "greater-than-or-equal-to" as const, value: 80, backgroundColor: YELLOW, color: "#000" },
                          { comparator: "greater-than-or-equal-to" as const, value: 100, backgroundColor: RED, color: "#fff" },
                        ] },
                      { id: "BudgetRem", header: "Budget Remaining %", accessor: "Budget Remaining %", columnType: "number" as const },
                      { id: "BurnRate", header: "Burn Rate", accessor: "Burn Rate", columnType: "number" as const,
                        thresholds: [
                          { comparator: "less-than" as const, value: 1, backgroundColor: GREEN, color: "#000" },
                          { comparator: "greater-than-or-equal-to" as const, value: 1, backgroundColor: YELLOW, color: "#000" },
                          { comparator: "greater-than-or-equal-to" as const, value: 2, backgroundColor: RED, color: "#fff" },
                        ] },
                      { id: "Status", header: "Status", accessor: "Status",
                        cell: ({ value }: { value: string }) => (
                          <span className={`svc-status-badge ${value === "EXHAUSTED" ? "svc-status-active" : value === "WARNING" ? "" : "svc-status-closed"}`}
                            style={value === "WARNING" ? { background: YELLOW, color: "#000" } : undefined}>
                            {value}
                          </span>
                        ) },
                    ]}
                    sortable
                    resizable
                  >
                    <DataTable.Pagination defaultPageSize={25} />
                  </DataTable>
                </div>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ Service Scorecards ═══════════════════════ */}
          <Tab title="Scorecards">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Service Health Scorecards" />
              <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 12 }}>
                <div className="chart-description">
                  Composite score (0–100): Error Rate (35%) + Latency Ratio (20%) + Problem Status (25%) + 5xx Rate (20%)
                </div>
              </div>
              {svcDetailsResult.isLoading ? <LoadingState /> : (
                <div className="svc-table-tile">
                  <DataTable
                    data={scorecardData}
                    columns={[
                      { id: "Service", header: "Service", accessor: "Service" },
                      { id: "Score", header: "Score", accessor: "Score", columnType: "number" as const,
                        thresholds: [
                          { comparator: "less-than" as const, value: 60, backgroundColor: RED, color: "#fff" },
                          { comparator: "greater-than-or-equal-to" as const, value: 60, backgroundColor: YELLOW, color: "#000" },
                          { comparator: "greater-than-or-equal-to" as const, value: 75, backgroundColor: GREEN, color: "#000" },
                        ] },
                      { id: "Grade", header: "Grade", accessor: "Grade",
                        cell: ({ value }: { value: string }) => (
                          <div style={{ textAlign: "center", width: "100%" }}>
                            <span style={{ fontWeight: 700, fontSize: 16, color: value === "A" ? GREEN : value === "B" ? "#4CAF50" : value === "C" ? YELLOW : RED }}>
                              {value}
                            </span>
                          </div>
                        ) },
                      { id: "ErrorScore", header: "Error (35%)", accessor: "Error Score", columnType: "number" as const },
                      { id: "LatencyScore", header: "Latency (20%)", accessor: "Latency Score", columnType: "number" as const },
                      { id: "ProblemScore", header: "Problem (25%)", accessor: "Problem Score", columnType: "number" as const },
                      { id: "5xxScore", header: "5xx (20%)", accessor: "5xx Score", columnType: "number" as const },
                      { id: "Status", header: "Status", accessor: "Status",
                        cell: ({ value }: { value: string }) => (
                          <span className={`svc-status-badge ${value === "PROBLEM" ? "svc-status-active" : "svc-status-closed"}`}>
                            {value}
                          </span>
                        ) },
                    ]}
                    sortable
                    resizable
                  >
                    <DataTable.Pagination defaultPageSize={25} />
                  </DataTable>
                </div>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ Dependencies ═══════════════════════ */}
          <Tab title="Dependencies">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Service Dependency Map" />
              {dependenciesResult.isLoading ? <LoadingState /> : dependenciesData.length === 0 ? (
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 32, textAlign: "center" }}>
                  <Strong>No service dependencies found</Strong>
                </div>
              ) : (
                <>
                  <Flex gap={16} flexWrap="wrap">
                    <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                      <div className="chart-title">Total Dependencies</div>
                      <div style={{ fontSize: 32, fontWeight: 700, color: "#4589FF" }}>{dependenciesData.length}</div>
                    </div>
                    <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                      <div className="chart-title">Unique Callers</div>
                      <div style={{ fontSize: 32, fontWeight: 700, color: "#4589FF" }}>{new Set(dependenciesData.map((d) => d.Caller)).size}</div>
                    </div>
                    <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                      <div className="chart-title">Unique Callees</div>
                      <div style={{ fontSize: 32, fontWeight: 700, color: "#4589FF" }}>{new Set(dependenciesData.map((d) => d.Callee)).size}</div>
                    </div>
                  </Flex>
                  <div className="svc-table-tile">
                    <DataTable
                      data={dependenciesData}
                      columns={[
                        { id: "Caller", header: "Caller (→)", accessor: "Caller" },
                        { id: "Callee", header: "Callee", accessor: "Callee" },
                      ]}
                      sortable
                      resizable
                    >
                      <DataTable.Pagination defaultPageSize={25} />
                    </DataTable>
                  </div>
                </>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ Endpoint Heatmap ═══════════════════════ */}
          <Tab title="Endpoint Heatmap">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Endpoint Failure Rate Heatmap" />
              <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 12 }}>
                <div className="chart-description">
                  Each hexagon = one endpoint. Color: <span style={{ color: GREEN }}>■ &lt;0.5%</span>{" "}
                  <span style={{ color: YELLOW }}>■ 0.5–2%</span>{" "}
                  <span style={{ color: RED }}>■ &gt;2%</span> failure rate
                </div>
              </div>
              {reqDetailsResult.isLoading ? <LoadingState /> : endpointHeatmapData.length === 0 ? (
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 32, textAlign: "center" }}>
                  <Strong>No endpoint data available</Strong>
                </div>
              ) : (
                <div className="svc-honeycomb-tile">
                  <HoneycombChart
                    data={endpointHeatmapData}
                    colorScheme={endpointHeatmapColors}
                    showLabels
                  >
                    <HoneycombChart.Legend hidden />
                  </HoneycombChart>
                </div>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ MTTR / MTTA ═══════════════════════ */}
          <Tab title="MTTR / MTTA">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Mean Time To Resolve (MTTR)" />
              <Flex gap={16} flexWrap="wrap">
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Closed Problems</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: "#4589FF" }}>{mttrData.count}</div>
                </div>
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">MTTR (avg minutes)</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: mttrData.mttr > 120 ? RED : mttrData.mttr > 30 ? YELLOW : GREEN }}>
                    {Math.round(mttrData.mttr * 10) / 10}
                  </div>
                </div>
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">MTTR (hours)</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: mttrData.mttr > 120 ? RED : mttrData.mttr > 30 ? YELLOW : GREEN }}>
                    {Math.round((mttrData.mttr / 60) * 100) / 100}
                  </div>
                </div>
              </Flex>
              {closedProblemsResult.isLoading ? <LoadingState /> : mttrData.problems.length === 0 ? (
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 32, textAlign: "center" }}>
                  <Strong>No closed problems found in the selected timeframe</Strong>
                </div>
              ) : (
                <div className="svc-table-tile">
                  <DataTable
                    data={mttrData.problems}
                    columns={[
                      { id: "ID", header: "ID", accessor: "ID" },
                      { id: "Problem", header: "Problem", accessor: "Problem" },
                      { id: "Start", header: "Start", accessor: "Start" },
                      { id: "End", header: "End", accessor: "End" },
                      { id: "Duration", header: "Duration (min)", accessor: "Duration (min)", columnType: "number" as const,
                        thresholds: [
                          { comparator: "less-than" as const, value: 30, backgroundColor: GREEN, color: "#000" },
                          { comparator: "greater-than-or-equal-to" as const, value: 30, backgroundColor: YELLOW, color: "#000" },
                          { comparator: "greater-than-or-equal-to" as const, value: 120, backgroundColor: RED, color: "#fff" },
                        ] },
                      { id: "RootCause", header: "Root Cause", accessor: "Root Cause" },
                    ]}
                    sortable
                    resizable
                  >
                    <DataTable.Pagination defaultPageSize={15} />
                  </DataTable>
                </div>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ Anomaly Detection ═══════════════════════ */}
          <Tab title="Anomaly Detection">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Anomaly Detection — Current vs Baseline" />
              <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 12 }}>
                <div className="chart-description">
                  Compares current period metrics against a 4× baseline. Flags services with latency change &gt;50%, error rate change &gt;100%, or error rate &gt;5%.
                </div>
              </div>
              <Flex gap={16} flexWrap="wrap">
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Anomalies Detected</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: anomalyData.filter((a) => a.Anomaly === "YES").length > 0 ? RED : GREEN }}>
                    {anomalyData.filter((a) => a.Anomaly === "YES").length}
                  </div>
                </div>
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Services Analyzed</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: "#4589FF" }}>{anomalyData.length}</div>
                </div>
              </Flex>
              {anomalyCurrentResult.isLoading || anomalyBaselineResult.isLoading ? <LoadingState /> : anomalyData.length === 0 ? (
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 32, textAlign: "center" }}>
                  <Strong>No data for anomaly comparison</Strong>
                </div>
              ) : (
                <div className="svc-table-tile">
                  <DataTable
                    data={anomalyData}
                    columns={[
                      { id: "Service", header: "Service", accessor: "Service" },
                      { id: "Anomaly", header: "Anomaly", accessor: "Anomaly",
                        cell: ({ value }: { value: string }) => (
                          <span style={{ fontWeight: 700, color: value === "YES" ? RED : GREEN }}>{value}</span>
                        ) },
                      { id: "LatNow", header: "Latency P90 (now)", accessor: "Latency P90 (now)", columnType: "number" as const },
                      { id: "LatBase", header: "Latency P90 (base)", accessor: "Latency P90 (baseline)", columnType: "number" as const },
                      { id: "LatChange", header: "Latency Δ %", accessor: "Latency Change %", columnType: "number" as const,
                        thresholds: [
                          { comparator: "less-than" as const, value: 50, backgroundColor: GREEN, color: "#000" },
                          { comparator: "greater-than-or-equal-to" as const, value: 50, backgroundColor: RED, color: "#fff" },
                        ] },
                      { id: "ErrNow", header: "Error Rate (now)", accessor: "Error Rate (now)", columnType: "number" as const },
                      { id: "ErrBase", header: "Error Rate (base)", accessor: "Error Rate (baseline)", columnType: "number" as const },
                      { id: "ErrChange", header: "Error Δ %", accessor: "Error Rate Change %", columnType: "number" as const },
                      { id: "ReqChange", header: "Requests Δ %", accessor: "Requests Δ %", columnType: "number" as const },
                    ]}
                    sortable
                    resizable
                  >
                    <DataTable.Pagination defaultPageSize={25} />
                  </DataTable>
                </div>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ Incident Timeline ═══════════════════════ */}
          <Tab title="Incident Timeline">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Incident Timeline — Problems & Deployments" />
              <Flex gap={16} flexWrap="wrap">
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Problems</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: RED }}>{timelineData.filter((t) => t.Type === "Problem").length}</div>
                </div>
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Deployments</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: "#4589FF" }}>{timelineData.filter((t) => t.Type === "Deployment").length}</div>
                </div>
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                  <div className="chart-title">Total Events</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: "#fff" }}>{timelineData.length}</div>
                </div>
              </Flex>
              {timelineData.length === 0 ? (
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 32, textAlign: "center" }}>
                  <Strong>No events in the selected timeframe</Strong>
                </div>
              ) : (
                <div className="svc-table-tile">
                  <DataTable
                    data={timelineData}
                    columns={[
                      { id: "Time", header: "Time", accessor: "Time" },
                      { id: "Type", header: "Type", accessor: "Type",
                        cell: ({ value }: { value: string }) => (
                          <span style={{ fontWeight: 700, color: value === "Problem" ? RED : "#4589FF" }}>{value}</span>
                        ) },
                      { id: "Description", header: "Description", accessor: "Description" },
                      { id: "Status", header: "Status", accessor: "Status",
                        cell: ({ value }: { value: string }) => (
                          <span className={`svc-status-badge ${value === "ACTIVE" ? "svc-status-active" : value === "CLOSED" ? "svc-status-closed" : ""}`}>
                            {value}
                          </span>
                        ) },
                    ]}
                    sortable
                    resizable
                  >
                    <DataTable.Pagination defaultPageSize={25} />
                  </DataTable>
                </div>
              )}
            </Flex>
          </Tab>

          {/* ═══════════════════════ Alert Rules ═══════════════════════ */}
          <Tab title="Alert Rules">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Custom Alert Rules" />

              {/* Rule Builder */}
              <div className="svc-table-tile">
                <Heading level={6}>Create Rule</Heading>
                <Flex gap={12} alignItems="flex-end" flexWrap="wrap" style={{ paddingTop: 8 }}>
                  <Flex flexDirection="column" gap={4} style={{ minWidth: 160 }}>
                    <Strong>Metric</Strong>
                    <Select value={newRuleMetric} onChange={(val) => { if (val) setNewRuleMetric(val as string); }}>
                      <Select.Content>
                        {ALERT_METRIC_OPTIONS.map((opt) => (
                          <Select.Option key={opt.value} value={opt.value}>{opt.label}</Select.Option>
                        ))}
                      </Select.Content>
                    </Select>
                  </Flex>
                  <Flex flexDirection="column" gap={4} style={{ minWidth: 100 }}>
                    <Strong>Comparator</Strong>
                    <Select value={newRuleComparator} onChange={(val) => { if (val) setNewRuleComparator(val as "gt" | "lt"); }}>
                      <Select.Content>
                        <Select.Option value="gt">Greater than</Select.Option>
                        <Select.Option value="lt">Less than</Select.Option>
                      </Select.Content>
                    </Select>
                  </Flex>
                  <Flex flexDirection="column" gap={4} style={{ minWidth: 100 }}>
                    <Strong>Threshold</Strong>
                    <NumberInput value={newRuleThreshold} onChange={(val) => setNewRuleThreshold(val ?? 0)} />
                  </Flex>
                  <Flex flexDirection="column" gap={4} style={{ minWidth: 200 }}>
                    <Strong>Service (optional)</Strong>
                    <input
                      type="text"
                      value={newRuleService}
                      onChange={(e) => setNewRuleService(e.target.value)}
                      placeholder="All services"
                      style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(99,130,191,0.3)", background: "rgba(30,35,55,0.8)", color: "#fff", fontSize: 13 }}
                    />
                  </Flex>
                  <Button variant="emphasized" onClick={addAlertRule}>Add Rule</Button>
                </Flex>
              </div>

              {/* Active Rules */}
              {alertRules.length > 0 && (
                <>
                  <Heading level={6}>Active Rules ({alertRules.length})</Heading>
                  <div className="svc-table-tile">
                    <DataTable
                      data={alertRules.map((r) => ({
                        ID: r.id,
                        Metric: r.metric,
                        Condition: `${r.comparator === "gt" ? ">" : "<"} ${r.threshold}`,
                        Service: r.serviceName || "All",
                      }))}
                      columns={[
                        { id: "Metric", header: "Metric", accessor: "Metric" },
                        { id: "Condition", header: "Condition", accessor: "Condition" },
                        { id: "Service", header: "Service", accessor: "Service" },
                        { id: "Remove", header: "Action", accessor: "ID",
                          cell: ({ value }: { value: string }) => (
                            <Button variant="default" onClick={() => setAlertRules((prev) => prev.filter((r) => r.id !== value))}>
                              Remove
                            </Button>
                          ) },
                      ]}
                      sortable
                    />
                  </div>
                </>
              )}

              {/* Violations */}
              <SectionHeader title={`Violations (${alertViolations.length})`} />
              {alertViolations.length === 0 ? (
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 32, textAlign: "center" }}>
                  <Strong style={{ color: GREEN }}>{alertRules.length === 0 ? "No rules defined — add a rule above" : "No violations — all services within thresholds"}</Strong>
                </div>
              ) : (
                <div className="svc-table-tile">
                  <DataTable
                    data={alertViolations}
                    columns={[
                      { id: "Service", header: "Service", accessor: "Service" },
                      { id: "Rule", header: "Rule", accessor: "Rule" },
                      { id: "Value", header: "Current Value", accessor: "Value", columnType: "number" as const },
                      { id: "Threshold", header: "Threshold", accessor: "Threshold", columnType: "number" as const },
                    ]}
                    sortable
                    resizable
                  >
                    <DataTable.Pagination defaultPageSize={25} />
                  </DataTable>
                </div>
              )}
            </Flex>
          </Tab>
        </Tabs>
      </Flex>
    </div>
  );
};
