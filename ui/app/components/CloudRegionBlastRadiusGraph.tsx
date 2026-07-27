import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const RED = "#C21930";
const ORANGE = "#FF8C00";
const BLUE = "#4589FF";
const GREEN = "#24A148";
const HOST_COLOR = "#6929C4";
const AWS_COLOR = "#FF9900";
const AZURE_COLOR = "#008AD7";
const GCP_COLOR = "#34A853";

const MAX_VISIBLE_HOSTS = 20;
const MAX_VISIBLE_SERVICES = 18;
const MAX_VISIBLE_CASCADE = 14;
const HOST_SPACING = 30;
const SVC_SPACING = 32;
const HOST_R = 14;
const SVC_R = 15;
const REGION_R = 30;

function getProvider(region: string): "aws" | "gcp" | "azure" | "unknown" {
  if (/^[a-z]+-[a-z]+-\d+[a-z]?$/.test(region)) return "aws";
  if (/^[a-z]+-[a-z]+\d+$/.test(region)) return "gcp";
  if (/^[a-z]+\d*$/.test(region)) return "azure";
  return "unknown";
}

function getProviderColor(region: string): string {
  const p = getProvider(region);
  if (p === "aws") return AWS_COLOR;
  if (p === "azure") return AZURE_COLOR;
  if (p === "gcp") return GCP_COLOR;
  return BLUE;
}

function formatCount(n: number | undefined): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toLocaleString();
}

function formatMs(val: number | undefined): string {
  if (val == null || isNaN(val)) return "N/A";
  if (val >= 1000) return (val / 1000).toFixed(1) + " s";
  return val.toFixed(1) + " ms";
}

function tfParam(from?: string, to?: string): string {
  if (!from || !to) return "";
  return `tf=${encodeURIComponent(from.replace(/\(\)/g, "") + ";" + to.replace(/\(\)/g, ""))}`;
}

export interface CloudRegionBlastRadiusGraphProps {
  region: string;
  hosts: string[];
  clusters: string[];
  directServices: string[];
  affectedExternalServices: string[];
  serviceEdges: { from: string; to: string }[];
  hostToServices: Map<string, Set<string>>;
  hostIdMap?: Map<string, string>;
  serviceDetails?: Map<string, { entityId: string; requests: number; failureRate: number; latencyP50: number; latencyP90: number }>;
  tfFrom?: string;
  tfTo?: string;
}

interface ColNode {
  id: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  col: "region" | "host" | "service" | "cascade";
  services?: string[];
  serviceCount?: number;
}

export function CloudRegionBlastRadiusGraph({
  region, hosts, clusters, directServices, affectedExternalServices, serviceEdges,
  hostToServices, hostIdMap, serviceDetails, tfFrom = "now()-2h", tfTo = "now()",
}: CloudRegionBlastRadiusGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: ColNode } | null>(null);
  const [tooltipOffset, setTooltipOffset] = useState({ dx: 0, dy: 0 });
  const [draggingTooltip, setDraggingTooltip] = useState(false);
  const [tooltipDragStart, setTooltipDragStart] = useState({ x: 0, y: 0 });
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [animPhase, setAnimPhase] = useState<"idle" | "live">("idle");
  const [animKey, setAnimKey] = useState(0);
  const [edgesSettled, setEdgesSettled] = useState(false);
  const [cascadeActive, setCascadeActive] = useState(false);
  const [cascadeFailedSet, setCascadeFailedSet] = useState<Set<string>>(new Set());
  const [cascadeDegradedSet, setCascadeDegradedSet] = useState<Set<string>>(new Set());
  const [cascadeComplete, setCascadeComplete] = useState(false);
  const [cascadeElapsed, setCascadeElapsed] = useState(0);
  const cascadeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cascadeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const blastTimersRef = useRef<{ live?: ReturnType<typeof setTimeout>; settle?: ReturnType<typeof setTimeout> }>({});
  const envUrl = useMemo(() => getEnvironmentUrl().replace(/\/$/, ""), []);
  const regionColor = useMemo(() => getProviderColor(region), [region]);

  // Sorted visible hosts (hosts with services first)
  const visibleHosts = useMemo(() => {
    const sorted = [...hosts].sort((a, b) => {
      const aCount = hostToServices.get(a)?.size ?? 0;
      const bCount = hostToServices.get(b)?.size ?? 0;
      return bCount - aCount;
    });
    return sorted.slice(0, MAX_VISIBLE_HOSTS);
  }, [hosts, hostToServices]);

  const hiddenHostCount = hosts.length - visibleHosts.length;
  const visibleServices = directServices.slice(0, MAX_VISIBLE_SERVICES);
  const hiddenServiceCount = directServices.length - visibleServices.length;
  const visibleCascade = affectedExternalServices.slice(0, MAX_VISIBLE_CASCADE);
  const hiddenCascadeCount = affectedExternalServices.length - visibleCascade.length;

  // Column x positions (scale with width)
  const colX = useMemo(() => {
    const hasCascade = affectedExternalServices.length > 0;
    const cols = hasCascade ? 4 : 3;
    const pad = 70;
    const usable = width - pad * 2;
    const step = usable / (cols - 0.5);
    return {
      region: pad,
      host: pad + step * 0.85,
      service: pad + step * (hasCascade ? 1.8 : 1.6),
      cascade: pad + step * 2.75,
    };
  }, [width, affectedExternalServices.length]);

  // Canvas height
  const canvasHeight = useMemo(() => {
    const hostH = visibleHosts.length * HOST_SPACING + (hiddenHostCount > 0 ? HOST_SPACING : 0);
    const svcH = visibleServices.length * SVC_SPACING + (hiddenServiceCount > 0 ? SVC_SPACING : 0);
    const cascH = visibleCascade.length * SVC_SPACING + (hiddenCascadeCount > 0 ? SVC_SPACING : 0);
    return Math.max(420, Math.max(hostH, svcH, cascH) + 120);
  }, [visibleHosts.length, hiddenHostCount, visibleServices.length, hiddenServiceCount, visibleCascade.length, hiddenCascadeCount]);

  // Build column nodes
  const baseNodes = useMemo((): ColNode[] => {
    const cy = canvasHeight / 2;
    const nodes: ColNode[] = [];

    // Region node
    nodes.push({ id: "region", label: region, x: colX.region, y: cy, radius: REGION_R, col: "region" });

    // Host nodes
    const hostTotalH = (visibleHosts.length - 1) * HOST_SPACING;
    visibleHosts.forEach((h, i) => {
      const svcs = [...(hostToServices.get(h) ?? new Set())];
      nodes.push({
        id: `host:${h}`, label: h, radius: HOST_R, col: "host",
        x: colX.host, y: cy - hostTotalH / 2 + i * HOST_SPACING,
        services: svcs, serviceCount: svcs.length,
      });
    });
    if (hiddenHostCount > 0) {
      nodes.push({
        id: "host:overflow", label: `+${hiddenHostCount} more`, radius: HOST_R, col: "host",
        x: colX.host, y: cy - hostTotalH / 2 + visibleHosts.length * HOST_SPACING,
        serviceCount: 0,
      });
    }

    // Direct service nodes
    const svcTotalH = (visibleServices.length - 1) * SVC_SPACING;
    visibleServices.forEach((s, i) => {
      nodes.push({
        id: `svc:${s}`, label: s, radius: SVC_R, col: "service",
        x: colX.service, y: cy - svcTotalH / 2 + i * SVC_SPACING,
      });
    });
    if (hiddenServiceCount > 0) {
      nodes.push({
        id: "svc:overflow", label: `+${hiddenServiceCount} more`, radius: SVC_R, col: "service",
        x: colX.service, y: cy - svcTotalH / 2 + visibleServices.length * SVC_SPACING,
      });
    }

    // Cascade service nodes
    const cascTotalH = (visibleCascade.length - 1) * SVC_SPACING;
    visibleCascade.forEach((s, i) => {
      nodes.push({
        id: `casc:${s}`, label: s, radius: SVC_R, col: "cascade",
        x: colX.cascade, y: cy - cascTotalH / 2 + i * SVC_SPACING,
      });
    });
    if (hiddenCascadeCount > 0) {
      nodes.push({
        id: "casc:overflow", label: `+${hiddenCascadeCount} more`, radius: SVC_R, col: "cascade",
        x: colX.cascade, y: cy - cascTotalH / 2 + visibleCascade.length * SVC_SPACING,
      });
    }

    return nodes;
  }, [region, visibleHosts, hiddenHostCount, visibleServices, hiddenServiceCount, visibleCascade, hiddenCascadeCount, hostToServices, colX, canvasHeight]);

  const nodes = useMemo(() => baseNodes.map(n => {
    const off = nodeOffsets[n.id];
    return off ? { ...n, x: n.x + off.dx, y: n.y + off.dy } : n;
  }), [baseNodes, nodeOffsets]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, ColNode>();
    nodes.forEach(n => m.set(n.id, n));
    return m;
  }, [nodes]);

  // Edges: region→host, host→service, service→cascade
  const edges = useMemo(() => {
    const result: { from: string; to: string; type: "region-host" | "host-svc" | "svc-casc" }[] = [];
    // Region → each host
    visibleHosts.forEach(h => result.push({ from: "region", to: `host:${h}`, type: "region-host" }));
    // Host → direct services it hosts
    visibleHosts.forEach(h => {
      const svcs = hostToServices.get(h) ?? new Set();
      svcs.forEach(s => {
        if (visibleServices.includes(s)) result.push({ from: `host:${h}`, to: `svc:${s}`, type: "host-svc" });
      });
    });
    // Direct service → cascade (using serviceEdges: from=caller(cascade), to=callee(direct))
    serviceEdges.forEach(e => {
      const cascId = `casc:${e.from}`;
      const svcId = `svc:${e.to}`;
      if (nodeMap.has(cascId) && nodeMap.has(svcId)) {
        result.push({ from: svcId, to: cascId, type: "svc-casc" });
      }
    });
    // Fallback: if no service edges but there are cascade services, connect all direct→cascade
    if (affectedExternalServices.length > 0 && !serviceEdges.some(e => visibleCascade.includes(e.from))) {
      visibleServices.slice(0, 5).forEach(s => {
        visibleCascade.slice(0, 5).forEach(c => {
          result.push({ from: `svc:${s}`, to: `casc:${c}`, type: "svc-casc" });
        });
      });
    }
    return result;
  }, [visibleHosts, visibleServices, visibleCascade, hostToServices, serviceEdges, affectedExternalServices.length, nodeMap]);

  const activeNode = pinned ?? hovered;

  const connectedNodes = useMemo(() => {
    if (!activeNode) return new Set<string>();
    const s = new Set<string>([activeNode]);
    edges.forEach(e => {
      if (e.from === activeNode) s.add(e.to);
      if (e.to === activeNode) s.add(e.from);
    });
    return s;
  }, [activeNode, edges]);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      if (w > 0) setWidth(w);
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Entry animation
  const triggerAnimation = useCallback(() => {
    clearTimeout(blastTimersRef.current.live);
    clearTimeout(blastTimersRef.current.settle);
    setAnimPhase("idle");
    setEdgesSettled(false);
    setAnimKey(k => k + 1);
    blastTimersRef.current.live = setTimeout(() => setAnimPhase("live"), 50);
    blastTimersRef.current.settle = setTimeout(() => setEdgesSettled(true), 2200);
  }, []);

  useEffect(() => { triggerAnimation(); }, [region]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cascade simulation
  const stopCascade = useCallback(() => {
    cascadeTimersRef.current.forEach(clearTimeout);
    cascadeTimersRef.current = [];
    if (cascadeIntervalRef.current) { clearInterval(cascadeIntervalRef.current); cascadeIntervalRef.current = null; }
    setCascadeActive(false); setCascadeFailedSet(new Set()); setCascadeDegradedSet(new Set());
    setCascadeElapsed(0); setCascadeComplete(false);
  }, []);

  const startCascade = useCallback(() => {
    stopCascade();
    setCascadeActive(true); setCascadeComplete(false);
    setCascadeFailedSet(new Set(["region"]));
    let e = 0;
    cascadeIntervalRef.current = setInterval(() => { e++; setCascadeElapsed(e); }, 1000);
    // Hosts fail
    visibleHosts.forEach((h, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(`host:${h}`); return s; }), 600 + i * 80),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(`host:${h}`); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(`host:${h}`); return s; }); }, 1000 + i * 80)
      );
    });
    const hostEnd = 1000 + Math.max(0, visibleHosts.length - 1) * 80 + 500;
    // Direct services fail
    visibleServices.forEach((s, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const ns = new Set(p); ns.add(`svc:${s}`); return ns; }), hostEnd + i * 120),
        setTimeout(() => { setCascadeFailedSet(p => { const ns = new Set(p); ns.add(`svc:${s}`); return ns; }); setCascadeDegradedSet(p => { const ns = new Set(p); ns.delete(`svc:${s}`); return ns; }); }, hostEnd + 400 + i * 120)
      );
    });
    const svcEnd = hostEnd + 400 + Math.max(0, visibleServices.length - 1) * 120 + 500;
    // Cascade services degrade
    visibleCascade.forEach((s, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const ns = new Set(p); ns.add(`casc:${s}`); return ns; }), svcEnd + i * 150)
      );
    });
    const total = svcEnd + Math.max(0, visibleCascade.length - 1) * 150 + 800;
    cascadeTimersRef.current.push(setTimeout(() => setCascadeComplete(true), total));
  }, [visibleHosts, visibleServices, visibleCascade, stopCascade]);

  useEffect(() => () => stopCascade(), [stopCascade]);

  // Drag node
  const handleNodeMouseDown = useCallback((id: string, evt: React.MouseEvent) => {
    evt.stopPropagation(); evt.preventDefault();
    setDragNode(id);
  }, []);

  useEffect(() => {
    if (!dragNode) return;
    const move = (evt: MouseEvent) => {
      const svg = containerRef.current?.querySelector("svg");
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const base = baseNodes.find(n => n.id === dragNode);
      if (!base) return;
      setNodeOffsets(prev => ({ ...prev, [dragNode]: { dx: evt.clientX - rect.left - base.x, dy: evt.clientY - rect.top - base.y } }));
    };
    const up = () => setDragNode(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [dragNode, baseNodes]);

  // Tooltip drag
  const handleTooltipMouseDown = useCallback((evt: React.MouseEvent) => {
    evt.preventDefault(); evt.stopPropagation();
    setDraggingTooltip(true);
    setTooltipDragStart({ x: evt.clientX - tooltipOffset.dx, y: evt.clientY - tooltipOffset.dy });
  }, [tooltipOffset]);

  useEffect(() => {
    if (!draggingTooltip) return;
    const move = (evt: MouseEvent) => setTooltipOffset({ dx: evt.clientX - tooltipDragStart.x, dy: evt.clientY - tooltipDragStart.y });
    const up = () => setDraggingTooltip(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [draggingTooltip, tooltipDragStart]);

  const nodeToScreen = useCallback((node: ColNode): { x: number; y: number } => {
    const svg = containerRef.current?.querySelector("svg") as SVGSVGElement | null;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: rect.left + node.x, y: rect.top + node.y };
  }, []);

  const handleMouseEnter = useCallback((node: ColNode) => {
    if (dragNode) return;
    setHovered(node.id);
    if (!pinned) {
      const pos = nodeToScreen(node);
      setTooltipOffset({ dx: 0, dy: 0 });
      setTooltip({ x: pos.x, y: pos.y, node });
    }
  }, [dragNode, pinned, nodeToScreen]);

  const handleMouseLeave = useCallback(() => {
    setHovered(null);
    if (!pinned) setTooltip(null);
  }, [pinned]);

  const handleClick = useCallback((node: ColNode) => {
    if (node.id.endsWith(":overflow")) return;
    if (pinned === node.id) { setPinned(null); setTooltip(null); }
    else {
      setPinned(node.id);
      const pos = nodeToScreen(node);
      setTooltipOffset({ dx: 0, dy: 0 });
      setTooltip({ x: pos.x, y: pos.y, node });
    }
  }, [pinned, nodeToScreen]);

  const isIdle = animPhase === "idle";
  const cy = canvasHeight / 2;

  function nodeColor(n: ColNode): string {
    if (n.col === "region") return regionColor;
    if (n.col === "host") return HOST_COLOR;
    if (n.col === "service") return RED;
    return ORANGE;
  }

  function nodeFill(n: ColNode): string {
    if (n.col === "region") return `${regionColor}22`;
    if (n.col === "host") return "rgba(105,41,196,0.2)";
    if (n.col === "service") return "rgba(194,25,48,0.18)";
    return "rgba(255,140,0,0.12)";
  }

  function edgeColor(type: string): string {
    if (type === "region-host") return `${regionColor}55`;
    if (type === "host-svc") return "rgba(105,41,196,0.35)";
    return "rgba(194,25,48,0.35)";
  }
  function edgeColorHL(type: string): string {
    if (type === "region-host") return regionColor;
    if (type === "host-svc") return HOST_COLOR;
    return RED;
  }

  return (
    <div ref={containerRef} style={{ width: "100%", position: "relative", borderRadius: 8, border: "1px solid rgba(99,130,191,0.15)", overflow: "hidden" }}>
      {/* Toolbar */}
      <div style={{ position: "absolute", top: 8, right: 12, zIndex: 10, display: "flex", gap: 8, alignItems: "center", fontSize: 11 }}>
        {cascadeActive && (
          <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: cascadeComplete ? ORANGE : RED, background: "rgba(194,25,48,0.12)", border: `1px solid ${cascadeComplete ? ORANGE : RED}`, borderRadius: 6, padding: "2px 8px" }}>
            {cascadeComplete ? `⚠ CASCADED — ${cascadeFailedSet.size} FAILING` : `⚡ T+${String(Math.floor(cascadeElapsed / 60)).padStart(2, "0")}:${String(cascadeElapsed % 60).padStart(2, "0")}`}
          </span>
        )}
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: regionColor, marginRight: 3 }} />Region</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: HOST_COLOR, marginRight: 3 }} />Host</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: RED, marginRight: 3 }} />Down</span>
        {affectedExternalServices.length > 0 && <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: ORANGE, marginRight: 3 }} />Cascade</span>}
        {cascadeActive
          ? <button onClick={stopCascade} style={{ background: "rgba(194,25,48,0.2)", border: "1px solid rgba(194,25,48,0.5)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: RED, cursor: "pointer", fontWeight: 600 }}>■ Stop</button>
          : <button onClick={startCascade} style={{ background: "rgba(69,137,255,0.12)", border: "1px solid rgba(69,137,255,0.35)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: BLUE, cursor: "pointer", fontWeight: 600 }}>⚡ Simulate</button>
        }
        <button onClick={() => { stopCascade(); setNodeOffsets({}); setPinned(null); setTooltip(null); setAnimKey(k => k + 1); setTimeout(() => triggerAnimation(), 10); }} style={{ background: "rgba(99,130,191,0.15)", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>Reset</button>
      </div>

      {/* Column headers */}
      {!isIdle && (
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", pointerEvents: "none" }}>
          {[
            { x: colX.region, label: "Region" },
            { x: colX.host, label: `Hosts (${hosts.length})` },
            { x: colX.service, label: `Direct Down (${directServices.length})` },
            ...(affectedExternalServices.length > 0 ? [{ x: colX.cascade, label: `Cascade (${affectedExternalServices.length})` }] : []),
          ].map(h => (
            <span key={h.label} style={{ position: "absolute", left: h.x, top: 6, transform: "translateX(-50%)", fontSize: 10, opacity: 0.45, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>
              {h.label}
            </span>
          ))}
        </div>
      )}

      <svg width={width} height={canvasHeight} style={{ display: "block", cursor: dragNode ? "move" : "default" }}
        onClick={e => { if ((e.target as Element).closest("circle") || (e.target as Element).closest("text")) return; if (pinned) { setPinned(null); setTooltip(null); } }}>
        <defs>
          <marker id="cr-arrow" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
            <polygon points="0 0, 7 2.5, 0 5" fill="rgba(194,25,48,0.5)" />
          </marker>
          <marker id="cr-arrow-hl" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
            <polygon points="0 0, 7 2.5, 0 5" fill={RED} />
          </marker>
          <marker id="cr-arrow-casc" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
            <polygon points="0 0, 7 2.5, 0 5" fill="rgba(255,140,0,0.5)" />
          </marker>
          <filter id="cr-glow"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <filter id="cr-glow-strong"><feGaussianBlur stdDeviation="10" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>

        {/* Shockwave on entry */}
        {animPhase === "live" && [0, 1, 2].map(i => (
          <circle key={`wave-${animKey}-${i}`} cx={colX.region} cy={cy} r={REGION_R} fill="none"
            stroke={i === 0 ? regionColor : i === 1 ? RED : ORANGE} strokeWidth={2.5 - i * 0.6} opacity={0}>
            <animate attributeName="r" from={String(REGION_R)} to={String(220 + i * 60)} dur={`${0.85 + i * 0.25}s`} begin={`${i * 0.15}s`} fill="freeze" calcMode="spline" keySplines="0.1 0.8 0.2 1" />
            <animate attributeName="opacity" values={`0;${0.6 - i * 0.15};0`} dur={`${0.85 + i * 0.25}s`} begin={`${i * 0.15}s`} fill="freeze" />
          </circle>
        ))}
        {animPhase === "live" && (
          <circle key={`flash-${animKey}`} cx={colX.region} cy={cy} r={REGION_R} fill={regionColor} opacity={0} filter="url(#cr-glow-strong)">
            <animate attributeName="opacity" values="0;0.85;0" dur="0.5s" fill="freeze" />
            <animate attributeName="r" from={String(REGION_R)} to={String(REGION_R + 30)} dur="0.5s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.4 1" />
          </circle>
        )}

        {/* Edges */}
        {edges.map((e, i) => {
          const src = nodeMap.get(e.from);
          const tgt = nodeMap.get(e.to);
          if (!src || !tgt) return null;
          const dx = tgt.x - src.x;
          const dy = tgt.y - src.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const x1 = src.x + (dx / dist) * src.radius;
          const y1 = src.y + (dy / dist) * src.radius;
          const x2 = tgt.x - (dx / dist) * (tgt.radius + (e.type === "svc-casc" ? 5 : 3));
          const y2 = tgt.y - (dy / dist) * (tgt.radius + (e.type === "svc-casc" ? 5 : 3));
          const isHl = activeNode && (activeNode === e.from || activeNode === e.to);
          const dimmed = activeNode && !isHl;
          const edgeOpacity = isIdle ? 0 : dimmed ? 0.05 : (e.type === "region-host" ? 0.3 : e.type === "host-svc" ? 0.4 : 0.6);
          const hasArrow = e.type === "svc-casc";
          const stroke = isHl ? edgeColorHL(e.type) : edgeColor(e.type);
          const dashLen = Math.ceil(dist);

          return (
            <line key={`e-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={stroke}
              strokeWidth={isHl ? 2 : 1}
              strokeDasharray={e.type === "host-svc" ? "3 3" : undefined}
              markerEnd={hasArrow ? (isHl ? "url(#cr-arrow-hl)" : "url(#cr-arrow-casc)") : undefined}
              opacity={edgeOpacity}
              style={{ transition: edgesSettled ? "opacity 0.2s" : isIdle ? "none" : `opacity 0.4s ease ${0.5 + i * 0.02}s` }}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((n, idx) => {
          const isOverflow = n.id.endsWith(":overflow");
          const isRegion = n.col === "region";
          const isHl = activeNode === n.id;
          const dimmed = !!(activeNode && !connectedNodes.has(n.id));
          const cascFailed = cascadeActive && cascadeFailedSet.has(n.id);
          const cascDeg = cascadeActive && cascadeDegradedSet.has(n.id);
          const cascHealthy = cascadeActive && !cascFailed && !cascDeg;
          const strokeColor = cascFailed ? RED : cascDeg ? ORANGE : nodeColor(n);
          const fillColor = cascFailed ? "rgba(194,25,48,0.4)" : cascDeg ? "rgba(255,140,0,0.3)" : cascHealthy ? "rgba(99,130,191,0.08)" : nodeFill(n);
          const icon = cascFailed ? "💀" : cascDeg ? "🔥" : isRegion ? "🌍" : n.col === "host" ? "🖥" : "⚙";

          const colI = ["region", "host", "service", "cascade"].indexOf(n.col);
          const rowI = nodes.filter(x => x.col === n.col).indexOf(n);
          const delayMs = isRegion ? 0 : colI * 120 + rowI * 35;
          const startX = isRegion ? 0 : colX.region - n.x;
          const offsetX = !isRegion && isIdle ? startX : 0;
          const nodeOpacity = !isRegion && isIdle ? 0 : 1;

          return (
            <g key={n.id}
              onMouseEnter={() => handleMouseEnter(n)}
              onMouseLeave={handleMouseLeave}
              onClick={() => handleClick(n)}
              onMouseDown={e => handleNodeMouseDown(n.id, e)}
              style={{
                transform: `translate(${offsetX}px, 0px)`,
                opacity: nodeOpacity,
                cursor: isOverflow ? "default" : (dragNode === n.id ? "move" : "pointer"),
                transition: isIdle ? "none" : `transform 1.5s cubic-bezier(0.34,1.45,0.64,1) ${delayMs}ms, opacity 0.5s ease ${delayMs}ms`,
              }}
            >
              {/* Pulse for region */}
              {isRegion && (
                <circle cx={n.x} cy={n.y} r={n.radius + 6} fill="none" stroke={regionColor} strokeWidth={1.5} opacity={0.25} filter="url(#cr-glow)">
                  <animate attributeName="r" from={n.radius + 3} to={n.radius + 18} dur="2.5s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.3" to="0" dur="2.5s" repeatCount="indefinite" />
                </circle>
              )}
              {/* Failed pulse */}
              {cascFailed && !isOverflow && (
                <circle cx={n.x} cy={n.y} r={n.radius + 6} fill="none" stroke={RED} strokeWidth={1.5} opacity={0.4} filter="url(#cr-glow)">
                  <animate attributeName="r" from={n.radius + 3} to={n.radius + 14} dur="1.1s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.5" to="0" dur="1.1s" repeatCount="indefinite" />
                </circle>
              )}
              {/* Ring */}
              <circle cx={n.x} cy={n.y} r={n.radius + 2}
                fill="none" stroke={isOverflow ? "rgba(255,255,255,0.2)" : strokeColor}
                strokeWidth={isRegion ? 2.5 : 1.5}
                strokeDasharray={isOverflow ? "3 3" : undefined}
                opacity={dimmed ? 0.15 : cascHealthy ? 0.3 : 1}
                style={{ transition: "stroke 0.4s, opacity 0.2s" }}
              />
              {/* Fill */}
              <circle cx={n.x} cy={n.y} r={n.radius}
                fill={isOverflow ? "rgba(99,130,191,0.08)" : fillColor}
                stroke={isHl ? "#fff" : "none"}
                strokeWidth={isHl ? 1.5 : 0}
                opacity={dimmed ? 0.15 : cascHealthy ? 0.35 : 1}
                style={{ transition: "fill 0.4s, opacity 0.2s" }}
              />
              {/* Icon */}
              <text x={n.x} y={n.y + (isRegion ? 6 : 5)} textAnchor="middle" fontSize={isRegion ? 16 : isOverflow ? 10 : 11} style={{ pointerEvents: "none" }}>
                {isOverflow ? n.label : icon}
              </text>
              {/* Label below */}
              {!isOverflow && (
                <text x={n.x} y={n.y + n.radius + 13} textAnchor="middle"
                  fill={dimmed ? "rgba(255,255,255,0.12)" : cascHealthy ? "rgba(255,255,255,0.28)" : cascFailed ? RED : "rgba(255,255,255,0.82)"}
                  fontSize={isRegion ? 12 : 9}
                  fontWeight={isRegion || isHl ? 700 : 400}
                  style={{ transition: "fill 0.4s", pointerEvents: "none" }}
                >
                  {n.label.length > (isRegion ? 30 : 18) ? n.label.slice(0, isRegion ? 28 : 16) + "…" : n.label}
                </text>
              )}
              {/* Service count badge for hosts */}
              {n.col === "host" && !isOverflow && n.serviceCount != null && (
                <text x={n.x} y={n.y + n.radius + 23} textAnchor="middle"
                  fill={dimmed ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)"}
                  fontSize={8} style={{ pointerEvents: "none" }}>
                  {n.serviceCount} svc{n.serviceCount !== 1 ? "s" : ""}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (() => {
        const n = tooltip.node;
        if (n.id.endsWith(":overflow")) return null;
        const ttW = 272;
        const ttH = 280;
        const left = Math.max(8, Math.min(tooltip.x + 14 + tooltipOffset.dx, window.innerWidth - ttW - 8));
        const top = Math.max(8, Math.min(tooltip.y - 16 + tooltipOffset.dy, window.innerHeight - ttH - 8));
        const isHost = n.col === "host";
        const isSvc = n.col === "service" || n.col === "cascade";
        const svcName = n.label;
        const svcInfo = isSvc ? serviceDetails?.get(svcName) : undefined;
        const hostId = isHost ? hostIdMap?.get(n.label) : undefined;

        return createPortal(
          <div style={{ position: "fixed", left, top, background: "#1c2033", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 12, fontSize: 13, color: "#fff", zIndex: 10001, minWidth: 240, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", pointerEvents: pinned ? "auto" : "none" }}>
            <div onMouseDown={pinned ? handleTooltipMouseDown : undefined}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px 9px", borderBottom: "1px solid rgba(99,130,191,0.15)", cursor: pinned ? "grab" : "default", userSelect: "none" }}>
              <span style={{ fontSize: 15 }}>{n.col === "region" ? "🌍" : isHost ? "🖥️" : "⚙️"}</span>
              <span style={{ fontWeight: 700, flex: 1, fontSize: 12 }}>{n.label}</span>
              {pinned && <span onClick={() => { setPinned(null); setTooltip(null); }} style={{ cursor: "pointer", fontSize: 16, color: "rgba(255,255,255,0.4)" }}>×</span>}
            </div>
            <div style={{ padding: "10px 14px" }}>
              {n.col === "region" && (
                <>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>Cloud region outage simulation</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div><div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase" }}>Hosts</div><div style={{ fontSize: 18, fontWeight: 700, color: HOST_COLOR }}>{hosts.length}</div></div>
                    <div><div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase" }}>Clusters</div><div style={{ fontSize: 18, fontWeight: 700, color: BLUE }}>{clusters.length}</div></div>
                    <div><div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase" }}>Direct Down</div><div style={{ fontSize: 18, fontWeight: 700, color: RED }}>{directServices.length}</div></div>
                    <div><div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase" }}>Cascade</div><div style={{ fontSize: 18, fontWeight: 700, color: ORANGE }}>{affectedExternalServices.length}</div></div>
                  </div>
                </>
              )}
              {isHost && (
                <>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 4 }}>HOST IN REGION — will fail</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: HOST_COLOR }}>{n.serviceCount} service{n.serviceCount !== 1 ? "s" : ""}</div>
                  {n.services && n.services.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.55)", maxHeight: 100, overflow: "auto" }}>
                      {n.services.slice(0, 8).map(s => <div key={s} style={{ padding: "1px 0" }}>• {s}</div>)}
                      {n.services.length > 8 && <div style={{ opacity: 0.5 }}>+{n.services.length - 8} more</div>}
                    </div>
                  )}
                  {hostId && (
                    <a href={`${envUrl}/ui/apps/dynatrace.infraops/explorer/Hosts?detailsId=${encodeURIComponent(hostId)}&${tfParam(tfFrom, tfTo)}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{ display: "block", marginTop: 10, padding: "5px 10px", background: "rgba(69,137,255,0.1)", borderRadius: 6, color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>
                      🔗 Host Details ›
                    </a>
                  )}
                </>
              )}
              {isSvc && (
                <>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 6 }}>
                    {n.col === "service" ? "DIRECT OUTAGE — service will go down" : "CASCADE IMPACT — caller will be affected"}
                  </div>
                  {svcInfo ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      <div><div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase" }}>Requests</div><div style={{ fontSize: 17, fontWeight: 700 }}>{formatCount(svcInfo.requests)}</div></div>
                      <div><div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase" }}>Error Rate</div><div style={{ fontSize: 17, fontWeight: 700, color: svcInfo.failureRate >= 2 ? RED : "inherit" }}>{svcInfo.failureRate.toFixed(2)}%</div></div>
                      <div><div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase" }}>P50</div><div style={{ fontSize: 17, fontWeight: 700 }}>{formatMs(svcInfo.latencyP50)}</div></div>
                      <div><div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase" }}>P90</div><div style={{ fontSize: 17, fontWeight: 700 }}>{formatMs(svcInfo.latencyP90)}</div></div>
                    </div>
                  ) : <div style={{ fontSize: 11, opacity: 0.5 }}>No metric data for this service</div>}
                  {svcInfo?.entityId && (
                    <a href={`${envUrl}/ui/apps/dynatrace.services/explorer/services?detailsId=${svcInfo.entityId}&${tfParam(tfFrom, tfTo)}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{ display: "block", marginTop: 10, padding: "5px 10px", background: "rgba(69,137,255,0.1)", borderRadius: 6, color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>
                      🔗 Service Details ›
                    </a>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body
        );
      })()}
    </div>
  );
}
