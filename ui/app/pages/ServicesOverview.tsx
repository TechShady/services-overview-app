import React, { useState, useMemo, useCallback } from "react";
import "./ServicesOverview.css";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Strong, Text } from "@dynatrace/strato-components/typography";
import {
  HoneycombChart,
  TimeseriesChart,
} from "@dynatrace/strato-components/charts";
import type { HoneycombTileNumericData } from "@dynatrace/strato-components/charts";
import { CategoricalBarChart, convertToTimeseries } from "@dynatrace/strato-components-preview/charts";
import { Select, TextInput } from "@dynatrace/strato-components-preview/forms";
import { NumberInput, Switch } from "@dynatrace/strato-components/forms";
import { DataTable } from "@dynatrace/strato-components-preview/tables";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { Tabs, Tab } from "@dynatrace/strato-components/navigation";
import { Modal } from "@dynatrace/strato-components/overlays";
import { Button } from "@dynatrace/strato-components/buttons";
import { SettingIcon, HelpIcon, MaximizeIcon, MinimizeIcon, CompareIcon, XmarkIcon, DocumentIcon } from "@dynatrace/strato-icons";
import { useDql, useUserAppState, useSetUserAppState } from "@dynatrace-sdk/react-hooks";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { documentsClient } from "@dynatrace-sdk/client-document";
import { ServiceTopology } from "../components/ServiceTopology";
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
  changeImpactMetricsQuery,
  serviceDependenciesQuery,
  closedProblemsQuery,
  anomalyCurrentQuery,
  anomalyBaselineQuery,
  requestsTotalPrevQuery,
  latencyP50PrevQuery,
  latencyP90PrevQuery,
  failedRequestsPrevQuery,
  failureRatePrevQuery,
  http5xxPrevQuery,
  http4xxPrevQuery,
  requestsByStatusCodePrevQuery,
  processCpuPrevQuery,
  processMemoryPercentPrevQuery,
  processMemoryUsedPrevQuery,
  processGcTimePrevQuery,
  k8sCpuPrevQuery,
  k8sMemoryPrevQuery,
  apdexQuery,
  apdexPrevQuery,
  scorecardPrevQuery,
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
const DEFAULT_APDEX_T = 500; // ms
const NOOP_QUERY = "fetch logs | limit 0";

const TAB_KEYS = [
  "Overview", "Service Details", "Request Details", "Service Metrics",
  "Process Metrics", "K8s Workloads", "SLO & Error Budget", "Scorecards",
  "Dependencies", "Endpoint Heatmap", "MTTR / MTTA", "Anomaly Detection",
  "Incident Timeline", "Change Impact", "Apdex", "Baselines", "Alert Rules", "What-If",
] as const;
type TabKey = typeof TAB_KEYS[number];
const DEFAULT_TAB_VISIBILITY: Record<TabKey, boolean> =
  Object.fromEntries(TAB_KEYS.map(k => [k, true])) as Record<TabKey, boolean>;
const TAB_STATE_KEY = "svc-tab-visibility";
const TAB_ORDER_STATE_KEY = "svc-tab-order";
const DEFAULT_TAB_ORDER: TabKey[] = [...TAB_KEYS];
const COMPARE_TABS: TabKey[] = ["Service Metrics", "Process Metrics", "K8s Workloads", "Scorecards", "Apdex"];

interface AlertRule {
  id: string;
  metric: string;
  comparator: "gt" | "lt";
  threshold: number;
  serviceName?: string;
}

interface ServiceBaselineSnapshot {
  service: string;
  latencyAvg: number;
  latencyP50: number;
  latencyP90: number;
  latencyP99: number;
  failureRate: number;
}

interface ServiceBaseline {
  id: number;
  name: string;
  timestamp: string;
  services: ServiceBaselineSnapshot[];
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
  const [maximized, setMaximized] = useState(false);
  return (
    <>
      {maximized && (
        <div className="svc-chart-overlay" onClick={() => setMaximized(false)}>
          <div className="svc-chart-maximized" onClick={(e) => e.stopPropagation()}>
            <div className="chart-title-row">
              <div className="chart-title">{title}</div>
              <button className="svc-chart-toggle" onClick={() => setMaximized(false)} title="Minimize">
                <MinimizeIcon />
              </button>
            </div>
            {description && <div className="chart-description">{description}</div>}
            <div className="chart-body">{children}</div>
          </div>
        </div>
      )}
      <div className="svc-chart-tile">
        <div className="chart-title-row">
          <div className="chart-title">{title}</div>
          <button className="svc-chart-toggle" onClick={() => setMaximized(true)} title="Maximize">
            <MaximizeIcon />
          </button>
        </div>
        {description && <div className="chart-description">{description}</div>}
        <div className="chart-body">{children}</div>
      </div>
    </>
  );
}

function CompareChartTile({
  title,
  description,
  currentTitle,
  currentChart,
  children,
}: {
  title: string;
  description?: string;
  currentTitle: string;
  currentChart: React.ReactNode;
  children: React.ReactNode;
}) {
  const [maximized, setMaximized] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  return (
    <>
      {splitOpen && (
        <div className="svc-chart-overlay" onClick={() => setSplitOpen(false)}>
          <div className="svc-compare-split" onClick={(e) => e.stopPropagation()}>
            <div className="svc-compare-half">
              <div className="chart-title-row">
                <div className="chart-title">{currentTitle}</div>
                <span className="chart-tag">Current</span>
              </div>
              <div className="chart-body">{currentChart}</div>
            </div>
            <div className="svc-compare-half">
              <div className="chart-title-row">
                <div className="chart-title">{title}</div>
                <span className="chart-tag">Previous</span>
              </div>
              <div className="chart-body">{children}</div>
            </div>
            <button className="svc-compare-close" onClick={() => setSplitOpen(false)} title="Close">
              <XmarkIcon />
            </button>
          </div>
        </div>
      )}
      {maximized && (
        <div className="svc-chart-overlay" onClick={() => setMaximized(false)}>
          <div className="svc-chart-maximized" onClick={(e) => e.stopPropagation()}>
            <div className="chart-title-row">
              <div className="chart-title">{title}</div>
              <button className="svc-chart-toggle" onClick={() => setMaximized(false)} title="Minimize">
                <MinimizeIcon />
              </button>
            </div>
            {description && <div className="chart-description">{description}</div>}
            <div className="chart-body">{children}</div>
          </div>
        </div>
      )}
      <div className="svc-chart-tile">
        <div className="chart-title-row">
          <div className="chart-title">{title}</div>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="svc-chart-toggle" onClick={() => setSplitOpen(true)} title="Compare side-by-side">
              <CompareIcon />
            </button>
            <button className="svc-chart-toggle" onClick={() => setMaximized(true)} title="Maximize">
              <MaximizeIcon />
            </button>
          </div>
        </div>
        {description && <div className="chart-description">{description}</div>}
        <div className="chart-body">{children}</div>
      </div>
    </>
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

/** Reusable cell renderer that links a service name to Distributed Traces */
const makeServiceLinkCell = (envUrl: string) =>
  ({ value, rowData }: { value: string; rowData: any }) => {
    const svcId = rowData["dt.entity.service"];
    if (!svcId) return <span>{value}</span>;
    const url = `${envUrl}/ui/apps/dynatrace.distributedtracing/explorer?filter=dt.entity.service+%3D+${encodeURIComponent(svcId)}`;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
        {value}
      </a>
    );
  };

// ---------------------------------------------------------------------------
// What-If Analysis Tab
// ---------------------------------------------------------------------------
const TRAFFIC_CHANGE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function MultiplierSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Flex flexDirection="column" gap={8} style={{ marginBottom: 12 }}>
      <Flex gap={12} alignItems="center">
        <Strong>Traffic Multiplier:</Strong>
        <Strong style={{ color: "#4589ff", fontSize: 16 }}>{value}x</Strong>
      </Flex>
      <input
        type="range"
        min={0}
        max={TRAFFIC_CHANGE_OPTIONS.length - 1}
        value={TRAFFIC_CHANGE_OPTIONS.indexOf(value)}
        onChange={(e) => onChange(TRAFFIC_CHANGE_OPTIONS[Number(e.target.value)])}
        style={{ width: "100%", cursor: "pointer" }}
      />
      <div style={{ position: "relative", width: "100%", height: 16 }}>
        {TRAFFIC_CHANGE_OPTIONS.map((v, i) => (
          <span key={v} style={{ position: "absolute", left: `${(i / (TRAFFIC_CHANGE_OPTIONS.length - 1)) * 100}%`, transform: "translateX(-50%)", fontSize: 10, color: v === value ? "#4589ff" : "rgba(255,255,255,0.35)", fontWeight: v === value ? 700 : 400, whiteSpace: "nowrap" }}>{v}x</span>
        ))}
      </div>
    </Flex>
  );
}

function formatDuration(us: number): string {
  if (us == null || isNaN(us)) return "N/A";
  if (us >= 1_000_000) return (us / 1_000_000).toFixed(2) + " s";
  if (us >= 1_000) return (us / 1_000).toFixed(1) + " ms";
  return us.toFixed(0) + " µs";
}

function formatCount(val: number): string {
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
  if (val >= 1_000) return (val / 1_000).toFixed(1) + "k";
  return val.toLocaleString();
}

interface WhatIfProps {
  svcDetailsData: Array<{
    Service: string;
    "dt.entity.service": string;
    Requests: number;
    Latency_Avg: number;
    Latency_p50: number;
    Latency_p90: number;
    Latency_p99: number;
    FailureRate: number;
    Failures: number;
    "5xx": number;
    "4xx": number;
    Status: string;
    "event.id": string;
  }>;
  reqDetailsData: Array<{
    Service: string;
    Request: string;
    "dt.entity.service": string;
    Requests: number;
    Latency_Avg: number;
    Latency_p50: number;
    Latency_p90: number;
    Latency_p99: number;
    FailureRate: number;
    Failures: number;
    "5xx": number;
    "4xx": number;
  }>;
  svcLoading: boolean;
  reqLoading: boolean;
  envUrl: string;
  serviceLinkCell: any;
}

function WhatIfTab({ svcDetailsData, reqDetailsData, svcLoading, reqLoading, envUrl, serviceLinkCell }: WhatIfProps) {
  const [trafficMultiplier, setTrafficMultiplier] = useState(1);
  const multiplier = trafficMultiplier;
  const trafficPercent = (trafficMultiplier - 1) * 100;

  const totalRequests = useMemo(() => svcDetailsData.reduce((s, r) => s + (r.Requests ?? 0), 0), [svcDetailsData]);
  const totalFailures = useMemo(() => svcDetailsData.reduce((s, r) => s + (r.Failures ?? 0), 0), [svcDetailsData]);
  const avgLatency = useMemo(() => {
    if (!svcDetailsData.length) return 0;
    return svcDetailsData.reduce((s, r) => s + (r.Latency_Avg ?? 0), 0) / svcDetailsData.length;
  }, [svcDetailsData]);
  const avgP50 = useMemo(() => {
    if (!svcDetailsData.length) return 0;
    return svcDetailsData.reduce((s, r) => s + (r.Latency_p50 ?? 0), 0) / svcDetailsData.length;
  }, [svcDetailsData]);
  const avgP90 = useMemo(() => {
    if (!svcDetailsData.length) return 0;
    return svcDetailsData.reduce((s, r) => s + (r.Latency_p90 ?? 0), 0) / svcDetailsData.length;
  }, [svcDetailsData]);
  const errRate = useMemo(() => (totalRequests > 0 ? (totalFailures / totalRequests) * 100 : 0), [totalRequests, totalFailures]);

  const projectedLatency = avgLatency * (1 + Math.log2(multiplier) * 0.3);
  const projectedP50 = avgP50 * (1 + Math.log2(multiplier) * 0.25);
  const projectedP90 = avgP90 * (1 + Math.log2(multiplier) * 0.5);
  const projectedErrors = Math.round(totalFailures * multiplier * (1 + Math.log2(multiplier) * 0.1));

  const topEndpoints = useMemo(() =>
    [...reqDetailsData]
      .sort((a, b) => (b.Latency_p90 ?? 0) * (b.Requests ?? 0) - (a.Latency_p90 ?? 0) * (a.Requests ?? 0))
      .slice(0, 20),
    [reqDetailsData]
  );

  const metricBoxStyle = (bg: string): React.CSSProperties => ({
    background: bg,
    borderRadius: 10,
    padding: "16px 24px",
    minWidth: 160,
    flex: "1 1 160px",
  });

  return (
    <Flex flexDirection="column" gap={16} paddingTop={16}>
      <SectionHeader title="Current Baseline" />
      <Flex gap={16} flexWrap="wrap">
        <div className="svc-chart-tile" style={{ flex: "1 1 140px", minHeight: "auto", padding: "16px 20px" }}>
          <Text style={{ fontSize: 12, opacity: 0.7 }}>Total Requests</Text>
          {svcLoading ? <LoadingState /> : <Heading level={2} style={{ margin: "8px 0 0" }}>{formatCount(totalRequests)}</Heading>}
        </div>
        <div className="svc-chart-tile" style={{ flex: "1 1 140px", minHeight: "auto", padding: "16px 20px" }}>
          <Text style={{ fontSize: 12, opacity: 0.7 }}>Avg Latency</Text>
          {svcLoading ? <LoadingState /> : <Heading level={2} style={{ color: avgLatency / 1000 >= 500 ? RED : avgLatency / 1000 >= 100 ? YELLOW : GREEN, margin: "8px 0 0" }}>{formatDuration(avgLatency)}</Heading>}
        </div>
        <div className="svc-chart-tile" style={{ flex: "1 1 140px", minHeight: "auto", padding: "16px 20px" }}>
          <Text style={{ fontSize: 12, opacity: 0.7 }}>P50 Latency</Text>
          {svcLoading ? <LoadingState /> : <Heading level={2} style={{ margin: "8px 0 0" }}>{formatDuration(avgP50)}</Heading>}
        </div>
        <div className="svc-chart-tile" style={{ flex: "1 1 140px", minHeight: "auto", padding: "16px 20px" }}>
          <Text style={{ fontSize: 12, opacity: 0.7 }}>P90 Latency</Text>
          {svcLoading ? <LoadingState /> : <Heading level={2} style={{ color: avgP90 / 1000 >= 500 ? RED : avgP90 / 1000 >= 100 ? YELLOW : GREEN, margin: "8px 0 0" }}>{formatDuration(avgP90)}</Heading>}
        </div>
        <div className="svc-chart-tile" style={{ flex: "1 1 140px", minHeight: "auto", padding: "16px 20px" }}>
          <Text style={{ fontSize: 12, opacity: 0.7 }}>Error Rate</Text>
          {svcLoading ? <LoadingState /> : <Heading level={2} style={{ color: errRate >= 5 ? RED : errRate >= 1 ? YELLOW : GREEN, margin: "8px 0 0" }}>{errRate.toFixed(2)}%</Heading>}
        </div>
      </Flex>

      <SectionHeader title="Growth Projection" />
      <div className="svc-table-tile" style={{ padding: 20 }}>
        <MultiplierSlider value={trafficMultiplier} onChange={setTrafficMultiplier} />

        <Flex gap={16} flexWrap="wrap" alignItems="stretch">
          {/* Flux Capacitor */}
          <Flex flexDirection="column" alignItems="center" justifyContent="center" style={{ background: "rgba(69,137,255,0.04)", borderRadius: 10, padding: "8px 12px", minWidth: 100 }}>
            <svg width="80" height="80" viewBox="0 0 120 120" style={{ opacity: 0.85 }}>
              <rect x="10" y="10" width="100" height="100" rx="14" fill="none" stroke="rgba(99,130,191,0.4)" strokeWidth="2.5" />
              <rect x="16" y="16" width="88" height="88" rx="10" fill="rgba(20,24,40,0.9)" stroke="rgba(69,137,255,0.25)" strokeWidth="1" />
              <circle cx="60" cy="60" r="8" fill="rgba(69,137,255,0.15)" stroke="#4589ff" strokeWidth="2">
                <animate attributeName="r" values="7;10;7" dur="2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.8;1;0.8" dur="2s" repeatCount="indefinite" />
              </circle>
              <circle cx="60" cy="60" r="3" fill="#4589ff">
                <animate attributeName="fill" values="#4589ff;#fff;#4589ff" dur="1.5s" repeatCount="indefinite" />
              </circle>
              <line x1="60" y1="52" x2="60" y2="24" stroke="#4589ff" strokeWidth="3" strokeLinecap="round">
                <animate attributeName="stroke" values="#4589ff;#82b1ff;#4589ff" dur="1.2s" repeatCount="indefinite" />
              </line>
              <circle cx="60" cy="22" r="4" fill="none" stroke="#4589ff" strokeWidth="1.5">
                <animate attributeName="r" values="3;5;3" dur="1.2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="1;0.4;1" dur="1.2s" repeatCount="indefinite" />
              </circle>
              <line x1="54" y1="64" x2="30" y2="92" stroke="#4589ff" strokeWidth="3" strokeLinecap="round">
                <animate attributeName="stroke" values="#4589ff;#82b1ff;#4589ff" dur="1.2s" begin="0.4s" repeatCount="indefinite" />
              </line>
              <circle cx="28" cy="94" r="4" fill="none" stroke="#4589ff" strokeWidth="1.5">
                <animate attributeName="r" values="3;5;3" dur="1.2s" begin="0.4s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="1;0.4;1" dur="1.2s" begin="0.4s" repeatCount="indefinite" />
              </circle>
              <line x1="66" y1="64" x2="90" y2="92" stroke="#4589ff" strokeWidth="3" strokeLinecap="round">
                <animate attributeName="stroke" values="#4589ff;#82b1ff;#4589ff" dur="1.2s" begin="0.8s" repeatCount="indefinite" />
              </line>
              <circle cx="92" cy="94" r="4" fill="none" stroke="#4589ff" strokeWidth="1.5">
                <animate attributeName="r" values="3;5;3" dur="1.2s" begin="0.8s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="1;0.4;1" dur="1.2s" begin="0.8s" repeatCount="indefinite" />
              </circle>
              <path d="M60 24 Q45 42 60 52" fill="none" stroke="rgba(69,137,255,0.3)" strokeWidth="1" strokeDasharray="3,3">
                <animate attributeName="strokeDashoffset" values="0;-12" dur="0.8s" repeatCount="indefinite" />
              </path>
              <path d="M30 92 Q42 72 54 64" fill="none" stroke="rgba(69,137,255,0.3)" strokeWidth="1" strokeDasharray="3,3">
                <animate attributeName="strokeDashoffset" values="0;-12" dur="0.8s" begin="0.3s" repeatCount="indefinite" />
              </path>
              <path d="M90 92 Q78 72 66 64" fill="none" stroke="rgba(69,137,255,0.3)" strokeWidth="1" strokeDasharray="3,3">
                <animate attributeName="strokeDashoffset" values="0;-12" dur="0.8s" begin="0.6s" repeatCount="indefinite" />
              </path>
              <text x="60" y="114" textAnchor="middle" fill="rgba(255,255,255,0.35)" fontSize="7" fontWeight="500">FLUX CAPACITOR</text>
            </svg>
          </Flex>
          <Flex flexDirection="column" style={metricBoxStyle("rgba(69,137,255,0.08)")}>
            <Text style={{ fontSize: 12, opacity: 0.7 }}>Projected Requests</Text>
            <Strong style={{ fontSize: 22, color: "#4589ff" }}>{formatCount(totalRequests * multiplier)}</Strong>
          </Flex>
          <Flex flexDirection="column" style={metricBoxStyle(multiplier >= 5 ? "rgba(194,25,48,0.08)" : "rgba(252,213,63,0.08)")}>
            <Text style={{ fontSize: 12, opacity: 0.7 }}>Est. Avg Latency ({multiplier}x)</Text>
            <Strong style={{ fontSize: 22, color: multiplier >= 5 ? RED : YELLOW }}>{formatDuration(projectedLatency)}</Strong>
            <Text style={{ fontSize: 10, opacity: 0.5 }}>+{Math.round(Math.log2(multiplier) * 30)}% contention est.</Text>
          </Flex>
          <Flex flexDirection="column" style={metricBoxStyle(multiplier >= 5 ? "rgba(194,25,48,0.08)" : "rgba(252,213,63,0.08)")}>
            <Text style={{ fontSize: 12, opacity: 0.7 }}>Est. P50 Latency ({multiplier}x)</Text>
            <Strong style={{ fontSize: 22, color: multiplier >= 5 ? RED : YELLOW }}>{formatDuration(projectedP50)}</Strong>
            <Text style={{ fontSize: 10, opacity: 0.5 }}>+{Math.round(Math.log2(multiplier) * 25)}% median est.</Text>
          </Flex>
          <Flex flexDirection="column" style={metricBoxStyle(multiplier >= 5 ? "rgba(194,25,48,0.08)" : "rgba(252,213,63,0.08)")}>
            <Text style={{ fontSize: 12, opacity: 0.7 }}>Est. P90 Latency ({multiplier}x)</Text>
            <Strong style={{ fontSize: 22, color: multiplier >= 5 ? RED : YELLOW }}>{formatDuration(projectedP90)}</Strong>
            <Text style={{ fontSize: 10, opacity: 0.5 }}>+{Math.round(Math.log2(multiplier) * 50)}% tail latency est.</Text>
          </Flex>
          <Flex flexDirection="column" style={metricBoxStyle("rgba(194,25,48,0.08)")}>
            <Text style={{ fontSize: 12, opacity: 0.7 }}>Projected Errors</Text>
            <Strong style={{ fontSize: 22, color: RED }}>{formatCount(projectedErrors)}</Strong>
            <Text style={{ fontSize: 10, opacity: 0.5 }}>Errors scale slightly above linear</Text>
          </Flex>
        </Flex>
      </div>

      <SectionHeader title="Per-Service Impact" />
      <div className="svc-table-tile">
        <MultiplierSlider value={trafficMultiplier} onChange={setTrafficMultiplier} />
        <Heading level={6}>Projected Metrics per Service at {multiplier}x Load</Heading>
        {svcLoading ? <LoadingState /> : svcDetailsData.length === 0 ? (
          <Text>No service data</Text>
        ) : (
          <DataTable
            sortable
            resizable
            data={svcDetailsData.map((s) => ({
              ...s,
              Proj_Requests: Math.round(s.Requests * multiplier),
              Proj_Latency_Avg: s.Latency_Avg * (1 + Math.log2(multiplier) * 0.3),
              Proj_P90: s.Latency_p90 * (1 + Math.log2(multiplier) * 0.5),
              Proj_Failures: Math.round(s.Failures * multiplier * (1 + Math.log2(multiplier) * 0.1)),
            }))}
            columns={[
              { id: "Service", header: "Service", accessor: "Service", cell: serviceLinkCell },
              { id: "Requests", header: "Current Reqs", accessor: "Requests", sortType: "number" as const, cell: ({ value }: any) => <Text>{formatCount(value)}</Text> },
              { id: "Proj_Requests", header: `Proj. Reqs (${multiplier}x)`, accessor: "Proj_Requests", sortType: "number" as const, cell: ({ value }: any) => <Strong style={{ color: "#4589ff" }}>{formatCount(value)}</Strong> },
              { id: "Latency_Avg", header: "Curr Avg Latency", accessor: "Latency_Avg", sortType: "number" as const, cell: ({ value }: any) => <Text>{formatDuration(value)}</Text> },
              { id: "Proj_Latency_Avg", header: `Proj. Avg (${multiplier}x)`, accessor: "Proj_Latency_Avg", sortType: "number" as const, cell: ({ value }: any) => <Strong style={{ color: multiplier >= 5 ? RED : YELLOW }}>{formatDuration(value)}</Strong> },
              { id: "Latency_p90", header: "Curr P90", accessor: "Latency_p90", sortType: "number" as const, cell: ({ value }: any) => <Text>{formatDuration(value)}</Text> },
              { id: "Proj_P90", header: `Proj. P90 (${multiplier}x)`, accessor: "Proj_P90", sortType: "number" as const, cell: ({ value }: any) => <Strong style={{ color: multiplier >= 5 ? RED : YELLOW }}>{formatDuration(value)}</Strong> },
              { id: "FailureRate", header: "Failure %", accessor: "FailureRate", sortType: "number" as const, cell: ({ value }: any) => <Strong style={{ color: value >= 5 ? RED : value >= 1 ? YELLOW : undefined }}>{(value ?? 0).toFixed(2)}%</Strong> },
            ]}
          >
            <DataTable.Pagination defaultPageSize={25} />
          </DataTable>
        )}
      </div>

      <SectionHeader title="Top Endpoints by Impact (Optimize First)" />
      <div className="svc-table-tile">
        <MultiplierSlider value={trafficMultiplier} onChange={setTrafficMultiplier} />
        <Heading level={6}>Top 20 Endpoints Ranked by P90 × Volume</Heading>
        {reqLoading ? <LoadingState /> : topEndpoints.length === 0 ? (
          <Text>No endpoint data</Text>
        ) : (
          <DataTable
            sortable
            resizable
            data={topEndpoints.map((e) => ({
              ...e,
              Impact: (e.Latency_p90 ?? 0) * (e.Requests ?? 0),
              Proj_P90: (e.Latency_p90 ?? 0) * (1 + Math.log2(multiplier) * 0.5),
            }))}
            columns={[
              { id: "Service", header: "Service", accessor: "Service", cell: serviceLinkCell },
              { id: "Request", header: "Endpoint", accessor: "Request" },
              { id: "Requests", header: "Calls", accessor: "Requests", sortType: "number" as const, cell: ({ value }: any) => <Text>{formatCount(value)}</Text> },
              { id: "Latency_p90", header: "P90 Latency", accessor: "Latency_p90", sortType: "number" as const, cell: ({ value }: any) => <Text>{formatDuration(value)}</Text> },
              { id: "Proj_P90", header: `Proj. P90 (${multiplier}x)`, accessor: "Proj_P90", sortType: "number" as const, cell: ({ value }: any) => <Strong style={{ color: multiplier >= 5 ? RED : YELLOW }}>{formatDuration(value)}</Strong> },
              { id: "FailureRate", header: "Error %", accessor: "FailureRate", sortType: "number" as const, cell: ({ value }: any) => <Strong style={{ color: value >= 5 ? RED : value >= 1 ? YELLOW : undefined }}>{(value ?? 0).toFixed(2)}%</Strong> },
              { id: "Impact", header: "Impact Score", accessor: "Impact", sortType: "number" as const, cell: ({ value }: any) => <Strong>{formatCount(value)}</Strong> },
            ]}
          >
            <DataTable.Pagination defaultPageSize={20} />
          </DataTable>
        )}
      </div>
    </Flex>
  );
}

export const ServicesOverview = () => {
  const envUrl = getEnvironmentUrl().replace(/\/$/, "");
  const serviceLinkCell = useMemo(() => makeServiceLinkCell(envUrl), [envUrl]);

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

  // Tab order & visibility
  const [tabVisibility, setTabVisibility] = useState<Record<TabKey, boolean>>(DEFAULT_TAB_VISIBILITY);
  const [tabOrder, setTabOrder] = useState<TabKey[]>([...DEFAULT_TAB_ORDER]);
  const [draggedTabIdx, setDraggedTabIdx] = useState<number | null>(null);
  const savedTabVisibility = useUserAppState({ key: TAB_STATE_KEY });
  const savedTabOrder = useUserAppState({ key: TAB_ORDER_STATE_KEY });
  const { execute: saveAppState } = useSetUserAppState();

  React.useEffect(() => {
    if (savedTabVisibility.data?.value) {
      try {
        const parsed = JSON.parse(savedTabVisibility.data.value as string);
        setTabVisibility(prev => ({ ...prev, ...parsed }));
      } catch { /* ignore */ }
    }
  }, [savedTabVisibility.data]);

  React.useEffect(() => {
    if (savedTabOrder.data?.value) {
      try {
        const parsed = JSON.parse(savedTabOrder.data.value as string) as string[];
        if (Array.isArray(parsed) && parsed.length) {
          const validKeys = new Set<string>(TAB_KEYS);
          const ordered = parsed.filter(k => validKeys.has(k)) as TabKey[];
          const missing = DEFAULT_TAB_ORDER.filter(k => !ordered.includes(k));
          setTabOrder([...ordered, ...missing]);
        }
      } catch { /* ignore */ }
    }
  }, [savedTabOrder.data]);

  const toggleTab = (tab: TabKey) => {
    setTabVisibility(prev => {
      const next = { ...prev, [tab]: !prev[tab] };
      saveAppState({ key: TAB_STATE_KEY, body: { value: JSON.stringify(next) } });
      return next;
    });
  };

  const isTabVisible = (tab: TabKey) => tabVisibility[tab] !== false;

  const handleTabDragOver = (idx: number) => {
    if (draggedTabIdx === null || draggedTabIdx === idx) return;
    const updated = [...tabOrder];
    const [moved] = updated.splice(draggedTabIdx, 1);
    updated.splice(idx, 0, moved);
    setTabOrder(updated);
    setDraggedTabIdx(idx);
  };

  const saveTabOrder = (order: TabKey[]) => {
    setTabOrder(order);
    saveAppState({ key: TAB_ORDER_STATE_KEY, body: { value: JSON.stringify(order) } });
  };

  const visibleTabs = useMemo(() => tabOrder.filter(t => isTabVisible(t)), [tabOrder, tabVisibility]);

  // Enhancement state
  const [compareMode, setCompareMode] = useState(false);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const activeTabKey = visibleTabs[activeTabIndex] as TabKey | undefined;
  const [sloTarget, setSloTarget] = useState<number>(DEFAULT_SLO_TARGET);
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [newRuleMetric, setNewRuleMetric] = useState<string>("FailureRate");
  const [newRuleComparator, setNewRuleComparator] = useState<"gt" | "lt">("gt");
  const [newRuleThreshold, setNewRuleThreshold] = useState<number>(5);
  const [newRuleService, setNewRuleService] = useState<string>("");

  // Baselines state
  const [baselines, setBaselines] = useState<ServiceBaseline[]>([]);
  const [baselineName, setBaselineName] = useState("");

  // Apdex state
  const [apdexT, setApdexT] = useState<number>(DEFAULT_APDEX_T);

  // Dependencies filter state
  const DEP_FILTER_OPTIONS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const [depTopN, setDepTopN] = useState<number>(0);

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
      Service: (r["Service"] as string) ?? (r["dt.entity.service"] as string) ?? "Unknown",
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
      Service: (r["Service"] as string) ?? (r["dt.entity.service"] as string) ?? "Unknown",
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
  const changeImpactResult = useDql({ query: changeImpactMetricsQuery(timeframeDays) });
  const dependenciesResult = useDql({ query: serviceDependenciesQuery() });
  const closedProblemsResult = useDql({ query: closedProblemsQuery(timeframeDays) });
  const anomalyCurrentResult = useDql({ query: anomalyCurrentQuery(timeframeDays) });
  const anomalyBaselineResult = useDql({ query: anomalyBaselineQuery(timeframeDays) });
  const apdexResult = useDql({ query: apdexQuery(timeframeDays, apdexT) });

  // Comparison mode — previous period (no-op when disabled)
  const svcCompare = compareMode && activeTabKey === "Service Metrics";
  const procCompare = compareMode && activeTabKey === "Process Metrics";
  const k8sCompare = compareMode && activeTabKey === "K8s Workloads";
  const apdexCompare = compareMode && activeTabKey === "Apdex";
  const scorecardCompare = compareMode && activeTabKey === "Scorecards";
  const reqTotalPrev = useDql({ query: svcCompare ? requestsTotalPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const latP50Prev = useDql({ query: svcCompare ? latencyP50PrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const latP90Prev = useDql({ query: svcCompare ? latencyP90PrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const failedReqPrev = useDql({ query: svcCompare ? failedRequestsPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const failRatePrev = useDql({ query: svcCompare ? failureRatePrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const http5xxPrev = useDql({ query: svcCompare ? http5xxPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const http4xxPrev = useDql({ query: svcCompare ? http4xxPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const statusCodePrev = useDql({ query: svcCompare ? requestsByStatusCodePrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const procCpuPrev = useDql({ query: procCompare ? processCpuPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const procMemPctPrev = useDql({ query: procCompare ? processMemoryPercentPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const procMemUsedPrev = useDql({ query: procCompare ? processMemoryUsedPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const procGcPrev = useDql({ query: procCompare ? processGcTimePrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const k8sCpuPrev = useDql({ query: k8sCompare ? k8sCpuPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const k8sMemPrev = useDql({ query: k8sCompare ? k8sMemoryPrevQuery(chartTopN, timeframeDays) : NOOP_QUERY });
  const apdexPrevResult = useDql({ query: apdexCompare ? apdexPrevQuery(timeframeDays, apdexT) : NOOP_QUERY });
  const scorecardPrevResult = useDql({ query: scorecardCompare ? scorecardPrevQuery(topN, timeframeDays) : NOOP_QUERY });

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

  // Comparison mode timeseries — Service Metrics
  const reqTotalPrevTs = useMemo(() => toTs(reqTotalPrev), [reqTotalPrev.data]);
  const latP50PrevTs = useMemo(() => toTs(latP50Prev), [latP50Prev.data]);
  const latP90PrevTs = useMemo(() => toTs(latP90Prev), [latP90Prev.data]);
  const failedReqPrevTs = useMemo(() => toTs(failedReqPrev), [failedReqPrev.data]);
  const failRatePrevTs = useMemo(() => toTs(failRatePrev), [failRatePrev.data]);
  const http5xxPrevTs = useMemo(() => toTs(http5xxPrev), [http5xxPrev.data]);
  const http4xxPrevTs = useMemo(() => toTs(http4xxPrev), [http4xxPrev.data]);
  const statusCodePrevTs = useMemo(() => toTs(statusCodePrev), [statusCodePrev.data]);

  // Comparison mode timeseries — Process Metrics
  const procCpuPrevTs = useMemo(() => toTs(procCpuPrev), [procCpuPrev.data]);
  const procMemPctPrevTs = useMemo(() => toTs(procMemPctPrev), [procMemPctPrev.data]);
  const procMemUsedPrevTs = useMemo(() => toTs(procMemUsedPrev), [procMemUsedPrev.data]);
  const procGcPrevTs = useMemo(() => toTs(procGcPrev), [procGcPrev.data]);

  // Comparison mode timeseries — K8s Workloads
  const k8sCpuPrevTs = useMemo(() => toTs(k8sCpuPrev), [k8sCpuPrev.data]);
  const k8sMemPrevTs = useMemo(() => toTs(k8sMemPrev), [k8sMemPrev.data]);

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
        "dt.entity.service": svc["dt.entity.service"],
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
        "dt.entity.service": svc["dt.entity.service"],
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

  // ─── Scorecard Previous Period (for compare) ───
  const scorecardPrevMap = useMemo(() => {
    const map = new Map<string, { score: number; grade: string; errorScore: number; latencyScore: number; http5xxScore: number }>();
    if (!scorecardPrevResult.data?.records) return map;
    scorecardPrevResult.data.records.forEach((r) => {
      const name = (r["Service"] as string) ?? "";
      const errorRate = (r["FailureRate"] as number) ?? 0;
      const latP90 = (r["Latency_p90"] as number) ?? 0;
      const latP50 = (r["Latency_p50"] as number) ?? 0;
      const http5xx = (r["5xx"] as number) ?? 0;
      const requests = (r["Requests"] as number) ?? 0;
      const http5xxRate = requests > 0 ? (http5xx / requests) * 100 : 0;
      const errorScore = Math.max(0, 100 - errorRate * 20);
      const latencyScore = latP50 > 0 ? Math.max(0, Math.min(100, 100 - ((latP90 / latP50 - 1) * 50))) : 100;
      const http5xxScore = Math.max(0, 100 - http5xxRate * 100);
      // No problem score for prev period — use 100 (neutral)
      const score = Math.round(errorScore * 0.35 + latencyScore * 0.2 + 100 * 0.25 + http5xxScore * 0.2);
      const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
      if (name) map.set(name, { score, grade, errorScore: Math.round(errorScore), latencyScore: Math.round(latencyScore), http5xxScore: Math.round(http5xxScore) });
    });
    return map;
  }, [scorecardPrevResult.data]);

  const scorecardCompareData = useMemo(() => {
    if (!scorecardCompare) return [];
    const prevLoading = scorecardPrevResult.isLoading;
    return scorecardData.map((d) => {
      const prev = scorecardPrevMap.get(d.Service);
      const prevScore = prevLoading ? "Loading..." : prev ? String(prev.score) : "N/A";
      const deltaScore = prevLoading ? null : prev ? d.Score - prev.score : null;
      const prevGrade = prevLoading ? "..." : prev ? prev.grade : "N/A";
      return { ...d, "Prev Score": prevScore, "Δ Score": deltaScore, "Prev Grade": prevGrade };
    });
  }, [scorecardData, scorecardPrevMap, scorecardCompare, scorecardPrevResult.isLoading]);

  // ─── Dependencies ───
  const dependenciesData = useMemo(() => {
    if (!dependenciesResult.data?.records) return [];
    // Build top-N service set by request count
    let allowedCallers: Set<string> | null = null;
    if (depTopN > 0 && svcDetailsData.length > 0) {
      const sorted = [...svcDetailsData].sort((a, b) => (b.Requests ?? 0) - (a.Requests ?? 0));
      allowedCallers = new Set(sorted.slice(0, depTopN).map((s) => s.Service));
    }
    return dependenciesResult.data.records
      .map((r) => ({
        Caller: (r["Caller"] as string) ?? "",
        Callee: (r["Callee"] as string) ?? "",
      }))
      .filter((d) => !allowedCallers || allowedCallers.has(d.Caller));
  }, [dependenciesResult.data, svcDetailsData, depTopN]);

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
        "dt.entity.service": svcId,
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
      "dt.entity.service": (r["dt.entity.service"] as string) ?? "",
    }));
  }, [deploymentsResult.data]);

  // ─── Change Impact Analysis ───
  const changeImpactData = useMemo(() => {
    if (!deploymentsResult.data?.records || !changeImpactResult.data?.records) return [];
    const deployments = deploymentsResult.data.records;
    const metrics = changeImpactResult.data.records;

    // Build per-service hourly buckets: { svcId -> [{ start, requests, failures, latency }] }
    const svcBuckets = new Map<string, { start: number; requests: number; failures: number; latency: number }[]>();
    metrics.forEach((r) => {
      const svcId = (r["dt.entity.service"] as string) ?? "";
      const tf = r["timeframe"] as any;
      const start = tf?.start ? new Date(tf.start).getTime() : 0;
      const reqArr = r["requests"] as number[] | null;
      const failArr = r["failures"] as number[] | null;
      const latArr = r["latency_p90"] as number[] | null;
      if (!reqArr || !start) return;
      // timeseries interval is a scalar Duration, not an array; compute bucket starts from timeframe.start
      const intervalMs = 3600000; // 1h matches the query interval
      reqArr.forEach((req, i) => {
        const bucketStart = start + i * intervalMs;
        if (!svcBuckets.has(svcId)) svcBuckets.set(svcId, []);
        svcBuckets.get(svcId)!.push({
          start: bucketStart,
          requests: req ?? 0,
          failures: failArr?.[i] ?? 0,
          latency: latArr?.[i] ?? 0,
        });
      });
    });

    // For each deployment, find 3h before and 3h after metrics
    const windowMs = 3 * 3600000;
    return deployments.map((d) => {
      const ts = d["timestamp"] ? new Date(d["timestamp"] as string).getTime() : 0;
      const svcId = (d["dt.entity.service"] as string) ?? "";
      const svcName = (d["serviceName"] as string) ?? "";
      const eventName = (d["event.name"] as string) ?? "";
      const buckets = svcBuckets.get(svcId) ?? [];

      const before = buckets.filter((b) => b.start >= ts - windowMs && b.start < ts);
      const after = buckets.filter((b) => b.start >= ts && b.start < ts + windowMs);

      const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

      const beforeReq = sum(before.map((b) => b.requests));
      const afterReq = sum(after.map((b) => b.requests));
      const beforeLat = avg(before.map((b) => b.latency));
      const afterLat = avg(after.map((b) => b.latency));
      const beforeFail = beforeReq > 0 ? (sum(before.map((b) => b.failures)) / beforeReq) * 100 : 0;
      const afterFail = afterReq > 0 ? (sum(after.map((b) => b.failures)) / afterReq) * 100 : 0;

      const latDelta = beforeLat > 0 ? ((afterLat - beforeLat) / beforeLat) * 100 : 0;
      const reqDelta = beforeReq > 0 ? ((afterReq - beforeReq) / beforeReq) * 100 : 0;
      const failDelta = afterFail - beforeFail;

      let verdict = "✅ Healthy";
      if (latDelta > 50 || failDelta > 2) verdict = "🟥 Regression";
      else if (latDelta > 20 || failDelta > 0.5) verdict = "🟨 Warning";
      else if (latDelta < -10 && failDelta <= 0) verdict = "🟩 Improved";

      return {
        Time: ts ? new Date(ts).toLocaleString() : "",
        Deployment: eventName,
        Service: svcName,
        "dt.entity.service": svcId,
        "Requests (Before)": beforeReq,
        "Requests (After)": afterReq,
        "Requests Δ %": Math.round(reqDelta * 10) / 10,
        "Latency P90 (Before)": Math.round(beforeLat),
        "Latency P90 (After)": Math.round(afterLat),
        "Latency Δ %": Math.round(latDelta * 10) / 10,
        "Error Rate (Before)": Math.round(beforeFail * 1000) / 1000,
        "Error Rate (After)": Math.round(afterFail * 1000) / 1000,
        "Error Δ pp": Math.round(failDelta * 1000) / 1000,
        Verdict: verdict,
      };
    }).filter((d) => d.Service);
  }, [deploymentsResult.data, changeImpactResult.data]);

  // ─── Apdex / User Satisfaction ───
  const apdexData = useMemo(() => {
    if (!apdexResult.data?.records) return [];
    const svcMap = new Map<string, { satisfied: number; tolerating: number; frustrated: number; name: string; svcId: string }>();
    apdexResult.data.records.forEach((r) => {
      const svcId = (r["dt.entity.service"] as string) ?? "";
      const name = (r["Service"] as string) ?? svcId;
      const satisfaction = (r["satisfaction"] as string) ?? "";
      const cnt = Number(r["count"]) || 0;
      if (!svcMap.has(svcId)) svcMap.set(svcId, { satisfied: 0, tolerating: 0, frustrated: 0, name, svcId });
      const entry = svcMap.get(svcId)!;
      if (satisfaction === "satisfied") entry.satisfied += cnt;
      else if (satisfaction === "tolerating") entry.tolerating += cnt;
      else if (satisfaction === "frustrated") entry.frustrated += cnt;
    });
    return Array.from(svcMap.entries())
      .map(([_id, s]) => {
        const total = s.satisfied + s.tolerating + s.frustrated;
        const apdex = total > 0 ? (s.satisfied + s.tolerating / 2) / total : 1;
        const pctSatisfied = total > 0 ? (s.satisfied / total) * 100 : 100;
        const pctTolerating = total > 0 ? (s.tolerating / total) * 100 : 0;
        const pctFrustrated = total > 0 ? (s.frustrated / total) * 100 : 0;
        let rating = "Excellent";
        if (apdex < 0.5) rating = "Unacceptable";
        else if (apdex < 0.7) rating = "Poor";
        else if (apdex < 0.85) rating = "Fair";
        else if (apdex < 0.94) rating = "Good";
        return {
          Service: s.name,
          "dt.entity.service": s.svcId,
          Apdex: apdex.toFixed(2),
          ApdexNum: Math.round(apdex * 100) / 100,
          Rating: rating,
          Satisfied: s.satisfied,
          "Satisfied %": `${(Math.round(pctSatisfied * 10) / 10)}%`,
          Tolerating: s.tolerating,
          "Tolerating %": `${(Math.round(pctTolerating * 10) / 10)}%`,
          Frustrated: s.frustrated,
          "Frustrated %": `${(Math.round(pctFrustrated * 10) / 10)}%`,
          Total: total,
        };
      })
      .sort((a, b) => a.ApdexNum - b.ApdexNum); // worst first
  }, [apdexResult.data]);

  // ─── Apdex Previous Period (for compare) ───
  const apdexPrevMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!apdexPrevResult.data?.records) return map;
    const svcMap = new Map<string, { satisfied: number; tolerating: number; frustrated: number }>();
    apdexPrevResult.data.records.forEach((r) => {
      const name = (r["Service"] as string) ?? "";
      const satisfaction = (r["satisfaction"] as string) ?? "";
      const cnt = Number(r["count"]) || 0;
      if (!svcMap.has(name)) svcMap.set(name, { satisfied: 0, tolerating: 0, frustrated: 0 });
      const entry = svcMap.get(name)!;
      if (satisfaction === "satisfied") entry.satisfied += cnt;
      else if (satisfaction === "tolerating") entry.tolerating += cnt;
      else if (satisfaction === "frustrated") entry.frustrated += cnt;
    });
    svcMap.forEach((s, name) => {
      const total = s.satisfied + s.tolerating + s.frustrated;
      map.set(name, total > 0 ? (s.satisfied + s.tolerating / 2) / total : 1);
    });
    return map;
  }, [apdexPrevResult.data]);

  const apdexCompareData = useMemo(() => {
    if (!apdexCompare) return [];
    const prevLoading = apdexPrevResult.isLoading;
    return apdexData.map((d) => {
      const prev = apdexPrevMap.get(d.Service);
      const prevApdex = prevLoading ? "Loading..." : prev !== undefined ? prev.toFixed(2) : "N/A";
      const delta = prevLoading ? "..." : prev !== undefined ? (d.ApdexNum - prev).toFixed(2) : "N/A";
      return { ...d, "Prev Apdex": prevApdex, "Δ Apdex": delta };
    });
  }, [apdexData, apdexPrevMap, apdexCompare, apdexPrevResult.isLoading]);

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
    const violations: { Rule: string; Service: string; "dt.entity.service": string; Metric: string; Value: number; Threshold: number }[] = [];
    for (const rule of alertRules) {
      for (const svc of svcDetailsData) {
        if (rule.serviceName && svc.Service !== rule.serviceName) continue;
        const value = (svc as any)[rule.metric] as number ?? 0;
        const violated = rule.comparator === "gt" ? value > rule.threshold : value < rule.threshold;
        if (violated) {
          violations.push({
            Rule: `${rule.metric} ${rule.comparator === "gt" ? ">" : "<"} ${rule.threshold}`,
            Service: svc.Service as string,
            "dt.entity.service": svc["dt.entity.service"],
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

  // --- Export to Notebook ---
  const [exporting, setExporting] = useState(false);
  const handleExportNotebook = useCallback(async () => {
    setExporting(true);
    try {
      const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
      const tf = `now()-${timeframeDays}d`;
      const uid = () => crypto.randomUUID();

      const sections: any[] = [
        { id: uid(), type: "markdown", markdown: `# Services Overview — Exported ${ts}\n\nAuto-generated notebook from the **Services Overview** app.\n\n**Settings:** Top N = ${topN}, Chart Top N = ${chartTopN}, Timeframe = ${timeframeDays}d` },

        // Service Health
        { id: uid(), type: "markdown", markdown: "## Service Health" },
        { id: uid(), type: "dql", title: "Services Health Overview", showTitle: true, height: 400, state: { input: { value: servicesHealthQuery(problemsLookbackHours), timeframe: { from: tf, to: "now()" } }, visualization: "table" } },

        // Service Details
        { id: uid(), type: "markdown", markdown: "## Service Details" },
        { id: uid(), type: "dql", title: "Service Details", showTitle: true, height: 400, state: { input: { value: serviceDetailsQuery(topN, timeframeDays, problemsLookbackHours), timeframe: { from: tf, to: "now()" } }, visualization: "table" } },

        // Request Details
        { id: uid(), type: "markdown", markdown: "## Request Details" },
        { id: uid(), type: "dql", title: "Request Details", showTitle: true, height: 400, state: { input: { value: requestDetailsQuery(topN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "table" } },

        // Service Metrics
        { id: uid(), type: "markdown", markdown: "## Service Metrics" },
        { id: uid(), type: "dql", title: "Requests Total", showTitle: true, height: 300, state: { input: { value: requestsTotalQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "Latency P50", showTitle: true, height: 300, state: { input: { value: latencyP50Query(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "Latency P90", showTitle: true, height: 300, state: { input: { value: latencyP90Query(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "Failure Rate %", showTitle: true, height: 300, state: { input: { value: failureRateQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "Requests by Status Code", showTitle: true, height: 300, state: { input: { value: requestsByStatusCodeQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "barChart" } },
        { id: uid(), type: "dql", title: "Failed Requests", showTitle: true, height: 300, state: { input: { value: failedRequestsQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "5xx Errors", showTitle: true, height: 300, state: { input: { value: http5xxQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "4xx Errors", showTitle: true, height: 300, state: { input: { value: http4xxQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },

        // Process Metrics
        { id: uid(), type: "markdown", markdown: "## Process Metrics" },
        { id: uid(), type: "dql", title: "Process CPU Usage %", showTitle: true, height: 300, state: { input: { value: processCpuQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "Process Memory Usage %", showTitle: true, height: 300, state: { input: { value: processMemoryPercentQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "Process Memory Used", showTitle: true, height: 300, state: { input: { value: processMemoryUsedQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "GC Suspension Time %", showTitle: true, height: 300, state: { input: { value: processGcTimeQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },

        // K8s Workloads
        { id: uid(), type: "markdown", markdown: "## K8s Workload Metrics" },
        { id: uid(), type: "dql", title: "K8s Workload CPU Usage", showTitle: true, height: 300, state: { input: { value: k8sCpuQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },
        { id: uid(), type: "dql", title: "K8s Workload Memory Usage", showTitle: true, height: 300, state: { input: { value: k8sMemoryQuery(chartTopN, timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "lineChart" } },

        // Problems & MTTR
        { id: uid(), type: "markdown", markdown: "## Problems & MTTR" },
        { id: uid(), type: "dql", title: "Active Problems", showTitle: true, height: 400, state: { input: { value: problemsQuery(), timeframe: { from: tf, to: "now()" } }, visualization: "table" } },
        { id: uid(), type: "dql", title: "Closed Problems (MTTR)", showTitle: true, height: 400, state: { input: { value: closedProblemsQuery(timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "table" } },

        // Anomaly Detection
        { id: uid(), type: "markdown", markdown: "## Anomaly Detection" },
        { id: uid(), type: "dql", title: "Current Period Analysis", showTitle: true, height: 400, state: { input: { value: anomalyCurrentQuery(timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "table" } },
        { id: uid(), type: "dql", title: "Baseline Period Analysis", showTitle: true, height: 400, state: { input: { value: anomalyBaselineQuery(timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "table" } },

        // Dependencies
        { id: uid(), type: "markdown", markdown: "## Service Dependencies" },
        { id: uid(), type: "dql", title: "Service Dependencies", showTitle: true, height: 400, state: { input: { value: serviceDependenciesQuery() }, visualization: "table" } },

        // Deployments
        { id: uid(), type: "markdown", markdown: "## Deployment Events" },
        { id: uid(), type: "dql", title: "Recent Deployments", showTitle: true, height: 400, state: { input: { value: deploymentEventsQuery(timeframeDays), timeframe: { from: tf, to: "now()" } }, visualization: "table" } },
      ];

      const notebookContent = {
        version: "7",
        defaultTimeframe: { from: tf, to: "now()" },
        sections,
      };

      const name = `Services Overview — ${ts}`;
      const result = await documentsClient.createDocument({
        body: {
          name,
          type: "notebook",
          content: new Blob([JSON.stringify(notebookContent)], { type: "application/json" }),
        },
      });

      const envUrl = getEnvironmentUrl().replace(/\/$/, "");
      const nbUrl = `${envUrl}/ui/apps/dynatrace.notebooks/notebook/${result.id}`;
      window.open(nbUrl, "_blank");
    } catch (e) {
      console.error("Export to notebook failed", e);
      alert("Export to notebook failed: " + (e as Error).message);
    } finally {
      setExporting(false);
    }
  }, [topN, chartTopN, timeframeDays, problemsLookbackHours]);

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
        cell: serviceLinkCell,
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
        cell: serviceLinkCell,
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
            {activeTabKey && COMPARE_TABS.includes(activeTabKey) && (
              <Button variant={compareMode ? "emphasized" : "default"} onClick={() => setCompareMode(!compareMode)}>
                {compareMode ? "Compare: ON" : "Compare"}
              </Button>
            )}
            <Button variant="default" onClick={handleOpenSettings}>
              <Button.Prefix>
                <SettingIcon />
              </Button.Prefix>
            </Button>
            <Button variant="default" onClick={handleExportNotebook} disabled={exporting}>
              <Button.Prefix>
                <DocumentIcon />
              </Button.Prefix>
              {exporting ? "Exporting..." : "Export to Notebook"}
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
          <Flex flexDirection="column" gap={4}>
            <Strong>Apdex Threshold T (ms)</Strong>
            <NumberInput
              value={apdexT}
              onChange={(val) => setApdexT(val ?? DEFAULT_APDEX_T)}
              min={50}
              max={10000}
            />
          </Flex>
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", marginTop: 8, paddingTop: 12 }}>
            <Strong style={{ marginBottom: 4, display: "block" }}>Tab Order &amp; Visibility</Strong>
            <Text style={{ marginBottom: 12, opacity: 0.6, fontSize: 12, display: "block" }}>
              Drag to reorder tabs and toggle visibility. Changes are saved per user and persist across sessions.
            </Text>
            {tabOrder.map((tab, idx) => (
              <div
                key={tab}
                draggable
                onDragStart={() => setDraggedTabIdx(idx)}
                onDragOver={(e) => { e.preventDefault(); handleTabDragOver(idx); }}
                onDragEnd={() => { setDraggedTabIdx(null); saveTabOrder(tabOrder); }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "6px 8px", borderBottom: "1px solid rgba(255,255,255,0.06)",
                  background: draggedTabIdx === idx ? "rgba(69,137,255,0.12)" : "transparent",
                  cursor: "grab", transition: "background 0.15s ease",
                }}
              >
                <Flex alignItems="center" gap={8}>
                  <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 14, userSelect: "none" }}>☰</span>
                  <Text style={{ fontSize: 13 }}>{tab}</Text>
                </Flex>
                <Switch value={tabVisibility[tab] !== false} onChange={() => toggleTab(tab)} />
              </div>
            ))}
            <button
              onClick={() => { saveTabOrder([...DEFAULT_TAB_ORDER]); }}
              style={{
                marginTop: 8, padding: "4px 12px", borderRadius: 6,
                border: "1px solid rgba(99,130,191,0.3)", background: "transparent",
                color: "#6babf5", fontSize: 12, cursor: "pointer",
              }}
            >
              Reset Tab Order
            </button>
          </div>
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
              <tr><td>Apdex T</td><td>{DEFAULT_APDEX_T}ms</td><td>Apdex threshold — Satisfied ≤ T, Tolerating ≤ 4T</td></tr>
            </tbody>
          </table>

          <h3>New Features</h3>

          <h4>Compare Mode</h4>
          <p>Toggle the <strong>Compare</strong> button in the filter bar to show previous-period data alongside current data. Available on Service Metrics, Process Metrics, K8s Workloads (timeseries overlay), and Apdex (Prev Apdex / Δ columns). Compares the selected timeframe against the equivalent prior period.</p>

          <h4>Deployment Correlation</h4>
          <p>When deployment events (<code>CUSTOM_DEPLOYMENT</code>) exist, they appear at the top of the Service Metrics tab as a table. Correlate deploys with latency spikes or error increases.</p>

          <h4>SLO & Error Budget</h4>
          <p>Computes error budgets based on the configured SLO target. Shows budget consumption, burn rate, and status (OK / WARNING / EXHAUSTED) per service. Configurable SLO target in Settings.</p>

          <h4>Service Scorecards</h4>
          <p>Composite health score (0–100) per service, weighted: Error Rate (35%), Latency P90/P50 ratio (20%), Problem Status (25%), 5xx Rate (20%). Grades: A (≥90), B (≥75), C (≥60), D (≥40), F (&lt;40).</p>

          <h4>Dependencies</h4>
          <p>Pulls service-to-service call relationships from entity data. Shows Caller → Callee pairs with counts of unique callers and callees.</p>
          <p>Click a service node in the topology map to pin its details popup. The popup includes a <strong>View in Smartscape</strong> link that opens the service in the Dynatrace Smartscape topology view. If the service has an active problem, the <strong>Active Problem</strong> notification is a clickable link that opens the problem details directly.</p>

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

          <h4>Baselines</h4>
          <p>Computes rolling baselines for each service using the selected timeframe. Shows average request rate, latency P90, and failure rate baselines with upper/lower bounds. Useful for spotting services that have drifted from their normal operating range.</p>

          <h4>Maximize / Minimize Charts</h4>
          <p>Click the <strong>⤢ Maximize</strong> icon on any chart tile to expand it to a full-screen overlay for detailed inspection. Click <strong>⤡ Minimize</strong> or press Escape to return. Available on Service Metrics, Process Metrics, and K8s Workloads charts.</p>

          <h4>Service Topology Map</h4>
          <p>Interactive SVG dependency map in the Dependencies tab showing caller → callee relationships as a directed graph. Features:</p>
          <ul>
            <li><strong>Drag Nodes</strong> — Click and drag any service circle to reposition it on the canvas</li>
            <li><strong>Zoom In/Out</strong> — Use the +/− buttons or mouse wheel to zoom the topology view</li>
            <li><strong>Pan</strong> — Click and drag on empty space to pan across the canvas</li>
            <li><strong>Focus Mode</strong> — Toggle to hide unrelated nodes and edges when hovering a service, isolating its direct connections. While focused on a service, clicking another service shows its popup without changing focus</li>
            <li><strong>Reset</strong> — Reset zoom, pan, and all drag positions back to the default layout</li>
            <li><strong>Click-to-Pin</strong> — Click a service node to lock the tooltip; click again to release</li>
            <li><strong>Draggable Popup</strong> — When pinned, drag the popup header to reposition it anywhere on screen</li>
            <li><strong>Hover Highlighting</strong> — Hover over a node to see its upstream and downstream connections; unrelated nodes dim</li>
            <li><strong>Rich Tooltip</strong> — Shows Requests, Error Rate, P50 Latency (median), P90 Latency (90th pct), plus links to Problems and Service Details. Automatically clamped to stay within the viewport</li>
          </ul>

          <h4>Export to Notebook</h4>
          <p>Click the <strong>📄 Export to Notebook</strong> button in the header to create a Dynatrace Notebook containing all current queries and results. The notebook is saved to your Document Store and opens in a new tab.</p>

          <h4>Change Impact Analysis</h4>
          <p>Compares service metrics <strong>3 hours before</strong> vs <strong>3 hours after</strong> each deployment event (<code>CUSTOM_DEPLOYMENT</code>). Shows per-deployment impact assessment:</p>
          <ul>
            <li><strong>Latency P90</strong> — Before/After values and Δ% change</li>
            <li><strong>Error Rate</strong> — Before/After values and Δ percentage points</li>
            <li><strong>Verdict</strong> — 🟩 Improved (latency dropped &gt;10%), ✅ Healthy (stable), 🟨 Warning (latency up 20–50% or error Δ 0.5–2pp), 🟥 Regression (latency up &gt;50% or error Δ &gt;2pp)</li>
          </ul>
          <p>Summary cards show total deployments, regressions, warnings, and healthy/improved counts at a glance.</p>

          <h4>Apdex / User Satisfaction</h4>
          <p>Calculates <strong>Apdex</strong> (Application Performance Index) per service from span response times using a configurable threshold <strong>T</strong> (default: {DEFAULT_APDEX_T}ms).</p>
          <ul>
            <li><strong>Satisfied</strong> — response ≤ T</li>
            <li><strong>Tolerating</strong> — T &lt; response ≤ 4T</li>
            <li><strong>Frustrated</strong> — response &gt; 4T</li>
          </ul>
          <p>Apdex = (Satisfied + Tolerating/2) / Total. Ratings: Excellent (≥0.94), Good (0.85–0.94), Fair (0.7–0.85), Poor (0.5–0.7), Unacceptable (&lt;0.5). Change T in Settings (⚙).</p>
          <p>Supports <strong>Compare mode</strong> — toggle the Compare button to show <strong>Prev Apdex</strong> and <strong>Δ Apdex</strong> columns, comparing the current period against the equivalent prior period. Positive Δ (green) = improvement, negative Δ (red) = degradation.</p>

          <h4>Service Name Deep Links</h4>
          <p>Service names in all tables are clickable links that open the <strong>Distributed Traces</strong> app filtered to that service. This provides one-click drill-down from any tab into the full trace explorer for root-cause analysis.</p>

          <h4>Scorecard Compare Colorization</h4>
          <p>When Compare mode is enabled on the Scorecards tab, the <strong>Δ Score</strong> column is color-coded: <span style={{ color: GREEN, fontWeight: 700 }}>green (+)</span> = score improved, <span style={{ color: RED, fontWeight: 700 }}>red (−)</span> = score degraded.</p>

          <h4>What-If Analysis</h4>
          <p>Model the impact of traffic growth on your services. Use the traffic change slider (0%–5000%) to project how key metrics would change under increased load:</p>
          <ul>
            <li><strong>Current Baseline</strong> — Shows current Total Requests, Avg Latency, P50/P90 Latency, and Error Rate across all services</li>
            <li><strong>Growth Projection</strong> — Estimates projected requests, latency (with logarithmic contention scaling), and error count at the selected multiplier</li>
            <li><strong>Per-Service Impact</strong> — Table showing current vs projected metrics for each service, highlighting which services will be most affected</li>
            <li><strong>Top Endpoints by Impact</strong> — Top 20 endpoints ranked by P90 × Volume ("Impact Score"), identifying the highest-priority optimization targets</li>
          </ul>
          <p>Latency projections use a logarithmic contention model: at 2× load, expect ~30% latency increase; at 10× load, expect ~100% increase. Errors scale slightly above linear due to cascading failure effects.</p>

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
            <li>Use <strong>Change Impact Analysis</strong> after deployments to verify no regressions were introduced.</li>
            <li>Maximize charts to inspect spikes in detail, then minimize to return to the dashboard.</li>
            <li>Use the <strong>Topology Map</strong> drag, zoom, and pin features to trace the blast radius of a degraded service.</li>
            <li>Use <strong>What-If Analysis</strong> for capacity planning — project how your services will perform under 2×–10× traffic growth.</li>
            <li><strong>Export to Notebook</strong> to share findings with your team or document an investigation.</li>
            <li>Check <strong>Baselines</strong> to identify services that have drifted from their normal operating range.</li>
            <li>Use <strong>Apdex</strong> to quickly gauge user satisfaction — services scoring below 0.85 need attention.</li>
            <li>Column widths are remembered within each tab session — resize to your preference.</li>
          </ul>
        </div>
      </Modal>

      {/* ---- Main Content ---- */}
      <Flex flexDirection="column" padding={16} gap={16}>
        <Tabs selectedIndex={activeTabIndex} onChange={(idx) => setActiveTabIndex(idx)}>
          {visibleTabs.map((tabId) => {
            switch (tabId) {
              case "Overview": return (
          <Tab key={tabId} title="Overview">
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
          </Tab>);
              case "Service Details": return (
          <Tab key={tabId} title="Service Details">
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
          </Tab>);
              case "Request Details": return (
          <Tab key={tabId} title="Request Details">
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
          </Tab>);
              case "Service Metrics": return (
          <Tab key={tabId} title="Service Metrics">
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
                        { id: "Service", header: "Service", accessor: "Service", cell: serviceLinkCell },
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
                    <CompareChartTile title="Requests Total (Previous)" description="Previous period" currentTitle="Requests Total" currentChart={<TimeseriesChart data={reqTotalTs as any} loading={reqTotalResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={reqTotalPrevTs as any} loading={reqTotalPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="Latency P50 (Previous)" description="Previous period" currentTitle="Latency P50" currentChart={<TimeseriesChart data={latP50Ts as any} loading={latP50Result.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={latP50PrevTs as any} loading={latP50Prev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="Latency P90 (Previous)" description="Previous period" currentTitle="Latency P90" currentChart={<TimeseriesChart data={latP90Ts as any} loading={latP90Result.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={latP90PrevTs as any} loading={latP90Prev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="Failure Rate % (Previous)" description="Previous period" currentTitle="Failure Rate %" currentChart={<TimeseriesChart data={failRateTs as any} loading={failRateResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={failRatePrevTs as any} loading={failRatePrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                  </div>
                  <div className="svc-chart-grid-4">
                    <CompareChartTile title="Requests by Status Code (Previous)" description="Previous period" currentTitle="Requests by Status Code" currentChart={<TimeseriesChart data={statusCodeTs as any} loading={statusCodeResult.isLoading} variant="bar" gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={statusCodePrevTs as any} loading={statusCodePrev.isLoading} variant="bar" gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="Failed Requests (Previous)" description="Previous period" currentTitle="Failed Requests" currentChart={<TimeseriesChart data={failedReqTs as any} loading={failedReqResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={failedReqPrevTs as any} loading={failedReqPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="5xx Errors (Previous)" description="Previous period" currentTitle="5xx Errors" currentChart={<TimeseriesChart data={http5xxTs as any} loading={http5xxResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={http5xxPrevTs as any} loading={http5xxPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="4xx Errors (Previous)" description="Previous period" currentTitle="4xx Errors" currentChart={<TimeseriesChart data={http4xxTs as any} loading={http4xxResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={http4xxPrevTs as any} loading={http4xxPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                  </div>
                </>
              )}
            </Flex>
          </Tab>);
              case "Process Metrics": return (
          <Tab key={tabId} title="Process Metrics">
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

              {/* Comparison Mode — Previous Period */}
              {compareMode && (
                <>
                  <SectionHeader title="Previous Period Comparison" />
                  <div className="svc-chart-grid-2">
                    <CompareChartTile title="Process CPU Usage % (Previous)" description="Previous period" currentTitle="Process CPU Usage %" currentChart={<TimeseriesChart data={procCpuTs as any} loading={procCpuResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={procCpuPrevTs as any} loading={procCpuPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="Process Memory Usage % (Previous)" description="Previous period" currentTitle="Process Memory Usage %" currentChart={<TimeseriesChart data={procMemPctTs as any} loading={procMemPctResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={procMemPctPrevTs as any} loading={procMemPctPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="Process Memory Used (Previous)" description="Previous period" currentTitle="Process Memory Used" currentChart={<TimeseriesChart data={procMemUsedTs as any} loading={procMemUsedResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={procMemUsedPrevTs as any} loading={procMemUsedPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="GC Suspension Time % (Previous)" description="Previous period" currentTitle="GC Suspension Time %" currentChart={<TimeseriesChart data={procGcTs as any} loading={procGcResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={procGcPrevTs as any} loading={procGcPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                  </div>
                </>
              )}
            </Flex>
          </Tab>);
              case "K8s Workloads": return (
          <Tab key={tabId} title="K8s Workloads">
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

              {/* Comparison Mode — Previous Period */}
              {compareMode && (
                <>
                  <SectionHeader title="Previous Period Comparison" />
                  <div className="svc-chart-grid-2">
                    <CompareChartTile title="K8s Workload CPU Usage (Previous)" description="Previous period" currentTitle="K8s Workload CPU Usage" currentChart={<TimeseriesChart data={k8sCpuTs as any} loading={k8sCpuResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={k8sCpuPrevTs as any} loading={k8sCpuPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                    <CompareChartTile title="K8s Workload Memory Usage (Previous)" description="Previous period" currentTitle="K8s Workload Memory Usage" currentChart={<TimeseriesChart data={k8sMemTs as any} loading={k8sMemResult.isLoading} gapPolicy="connect"><TimeseriesChart.Legend hidden /></TimeseriesChart>}>
                      <TimeseriesChart data={k8sMemPrevTs as any} loading={k8sMemPrev.isLoading} gapPolicy="connect">
                        <TimeseriesChart.Legend hidden />
                      </TimeseriesChart>
                    </CompareChartTile>
                  </div>
                </>
              )}
            </Flex>
          </Tab>);
              case "SLO & Error Budget": return (
          <Tab key={tabId} title="SLO & Error Budget">
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
                      { id: "Service", header: "Service", accessor: "Service", cell: serviceLinkCell },
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
          </Tab>);
              case "Scorecards": return (
          <Tab key={tabId} title="Scorecards">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Service Health Scorecards" />
              <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 12 }}>
                <div className="chart-description">
                  Composite score (0–100): Error Rate (35%) + Latency Ratio (20%) + Problem Status (25%) + 5xx Rate (20%)
                </div>
              </div>
              {svcDetailsResult.isLoading ? <LoadingState /> : (
                <>
                  {scorecardCompare && scorecardPrevResult.isLoading && (
                    <Flex alignItems="center" gap={8} style={{ padding: "8px 16px", background: "var(--dt-colors-surface-default)", borderRadius: 8, marginBottom: 8 }}>
                      <ProgressCircle size="small" />
                      <Text>Loading previous period data for comparison…</Text>
                    </Flex>
                  )}
                  <div className="svc-table-tile">
                    <DataTable
                      data={scorecardCompare ? scorecardCompareData : scorecardData}
                      columns={[
                        { id: "Service", header: "Service", accessor: "Service", cell: serviceLinkCell },
                        { id: "Score", header: "Score", accessor: "Score", columnType: "number" as const,
                          thresholds: [
                            { comparator: "less-than" as const, value: 60, backgroundColor: RED, color: "#fff" },
                            { comparator: "greater-than-or-equal-to" as const, value: 60, backgroundColor: YELLOW, color: "#000" },
                            { comparator: "greater-than-or-equal-to" as const, value: 75, backgroundColor: GREEN, color: "#000" },
                          ] },
                        ...(scorecardCompare ? [
                          { id: "PrevScore", header: "Prev Score", accessor: "Prev Score" },
                          { id: "DeltaScore", header: "Δ Score", accessor: "Δ Score", columnType: "number" as const,
                            cell: ({ value }: { value: number | null }) => {
                              if (value == null) return <span>N/A</span>;
                              const color = value === 0 ? undefined : value > 0 ? GREEN : RED;
                              return <span style={{ fontWeight: 700, color }}>{value > 0 ? `+${value}` : String(value)}</span>;
                            } },
                          { id: "PrevGrade", header: "Prev Grade", accessor: "Prev Grade" },
                        ] : []),
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
                </>
              )}
            </Flex>
          </Tab>);
              case "Dependencies": return (
          <Tab key={tabId} title="Dependencies">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <Flex alignItems="center" gap={12}>
                <SectionHeader title="Service Topology Map" />
                <Flex alignItems="center" gap={8} style={{ marginLeft: "auto" }}>
                  <Text>Top Services</Text>
                  <div style={{ width: 140 }}>
                    <Select
                      value={depTopN}
                      onChange={(val) => { if (val != null) setDepTopN(val as number); }}
                    >
                      <Select.Content>
                        {DEP_FILTER_OPTIONS.map((n) => (
                          <Select.Option key={n} value={n}>{n === 0 ? "All" : String(n)}</Select.Option>
                        ))}
                      </Select.Content>
                    </Select>
                  </div>
                </Flex>
              </Flex>
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
                  <div className="svc-chart-tile" style={{ minHeight: 500 }}>
                    <div className="chart-title-row">
                      <div className="chart-title">Interactive Topology</div>
                    </div>
                    <div className="chart-description">
                      Nodes sized by request volume, colored by health. Hover to highlight connections. Arrows show call direction (Caller → Callee).
                    </div>
                    <div className="chart-body">
                      <ServiceTopology edges={dependenciesData} services={svcDetailsData} />
                    </div>
                  </div>
                  <SectionHeader title="Dependency Table" />
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
          </Tab>);
              case "Endpoint Heatmap": return (
          <Tab key={tabId} title="Endpoint Heatmap">
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
          </Tab>);
              case "MTTR / MTTA": return (
          <Tab key={tabId} title="MTTR / MTTA">
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
          </Tab>);
              case "Anomaly Detection": return (
          <Tab key={tabId} title="Anomaly Detection">
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
                      { id: "Service", header: "Service", accessor: "Service", cell: serviceLinkCell },
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
          </Tab>);
              case "Incident Timeline": return (
          <Tab key={tabId} title="Incident Timeline">
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
          </Tab>);
              case "Change Impact": return (
          <Tab key={tabId} title="Change Impact">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Change Impact Analysis — Deployment Before/After" />
              <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 12 }}>
                <div className="chart-description">
                  Compares service metrics <strong>3 hours before</strong> vs <strong>3 hours after</strong> each deployment.
                  Latency Δ% and Error Δ (percentage points) indicate regression risk.
                  Verdict: 🟩 Improved | ✅ Healthy | 🟨 Warning | 🟥 Regression
                </div>
              </div>
              {deploymentsResult.isLoading || changeImpactResult.isLoading ? <LoadingState /> : changeImpactData.length === 0 ? (
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 32, textAlign: "center" }}>
                  <Strong>No deployment events found in the last {timeframeDays} days</Strong>
                </div>
              ) : (
                <>
                  <Flex gap={16} flexWrap="wrap">
                    <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                      <div className="chart-title">Deployments</div>
                      <div style={{ fontSize: 32, fontWeight: 700, color: "#4589FF" }}>{changeImpactData.length}</div>
                    </div>
                    <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                      <div className="chart-title">Regressions</div>
                      <div style={{ fontSize: 32, fontWeight: 700, color: RED }}>{changeImpactData.filter((d) => d.Verdict.includes("Regression")).length}</div>
                    </div>
                    <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                      <div className="chart-title">Warnings</div>
                      <div style={{ fontSize: 32, fontWeight: 700, color: YELLOW }}>{changeImpactData.filter((d) => d.Verdict.includes("Warning")).length}</div>
                    </div>
                    <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 200px" }}>
                      <div className="chart-title">Healthy / Improved</div>
                      <div style={{ fontSize: 32, fontWeight: 700, color: GREEN }}>{changeImpactData.filter((d) => d.Verdict.includes("Healthy") || d.Verdict.includes("Improved")).length}</div>
                    </div>
                  </Flex>
                  <div className="svc-table-tile">
                    <DataTable
                      data={changeImpactData}
                      columns={[
                        { id: "Time", header: "Time", accessor: "Time" },
                        { id: "Deployment", header: "Deployment", accessor: "Deployment" },
                        { id: "Service", header: "Service", accessor: "Service", cell: serviceLinkCell },
                        { id: "LatBefore", header: "Latency P90 (Before)", accessor: "Latency P90 (Before)", columnType: "number" as const },
                        { id: "LatAfter", header: "Latency P90 (After)", accessor: "Latency P90 (After)", columnType: "number" as const },
                        { id: "LatDelta", header: "Latency Δ %", accessor: "Latency Δ %", columnType: "number" as const,
                          thresholds: [
                            { comparator: "less-than" as const, value: -10, backgroundColor: GREEN, color: "#000" },
                            { comparator: "greater-than-or-equal-to" as const, value: 20, backgroundColor: YELLOW, color: "#000" },
                            { comparator: "greater-than-or-equal-to" as const, value: 50, backgroundColor: RED, color: "#fff" },
                          ] },
                        { id: "ErrBefore", header: "Error Rate (Before)", accessor: "Error Rate (Before)", columnType: "number" as const },
                        { id: "ErrAfter", header: "Error Rate (After)", accessor: "Error Rate (After)", columnType: "number" as const },
                        { id: "ErrDelta", header: "Error Δ pp", accessor: "Error Δ pp", columnType: "number" as const,
                          thresholds: [
                            { comparator: "less-than" as const, value: 0, backgroundColor: GREEN, color: "#000" },
                            { comparator: "greater-than-or-equal-to" as const, value: 0.5, backgroundColor: YELLOW, color: "#000" },
                            { comparator: "greater-than-or-equal-to" as const, value: 2, backgroundColor: RED, color: "#fff" },
                          ] },
                        { id: "Verdict", header: "Verdict", accessor: "Verdict" },
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
          </Tab>);
              case "Apdex": return (
          <Tab key={tabId} title="Apdex">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title={`Apdex / User Satisfaction — Threshold T = ${apdexT}ms`} />
              <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 12 }}>
                <div className="chart-description">
                  <strong>Apdex</strong> = (Satisfied + Tolerating/2) / Total.
                  <strong> Satisfied:</strong> response ≤ {apdexT}ms |
                  <strong> Tolerating:</strong> {apdexT}ms – {apdexT * 4}ms |
                  <strong> Frustrated:</strong> &gt; {apdexT * 4}ms.
                  Change <strong>T</strong> in Settings (⚙).
                </div>
              </div>
              {apdexResult.isLoading ? <LoadingState /> : apdexData.length === 0 ? (
                <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 32, textAlign: "center" }}>
                  <Strong>No span data found in the last {timeframeDays} days</Strong>
                </div>
              ) : (
                <>
                  {/* Summary cards */}
                  {(() => {
                    const prevLoading = apdexCompare && apdexPrevResult.isLoading;
                    const prevValues = Array.from(apdexPrevMap.values());
                    const prevAvg = prevValues.length > 0 ? prevValues.reduce((s, v) => s + v, 0) / prevValues.length : null;
                    const prevExcellent = prevValues.filter((v) => v >= 0.94).length;
                    const prevGood = prevValues.filter((v) => v >= 0.85 && v < 0.94).length;
                    const prevFair = prevValues.filter((v) => v >= 0.7 && v < 0.85).length;
                    const prevPoor = prevValues.filter((v) => v < 0.7).length;
                    const curAvg = apdexData.length > 0 ? apdexData.reduce((s, d) => s + d.ApdexNum, 0) / apdexData.length : 0;
                    const curExcellent = apdexData.filter((d) => d.ApdexNum >= 0.94).length;
                    const curGood = apdexData.filter((d) => d.ApdexNum >= 0.85 && d.ApdexNum < 0.94).length;
                    const curFair = apdexData.filter((d) => d.ApdexNum >= 0.7 && d.ApdexNum < 0.85).length;
                    const curPoor = apdexData.filter((d) => d.ApdexNum < 0.7).length;
                    const delta = (cur: number, prev: number | null) => {
                      if (prev === null) return null;
                      return cur - prev;
                    };
                    const deltaTag = (d: number | null, higherIsGood = true) => {
                      if (prevLoading) return <span style={{ fontSize: 13, fontWeight: 400, opacity: 0.6 }}>Loading…</span>;
                      if (!apdexCompare || d === null) return null;
                      const sign = d > 0 ? "+" : "";
                      const isNum = typeof d === "number" && Math.abs(d) >= 0.005;
                      const color = !isNum || d === 0 ? "var(--dt-colors-text-secondary)" : (d > 0) === higherIsGood ? GREEN : RED;
                      return <div style={{ fontSize: 13, fontWeight: 500, color, marginTop: 2 }}>{sign}{typeof d === "number" && Math.abs(d) < 100 ? d.toFixed(2) : d}{d !== 0 && isNum ? (d > 0 ? " ▲" : " ▼") : ""}</div>;
                    };
                    const deltaTagInt = (d: number | null, higherIsGood = true) => {
                      if (prevLoading) return <span style={{ fontSize: 13, fontWeight: 400, opacity: 0.6 }}>Loading…</span>;
                      if (!apdexCompare || d === null) return null;
                      const sign = d > 0 ? "+" : "";
                      const color = d === 0 ? "var(--dt-colors-text-secondary)" : (d > 0) === higherIsGood ? GREEN : RED;
                      return <div style={{ fontSize: 13, fontWeight: 500, color, marginTop: 2 }}>{sign}{d}{d !== 0 ? (d > 0 ? " ▲" : " ▼") : ""}</div>;
                    };
                    return (
                    <Flex gap={16} flexWrap="wrap">
                      <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 180px" }}>
                        <div className="chart-title">Services</div>
                        <div style={{ fontSize: 32, fontWeight: 700, color: "#4589FF" }}>{apdexData.length}</div>
                        {deltaTagInt(delta(apdexData.length, prevValues.length > 0 ? prevValues.length : null))}
                      </div>
                      <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 180px" }}>
                        <div className="chart-title">Avg Apdex</div>
                        <div style={{ fontSize: 32, fontWeight: 700, color: curAvg >= 0.94 ? GREEN : curAvg >= 0.85 ? GREEN : curAvg >= 0.7 ? YELLOW : RED }}>
                          {curAvg.toFixed(2)}
                        </div>
                        {deltaTag(delta(curAvg, prevAvg), true)}
                      </div>
                      <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 180px" }}>
                        <div className="chart-title">Excellent (≥0.94)</div>
                        <div style={{ fontSize: 32, fontWeight: 700, color: GREEN }}>{curExcellent} <span style={{ fontSize: 14, fontWeight: 400, opacity: 0.7 }}>services</span></div>
                        {deltaTagInt(delta(curExcellent, prevValues.length > 0 ? prevExcellent : null), true)}
                      </div>
                      <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 180px" }}>
                        <div className="chart-title">Good (0.85–0.94)</div>
                        <div style={{ fontSize: 32, fontWeight: 700, color: GREEN }}>{curGood} <span style={{ fontSize: 14, fontWeight: 400, opacity: 0.7 }}>services</span></div>
                        {deltaTagInt(delta(curGood, prevValues.length > 0 ? prevGood : null), true)}
                      </div>
                      <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 180px" }}>
                        <div className="chart-title">Fair (0.7–0.85)</div>
                        <div style={{ fontSize: 32, fontWeight: 700, color: YELLOW }}>{curFair} <span style={{ fontSize: 14, fontWeight: 400, opacity: 0.7 }}>services</span></div>
                        {deltaTagInt(delta(curFair, prevValues.length > 0 ? prevFair : null), false)}
                      </div>
                      <div className="svc-chart-tile" style={{ minHeight: "auto", padding: 16, flex: "1 1 180px" }}>
                        <div className="chart-title">Poor / Unacceptable (&lt;0.7)</div>
                        <div style={{ fontSize: 32, fontWeight: 700, color: RED }}>{curPoor} <span style={{ fontSize: 14, fontWeight: 400, opacity: 0.7 }}>services</span></div>
                        {deltaTagInt(delta(curPoor, prevValues.length > 0 ? prevPoor : null), false)}
                      </div>
                    </Flex>
                    );
                  })()}
                  {/* Apdex table */}
                  {apdexCompare && apdexPrevResult.isLoading && (
                    <Flex alignItems="center" gap={8} style={{ padding: "8px 16px", background: "var(--dt-colors-surface-default)", borderRadius: 8, marginBottom: 8 }}>
                      <ProgressCircle size="small" />
                      <Text>Loading previous period data for comparison…</Text>
                    </Flex>
                  )}
                  <div className="svc-table-tile">
                    <DataTable
                      data={apdexCompare ? apdexCompareData : apdexData}
                      columns={[
                        { id: "Service", header: "Service", accessor: "Service", cell: serviceLinkCell },
                        { id: "Total", header: "Total Requests", accessor: "Total", columnType: "number" as const },
                        { id: "Apdex", header: "Apdex", accessor: "Apdex" },
                        ...(apdexCompare ? [
                          { id: "PrevApdex", header: "Prev Apdex", accessor: "Prev Apdex" },
                          { id: "DeltaApdex", header: "Δ Apdex", accessor: "Δ Apdex" },
                        ] : []),
                        { id: "Rating", header: "Rating", accessor: "Rating",
                          thresholds: [
                            { comparator: "equal-to" as const, value: "Excellent", backgroundColor: GREEN, color: "#000" },
                            { comparator: "equal-to" as const, value: "Good", backgroundColor: "#2da44e", color: "#fff" },
                            { comparator: "equal-to" as const, value: "Fair", backgroundColor: YELLOW, color: "#000" },
                            { comparator: "equal-to" as const, value: "Poor", backgroundColor: RED, color: "#fff" },
                            { comparator: "equal-to" as const, value: "Unacceptable", backgroundColor: RED, color: "#fff" },
                          ] },
                        { id: "Satisfied", header: "Satisfied", accessor: "Satisfied", columnType: "number" as const },
                        { id: "SatisfiedPct", header: "Satisfied %", accessor: "Satisfied %" },
                        { id: "Tolerating", header: "Tolerating", accessor: "Tolerating", columnType: "number" as const },
                        { id: "ToleratingPct", header: "Tolerating %", accessor: "Tolerating %" },
                        { id: "Frustrated", header: "Frustrated", accessor: "Frustrated", columnType: "number" as const },
                        { id: "FrustratedPct", header: "Frustrated %", accessor: "Frustrated %" },
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
          </Tab>);
              case "Baselines": return (
          <Tab key={tabId} title="Baselines">
            <Flex flexDirection="column" gap={16} paddingTop={16}>
              <SectionHeader title="Service Baselines — Track Latency & Failure Rate Over Time" />
              <div className="svc-table-tile" style={{ padding: 16 }}>
                <strong>How to use:</strong> Save a snapshot of the current service metrics as a named baseline (e.g., "Before deployment", "Post scale-out"). Compare future data against these baselines to verify that changes had the expected effect. Metrics are baselined for the <strong>top 10 services by request count</strong>: Latency Avg, P50, P90, P99 (µs), and Failure Rate (%).
              </div>

              {svcDetailsResult.isLoading ? (
                <LoadingState />
              ) : svcDetailsData.length > 0 ? (
                <>
                  <Heading level={6}>Current Top 10 Services (by Request Count)</Heading>
                  <DataTable
                    data={svcDetailsData.slice(0, 10).sort((a, b) => (b.Requests ?? 0) - (a.Requests ?? 0)).map((s) => ({
                      Service: s.Service,
                      "dt.entity.service": s["dt.entity.service"],
                      "Latency Avg (µs)": Math.round((s.Latency_Avg ?? 0) * 100) / 100,
                      "Latency P50 (µs)": Math.round((s.Latency_p50 ?? 0) * 100) / 100,
                      "Latency P90 (µs)": Math.round((s.Latency_p90 ?? 0) * 100) / 100,
                      "Latency P99 (µs)": Math.round((s.Latency_p99 ?? 0) * 100) / 100,
                      "Failure Rate (%)": Math.round((s.FailureRate ?? 0) * 100) / 100,
                    }))}
                    columns={[
                      { id: "svc", header: "Service", accessor: "Service", cell: serviceLinkCell },
                      { id: "avg", header: "Latency Avg (µs)", accessor: "Latency Avg (µs)", columnType: "number" as const },
                      { id: "p50", header: "Latency P50 (µs)", accessor: "Latency P50 (µs)", columnType: "number" as const },
                      { id: "p90", header: "Latency P90 (µs)", accessor: "Latency P90 (µs)", columnType: "number" as const },
                      { id: "p99", header: "Latency P99 (µs)", accessor: "Latency P99 (µs)", columnType: "number" as const },
                      { id: "fr", header: "Failure Rate (%)", accessor: "Failure Rate (%)", columnType: "number" as const },
                    ]}
                    sortable
                    resizable
                  />

                  <Flex gap={8} alignItems="flex-end" flexWrap="wrap">
                    <Flex flexDirection="column" gap={4} style={{ flex: "1 1 200px" }}>
                      <Strong>Baseline Name</Strong>
                      <input
                        value={baselineName}
                        onChange={(e) => setBaselineName(e.target.value)}
                        placeholder="e.g. Pre-deployment baseline"
                        style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid rgba(99,130,191,0.3)", background: "rgba(30,35,55,0.7)", color: "#d0d4e0", fontSize: 13 }}
                      />
                    </Flex>
                    <Button
                      variant="emphasized"
                      onClick={() => {
                        if (svcDetailsData.length === 0 || !baselineName.trim()) return;
                        const top10 = [...svcDetailsData].sort((a, b) => (b.Requests ?? 0) - (a.Requests ?? 0)).slice(0, 10);
                        setBaselines((prev) => [
                          ...prev,
                          {
                            id: Date.now(),
                            name: baselineName.trim(),
                            timestamp: new Date().toLocaleString(),
                            services: top10.map((s) => ({
                              service: s.Service,
                              latencyAvg: Math.round((s.Latency_Avg ?? 0) * 100) / 100,
                              latencyP50: Math.round((s.Latency_p50 ?? 0) * 100) / 100,
                              latencyP90: Math.round((s.Latency_p90 ?? 0) * 100) / 100,
                              latencyP99: Math.round((s.Latency_p99 ?? 0) * 100) / 100,
                              failureRate: Math.round((s.FailureRate ?? 0) * 100) / 100,
                            })),
                          },
                        ]);
                        setBaselineName("");
                      }}
                      disabled={svcDetailsData.length === 0 || !baselineName.trim()}
                    >
                      Save Current as Baseline
                    </Button>
                  </Flex>
                </>
              ) : null}

              {baselines.length > 0 && (
                <>
                  <Heading level={6}>Saved Baselines vs Current</Heading>
                  <DataTable
                    data={baselines.flatMap((b) => {
                      const currentMap = new Map(svcDetailsData.map((s) => [s.Service, s]));
                      return b.services.map((snap) => {
                        const now = currentMap.get(snap.service);
                        const r = (n: number) => Math.round(n * 100) / 100;
                        return {
                          Baseline: b.name,
                          "Saved At": b.timestamp,
                          Service: snap.service,
                          "dt.entity.service": now ? now["dt.entity.service"] : "",
                          "Avg (then)": snap.latencyAvg,
                          "Avg (now)": now ? r(now.Latency_Avg ?? 0) : 0,
                          "Avg \u0394": now ? r((now.Latency_Avg ?? 0) - snap.latencyAvg) : 0,
                          "P50 (then)": snap.latencyP50,
                          "P50 (now)": now ? r(now.Latency_p50 ?? 0) : 0,
                          "P50 \u0394": now ? r((now.Latency_p50 ?? 0) - snap.latencyP50) : 0,
                          "P90 (then)": snap.latencyP90,
                          "P90 (now)": now ? r(now.Latency_p90 ?? 0) : 0,
                          "P90 \u0394": now ? r((now.Latency_p90 ?? 0) - snap.latencyP90) : 0,
                          "P99 (then)": snap.latencyP99,
                          "P99 (now)": now ? r(now.Latency_p99 ?? 0) : 0,
                          "P99 \u0394": now ? r((now.Latency_p99 ?? 0) - snap.latencyP99) : 0,
                          "Fail% (then)": snap.failureRate,
                          "Fail% (now)": now ? r(now.FailureRate ?? 0) : 0,
                          "Fail% \u0394": now ? r((now.FailureRate ?? 0) - snap.failureRate) : 0,
                          _baselineId: b.id,
                        };
                      });
                    })}
                    columns={[
                      { id: "bl", header: "Baseline", accessor: "Baseline" },
                      { id: "saved", header: "Saved At", accessor: "Saved At" },
                      { id: "svc", header: "Service", accessor: "Service", cell: serviceLinkCell },
                      { id: "avgThen", header: "Avg (then)", accessor: "Avg (then)", columnType: "number" as const },
                      { id: "avgNow", header: "Avg (now)", accessor: "Avg (now)", columnType: "number" as const },
                      { id: "avgD", header: "Avg \u0394", accessor: "Avg \u0394", columnType: "number" as const, thresholds: [{ comparator: "greater-than" as const, value: 0, backgroundColor: RED, color: "#000" }, { comparator: "less-than-or-equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" }] },
                      { id: "p50Then", header: "P50 (then)", accessor: "P50 (then)", columnType: "number" as const },
                      { id: "p50Now", header: "P50 (now)", accessor: "P50 (now)", columnType: "number" as const },
                      { id: "p50D", header: "P50 \u0394", accessor: "P50 \u0394", columnType: "number" as const, thresholds: [{ comparator: "greater-than" as const, value: 0, backgroundColor: RED, color: "#000" }, { comparator: "less-than-or-equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" }] },
                      { id: "p90Then", header: "P90 (then)", accessor: "P90 (then)", columnType: "number" as const },
                      { id: "p90Now", header: "P90 (now)", accessor: "P90 (now)", columnType: "number" as const },
                      { id: "p90D", header: "P90 \u0394", accessor: "P90 \u0394", columnType: "number" as const, thresholds: [{ comparator: "greater-than" as const, value: 0, backgroundColor: RED, color: "#000" }, { comparator: "less-than-or-equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" }] },
                      { id: "p99Then", header: "P99 (then)", accessor: "P99 (then)", columnType: "number" as const },
                      { id: "p99Now", header: "P99 (now)", accessor: "P99 (now)", columnType: "number" as const },
                      { id: "p99D", header: "P99 \u0394", accessor: "P99 \u0394", columnType: "number" as const, thresholds: [{ comparator: "greater-than" as const, value: 0, backgroundColor: RED, color: "#000" }, { comparator: "less-than-or-equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" }] },
                      { id: "frThen", header: "Fail% (then)", accessor: "Fail% (then)", columnType: "number" as const },
                      { id: "frNow", header: "Fail% (now)", accessor: "Fail% (now)", columnType: "number" as const },
                      { id: "frD", header: "Fail% \u0394", accessor: "Fail% \u0394", columnType: "number" as const, thresholds: [{ comparator: "greater-than" as const, value: 0, backgroundColor: RED, color: "#000" }, { comparator: "less-than-or-equal-to" as const, value: 0, backgroundColor: GREEN, color: "#000" }] },
                    ]}
                    sortable
                    resizable
                  >
                    <DataTable.Pagination defaultPageSize={10} />
                  </DataTable>
                  <Flex gap={8} flexWrap="wrap">
                    {baselines.map((b) => (
                      <Button key={b.id} variant="default" onClick={() => setBaselines((prev) => prev.filter((p) => p.id !== b.id))}>
                        Remove "{b.name}"
                      </Button>
                    ))}
                  </Flex>
                </>
              )}
            </Flex>
          </Tab>);
              case "Alert Rules": return (
          <Tab key={tabId} title="Alert Rules">
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
                      { id: "Service", header: "Service", accessor: "Service", cell: serviceLinkCell },
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
          </Tab>);
              case "What-If": return (
          <Tab key={tabId} title="What-If">
            <WhatIfTab
              svcDetailsData={svcDetailsData}
              reqDetailsData={reqDetailsData}
              svcLoading={svcDetailsResult.isLoading}
              reqLoading={reqDetailsResult.isLoading}
              envUrl={envUrl}
              serviceLinkCell={serviceLinkCell}
            />
          </Tab>);
              default: return null;
            }
          })}
        </Tabs>
      </Flex>
    </div>
  );
};
