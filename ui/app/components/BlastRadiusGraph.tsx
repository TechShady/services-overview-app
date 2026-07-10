import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const RED = "#C21930";
const RED_LIGHT = "rgba(194, 25, 48, 0.7)";
const ORANGE = "#FF8C00";
const YELLOW = "#FCD53F";
const BLUE = "#4589FF";

// Service types for which Smartscape vertical-topology has no data
const NON_DRILLDOWN_TYPES = new Set(["DATABASE_SERVICE", "MESSAGING_SERVICE", "EXTERNAL_SERVICE"]);

interface BlastRadiusGraphProps {
  target: string;
  directlyAffected: string[];
  indirectlyAffected: string[];
  edges: { Caller: string; Callee: string }[];
  services: { Service: string; "dt.entity.service"?: string; Requests?: number; FailureRate?: number; Latency_p50?: number; Latency_p90?: number; Status?: string }[];
  entityIdMap: Map<string, string>;
  entityTypeMap?: Map<string, string>;
  dbEntityMap?: Map<string, string>;
  propagatedFailureByService?: Record<string, number>;
  expectedFailedRequestsByService?: Record<string, number>;
  serviceDepthByService?: Record<string, number>;
  tfFrom?: string;
  tfTo?: string;
  fromMs?: number;
  toMs?: number;
}

interface NodeData {
  name: string;
  x: number;
  y: number;
  radius: number;
  ring: "target" | "direct" | "indirect";
  entityId: string;
  requests: number;
  failureRate: number;
  latencyP50: number;
  latencyP90: number;
  status: string;
  hasMetrics: boolean;
  simulatedFailure: number;
  expectedFailedRequests: number;
  depth: number;
}

function formatMs(val: number | undefined): string {
  if (val == null || isNaN(val)) return "N/A";
  if (val >= 1000) return (val / 1000).toFixed(1) + " s";
  return val.toFixed(1) + " ms";
}

function formatCount(val: number | undefined): string {
  if (val == null) return "0";
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
  if (val >= 1_000) return (val / 1_000).toFixed(1) + "k";
  return val.toLocaleString();
}

function getNodeColor(ring: string): string {
  if (ring === "target") return RED;
  if (ring === "direct") return RED_LIGHT;
  return ORANGE;
}

function getNodeFill(ring: string): string {
  if (ring === "target") return RED;
  if (ring === "direct") return "rgba(194, 25, 48, 0.25)";
  return "rgba(255, 140, 0, 0.15)";
}

export function BlastRadiusGraph({ target, directlyAffected, indirectlyAffected, edges, services, entityIdMap, entityTypeMap, dbEntityMap, propagatedFailureByService, expectedFailedRequestsByService, serviceDepthByService, tfFrom = "now()-2h", tfTo = "now()", fromMs, toMs }: BlastRadiusGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 500 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: NodeData } | null>(null);
  const [tooltipOffset, setTooltipOffset] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [draggingTooltip, setDraggingTooltip] = useState(false);
  const [tooltipDragStart, setTooltipDragStart] = useState({ x: 0, y: 0 });
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const envUrl = useMemo(() => getEnvironmentUrl().replace(/\/$/, ""), []);

  // ── Animation state ──────────────────────────────────────────────────────────
  const [animPhase, setAnimPhase] = useState<"idle" | "live">("idle");
  const [animKey, setAnimKey] = useState(0);
  const [edgesSettled, setEdgesSettled] = useState(false);
  // animTrigger lets external actions (Reset button) replay the animation
  const [animTrigger, setAnimTrigger] = useState(0);
  const blastTimersRef = useRef<{ live?: ReturnType<typeof setTimeout>; settle?: ReturnType<typeof setTimeout> }>({});

  const triggerAnimation = useCallback(() => {
    clearTimeout(blastTimersRef.current.live);
    clearTimeout(blastTimersRef.current.settle);
    setAnimPhase("idle");
    setEdgesSettled(false);
    setAnimKey(k => k + 1);
    // 50 ms gives React time to commit the "idle" frame before starting transitions
    blastTimersRef.current.live = setTimeout(() => setAnimPhase("live"), 50);
    blastTimersRef.current.settle = setTimeout(() => setEdgesSettled(true), 2450);
  }, []);

  useEffect(() => {
    if (!target) return;
    triggerAnimation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, animTrigger]);
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Cascade Failure Simulation ───────────────────────────────────────────────
  const [cascadeActive, setCascadeActive] = useState(false);
  const [cascadeFailedSet, setCascadeFailedSet] = useState<Set<string>>(new Set());
  const [cascadeDegradedSet, setCascadeDegradedSet] = useState<Set<string>>(new Set());
  const [cascadeElapsed, setCascadeElapsed] = useState(0);
  const [cascadeComplete, setCascadeComplete] = useState(false);
  const cascadeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cascadeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopCascade = useCallback(() => {
    cascadeTimersRef.current.forEach(clearTimeout);
    cascadeTimersRef.current = [];
    if (cascadeIntervalRef.current) { clearInterval(cascadeIntervalRef.current); cascadeIntervalRef.current = null; }
    setCascadeActive(false);
    setCascadeFailedSet(new Set());
    setCascadeDegradedSet(new Set());
    setCascadeElapsed(0);
    setCascadeComplete(false);
  }, []);

  const startCascade = useCallback(() => {
    stopCascade();
    setCascadeActive(true);
    setCascadeComplete(false);
    setCascadeFailedSet(new Set([target]));
    setCascadeDegradedSet(new Set());
    let e = 0;
    cascadeIntervalRef.current = setInterval(() => { e++; setCascadeElapsed(e); }, 1000);
    directlyAffected.forEach((name, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(name); return s; }), 1400 + i * 380),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(name); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(name); return s; }); }, 2300 + i * 380)
      );
    });
    const directEnd = 2300 + Math.max(0, directlyAffected.length - 1) * 380 + 600;
    indirectlyAffected.forEach((name, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(name); return s; }), directEnd + i * 260),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(name); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(name); return s; }); }, directEnd + 700 + i * 260)
      );
    });
    const totalDone = directEnd + 700 + Math.max(0, indirectlyAffected.length - 1) * 260 + 500;
    cascadeTimersRef.current.push(setTimeout(() => setCascadeComplete(true), totalDone));
  }, [target, directlyAffected, indirectlyAffected, stopCascade]);

  useEffect(() => () => stopCascade(), [stopCascade]);
  // ─────────────────────────────────────────────────────────────────────────────

  const activeNode = pinned ?? hovered;

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) setDimensions({ width, height: Math.max(400, Math.min(600, width * 0.55)) });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const svcMap = useMemo(() => {
    const m = new Map<string, { entityId: string; requests: number; failureRate: number; latencyP50: number; latencyP90: number; status: string; hasMetrics: boolean }>();
    services.forEach(s => m.set(s.Service, {
      entityId: s["dt.entity.service"] ?? "",
      requests: s.Requests ?? 0,
      failureRate: s.FailureRate ?? 0,
      latencyP50: s.Latency_p50 ?? 0,
      latencyP90: s.Latency_p90 ?? 0,
      status: s.Status ?? "",
      hasMetrics: true,
    }));
    entityIdMap.forEach((id, name) => {
      if (!m.has(name)) m.set(name, { entityId: id, requests: 0, failureRate: 0, latencyP50: 0, latencyP90: 0, status: "", hasMetrics: false });
      else if (!m.get(name)!.entityId) m.get(name)!.entityId = id;
    });
    return m;
  }, [services, entityIdMap]);

  // Base layout: target in center, direct callers in inner ring, indirect in outer ring
  const baseNodes = useMemo((): NodeData[] => {
    const { width, height } = dimensions;
    const cx = width / 2;
    const cy = height / 2;
    const result: NodeData[] = [];

    const getSvcData = (name: string) => svcMap.get(name) ?? { entityId: "", requests: 0, failureRate: 0, latencyP50: 0, latencyP90: 0, status: "", hasMetrics: false };
    const getSimulatedFailure = (name: string) => Math.max(0, Math.min(1, propagatedFailureByService?.[name] ?? (name === target ? 1 : 0)));
    const getExpectedFailedRequests = (name: string) => Math.max(0, expectedFailedRequestsByService?.[name] ?? 0);
    const getDepth = (name: string) => serviceDepthByService?.[name] ?? (name === target ? 0 : -1);

    // Target node (center)
    const tData = getSvcData(target);
    result.push({
      name: target, x: cx, y: cy, radius: 28, ring: "target",
      entityId: tData.entityId, requests: tData.requests, failureRate: tData.failureRate,
      latencyP50: tData.latencyP50, latencyP90: tData.latencyP90, status: tData.status, hasMetrics: tData.hasMetrics,
      simulatedFailure: getSimulatedFailure(target), expectedFailedRequests: getExpectedFailedRequests(target), depth: getDepth(target),
    });

    // Direct callers — inner ring
    const innerRadius = Math.min(width, height) * 0.28;
    directlyAffected.forEach((name, i) => {
      const angle = (2 * Math.PI * i) / Math.max(directlyAffected.length, 1) - Math.PI / 2;
      const d = getSvcData(name);
      result.push({
        name, x: cx + innerRadius * Math.cos(angle), y: cy + innerRadius * Math.sin(angle),
        radius: 20, ring: "direct",
        entityId: d.entityId, requests: d.requests, failureRate: d.failureRate,
        latencyP50: d.latencyP50, latencyP90: d.latencyP90, status: d.status, hasMetrics: d.hasMetrics,
        simulatedFailure: getSimulatedFailure(name), expectedFailedRequests: getExpectedFailedRequests(name), depth: getDepth(name),
      });
    });

    // Indirect callers — outer ring
    const outerRadius = Math.min(width, height) * 0.44;
    indirectlyAffected.forEach((name, i) => {
      const angle = (2 * Math.PI * i) / Math.max(indirectlyAffected.length, 1) - Math.PI / 4;
      const d = getSvcData(name);
      result.push({
        name, x: cx + outerRadius * Math.cos(angle), y: cy + outerRadius * Math.sin(angle),
        radius: 16, ring: "indirect",
        entityId: d.entityId, requests: d.requests, failureRate: d.failureRate,
        latencyP50: d.latencyP50, latencyP90: d.latencyP90, status: d.status, hasMetrics: d.hasMetrics,
        simulatedFailure: getSimulatedFailure(name), expectedFailedRequests: getExpectedFailedRequests(name), depth: getDepth(name),
      });
    });

    return result;
  }, [target, directlyAffected, indirectlyAffected, dimensions, svcMap, propagatedFailureByService, expectedFailedRequestsByService, serviceDepthByService]);

  // Apply drag offsets
  const nodes = useMemo(() => baseNodes.map(n => {
    const off = nodeOffsets[n.name];
    return off ? { ...n, x: n.x + off.dx, y: n.y + off.dy } : n;
  }), [baseNodes, nodeOffsets]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, NodeData>();
    nodes.forEach(n => m.set(n.name, n));
    return m;
  }, [nodes]);

  // Only show edges involving affected services + target
  const affectedSet = useMemo(() => new Set<string>([target, ...directlyAffected, ...indirectlyAffected]), [target, directlyAffected, indirectlyAffected]);

  const relevantEdges = useMemo(() => edges.filter(e => affectedSet.has(e.Caller) && affectedSet.has(e.Callee)), [edges, affectedSet]);

  // Highlighted edges when a node is active
  const hoveredEdges = useMemo(() => {
    if (!activeNode) return new Set<number>();
    const s = new Set<number>();
    relevantEdges.forEach((e, i) => { if (e.Caller === activeNode || e.Callee === activeNode) s.add(i); });
    return s;
  }, [activeNode, relevantEdges]);

  const connectedNodes = useMemo(() => {
    if (!activeNode) return new Set<string>();
    const s = new Set<string>([activeNode]);
    relevantEdges.forEach(e => {
      if (e.Caller === activeNode) s.add(e.Callee);
      if (e.Callee === activeNode) s.add(e.Caller);
    });
    return s;
  }, [activeNode, relevantEdges]);

  // Convert node SVG coords to screen coords
  const nodeToScreen = useCallback((node: NodeData): { x: number; y: number } => {
    const svgEl = containerRef.current?.querySelector("svg") as SVGSVGElement | null;
    if (!svgEl) return { x: 0, y: 0 };
    const rect = svgEl.getBoundingClientRect();
    return { x: rect.left + node.x, y: rect.top + node.y };
  }, []);

  // --- Drag node handlers ---
  const handleNodeMouseDown = useCallback((name: string, evt: React.MouseEvent) => {
    evt.stopPropagation();
    evt.preventDefault();
    setDragNode(name);
  }, []);

  useEffect(() => {
    if (!dragNode) return;
    const handleMove = (evt: MouseEvent) => {
      const svgEl = containerRef.current?.querySelector("svg");
      if (!svgEl) return;
      const rect = svgEl.getBoundingClientRect();
      const svgX = evt.clientX - rect.left;
      const svgY = evt.clientY - rect.top;
      const base = baseNodes.find(n => n.name === dragNode);
      if (!base) return;
      setNodeOffsets(prev => ({ ...prev, [dragNode]: { dx: svgX - base.x, dy: svgY - base.y } }));
    };
    const handleUp = () => setDragNode(null);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [dragNode, baseNodes]);

  // --- Tooltip drag ---
  const handleTooltipMouseDown = useCallback((evt: React.MouseEvent) => {
    evt.preventDefault();
    evt.stopPropagation();
    setDraggingTooltip(true);
    setTooltipDragStart({ x: evt.clientX - tooltipOffset.dx, y: evt.clientY - tooltipOffset.dy });
  }, [tooltipOffset]);

  useEffect(() => {
    if (!draggingTooltip) return;
    const handleMove = (evt: MouseEvent) => {
      setTooltipOffset({ dx: evt.clientX - tooltipDragStart.x, dy: evt.clientY - tooltipDragStart.y });
    };
    const handleUp = () => setDraggingTooltip(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [draggingTooltip, tooltipDragStart]);

  // --- Hover / click ---
  const handleMouseEnter = useCallback((node: NodeData) => {
    if (dragNode) return;
    setHovered(node.name);
    if (!pinned) {
      const pos = nodeToScreen(node);
      setTooltipOffset({ dx: 0, dy: 0 });
      setTooltip({ x: pos.x, y: pos.y, node });
    }
  }, [pinned, dragNode, nodeToScreen]);

  const handleMouseLeave = useCallback(() => {
    setHovered(null);
    if (!pinned) setTooltip(null);
  }, [pinned]);

  const handleClick = useCallback((node: NodeData) => {
    if (pinned === node.name) {
      setPinned(null);
      setTooltip(null);
    } else {
      setPinned(node.name);
      const pos = nodeToScreen(node);
      setTooltipOffset({ dx: 0, dy: 0 });
      setTooltip({ x: pos.x, y: pos.y, node });
    }
  }, [pinned, nodeToScreen]);

  const handleSvgClick = useCallback((evt: React.MouseEvent) => {
    if ((evt.target as Element).closest("circle") || (evt.target as Element).closest("text")) return;
    if (pinned) { setPinned(null); setTooltip(null); }
  }, [pinned]);

  const cx = dimensions.width / 2;
  const cy = dimensions.height / 2;
  const isIdle = animPhase === "idle";

  return (
    <div ref={containerRef} style={{ width: "100%", position: "relative", borderRadius: 8, border: "1px solid rgba(99,130,191,0.15)", overflow: "hidden" }}>
      {/* Legend + toolbar */}
      <div style={{ position: "absolute", top: 8, right: 12, zIndex: 10, display: "flex", gap: 10, alignItems: "center", fontSize: 11, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "75%" }}>
        {cascadeActive && (
          <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: cascadeComplete ? ORANGE : RED, background: "rgba(194,25,48,0.12)", border: `1px solid ${cascadeComplete ? ORANGE : RED}`, borderRadius: 6, padding: "2px 8px", letterSpacing: 0.5 }}>
            {cascadeComplete ? `⚠ CASCADED — ${cascadeFailedSet.size} FAILING` : `⚡ T+${String(Math.floor(cascadeElapsed / 60)).padStart(2, "0")}:${String(cascadeElapsed % 60).padStart(2, "0")} — ${cascadeFailedSet.size} failing`}
          </span>
        )}
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: RED, marginRight: 4 }} />Target</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: RED_LIGHT, marginRight: 4 }} />Direct</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: ORANGE, marginRight: 4 }} />Indirect</span>
        <span style={{ opacity: 0.6 }}>Node heat reflects simulated failure probability</span>
        {cascadeActive ? (
          <button onClick={stopCascade} style={{ background: "rgba(194,25,48,0.2)", border: "1px solid rgba(194,25,48,0.5)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: RED, cursor: "pointer", fontWeight: 600 }}>■ Stop</button>
        ) : (
          <button onClick={startCascade} style={{ background: "rgba(69,137,255,0.12)", border: "1px solid rgba(69,137,255,0.35)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: BLUE, cursor: "pointer", fontWeight: 600 }}>⚡ Simulate Cascade</button>
        )}
        <button
          onClick={() => { stopCascade(); setNodeOffsets({}); setPinned(null); setTooltip(null); setAnimTrigger(k => k + 1); }}
          style={{ background: "rgba(99,130,191,0.15)", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "rgba(255,255,255,0.6)", cursor: "pointer" }}
        >Reset</button>
      </div>

      <svg width={dimensions.width} height={dimensions.height} style={{ display: "block", cursor: dragNode ? "move" : "default" }} onClick={handleSvgClick}>
        <defs>
          <marker id="blast-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="rgba(194, 25, 48, 0.5)" />
          </marker>
          <marker id="blast-arrow-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={RED} />
          </marker>
          <filter id="glow-target">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow-blast">
            <feGaussianBlur stdDeviation="10" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* ── Shockwave rings — 3 expanding circles that fade as they grow ── */}
        {animPhase === "live" && [0, 1, 2].map((i) => (
          <circle
            key={`wave-${animKey}-${i}`}
            cx={cx} cy={cy} r={30}
            fill="none"
            stroke={i === 0 ? RED : i === 1 ? RED_LIGHT : ORANGE}
            strokeWidth={3 - i * 0.7}
            opacity={0}
          >
            <animate attributeName="r"
              from="30" to={String(240 + i * 55)}
              dur={`${0.9 + i * 0.28}s`}
              begin={`${i * 0.18}s`}
              fill="freeze"
              calcMode="spline"
              keySplines="0.1 0.8 0.2 1"
            />
            <animate attributeName="opacity"
              values={`0;${0.65 - i * 0.12};0`}
              dur={`${0.9 + i * 0.28}s`}
              begin={`${i * 0.18}s`}
              fill="freeze"
            />
          </circle>
        ))}

        {/* ── Center flash — bright burst at detonation point ── */}
        {animPhase === "live" && (
          <circle key={`flash-${animKey}`} cx={cx} cy={cy} r={28} fill={RED} opacity={0} filter="url(#glow-blast)">
            <animate attributeName="opacity" values="0;0.9;0" dur="0.55s" begin="0s" fill="freeze" />
            <animate attributeName="r" from="28" to="64" dur="0.55s" begin="0s" fill="freeze"
              calcMode="spline" keySplines="0.2 0.8 0.4 1" />
          </circle>
        )}

        {/* ── Edges ── */}
        {relevantEdges.map((e, i) => {
          const src = nodeMap.get(e.Caller);
          const tgt = nodeMap.get(e.Callee);
          if (!src || !tgt) return null;
          const dx = tgt.x - src.x;
          const dy = tgt.y - src.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const x1 = src.x + (dx / dist) * src.radius;
          const y1 = src.y + (dy / dist) * src.radius;
          const x2 = tgt.x - (dx / dist) * (tgt.radius + 6);
          const y2 = tgt.y - (dy / dist) * (tgt.radius + 6);
          const isHl = hoveredEdges.has(i);

          // Edge draw: stroke-dashoffset animates from full-length → 0 after nodes settle.
          // Once edgesSettled we remove the dasharray so hover opacity works without delay.
          const dashLen = Math.ceil(dist);
          const edgeOpacity = isIdle ? 0 : (activeNode && !isHl ? 0.15 : 1);
          const edgeTransition = edgesSettled
            ? "opacity 0.2s"
            : isIdle
            ? "none"
            : `stroke-dashoffset 0.7s cubic-bezier(0.4,0,0.2,1) 1.5s, opacity 0.4s ease 1.5s`;

          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={isHl ? RED : "rgba(194, 25, 48, 0.35)"}
              strokeWidth={isHl ? 2.5 : 1.5}
              markerEnd={isHl ? "url(#blast-arrow-hl)" : "url(#blast-arrow)"}
              strokeDasharray={edgesSettled ? undefined : `${dashLen} ${dashLen}`}
              strokeDashoffset={edgesSettled ? undefined : (isIdle ? dashLen : 0)}
              opacity={edgeOpacity}
              style={{ transition: edgeTransition }}
            />
          );
        })}

        {/* ── Nodes ── */}
        {nodes.map((n) => {
          const isTarget = n.ring === "target";
          const isHl = activeNode === n.name;
          const dimmed = activeNode && !connectedNodes.has(n.name);
          const cascadeFailed = cascadeActive && cascadeFailedSet.has(n.name);
          const cascadeDegraded = cascadeActive && cascadeDegradedSet.has(n.name);
          const cascadeHealthy = cascadeActive && !cascadeFailed && !cascadeDegraded;
          const simulatedFailure = n.simulatedFailure;
          const simulatedColor = isTarget
            ? RED
            : simulatedFailure >= 0.8
              ? RED
              : simulatedFailure >= 0.4
                ? ORANGE
                : simulatedFailure >= 0.15
                  ? YELLOW
                  : getNodeColor(n.ring);
          const simulatedFill = isTarget
            ? RED
            : simulatedFailure >= 0.01
              ? `rgba(${simulatedFailure >= 0.8 ? "194,25,48" : simulatedFailure >= 0.4 ? "255,140,0" : "252,213,63"}, ${Math.min(0.5, 0.12 + simulatedFailure * 0.45)})`
              : getNodeFill(n.ring);
          const nodeStrokeColor = cascadeFailed ? RED : cascadeDegraded ? ORANGE : simulatedColor;
          const nodeFillColor = cascadeFailed ? "rgba(194,25,48,0.45)" : cascadeDegraded ? "rgba(255,140,0,0.35)" : cascadeHealthy ? "rgba(99,130,191,0.1)" : simulatedFill;
          const nodeIcon = cascadeFailed ? "💀" : cascadeDegraded ? "🔥" : n.ring === "target" ? "💥" : "⚠️";

          // Stagger: direct nodes start at 80 ms, 60 ms apart.
          //          indirect nodes start at 280 ms, 40 ms apart.
          const ringIdx = n.ring === "direct"
            ? directlyAffected.indexOf(n.name)
            : indirectlyAffected.indexOf(n.name);
          const delayMs = isTarget ? 0
            : n.ring === "direct" ? 80 + ringIdx * 60
            : 280 + ringIdx * 40;

          // In idle: offset every non-target node back to center so they appear
          // to burst outward when the transition fires.
          const offsetX = !isTarget && isIdle ? cx - n.x : 0;
          const offsetY = !isTarget && isIdle ? cy - n.y : 0;
          const nodeOpacity = !isTarget && isIdle ? 0 : 1;

          const nodeTransition = isIdle
            ? "none"
            : isTarget
            ? "none"
            // spring cubic-bezier: slight overshoot and settle
            : `transform 1.7s cubic-bezier(0.34, 1.45, 0.64, 1) ${delayMs}ms, opacity 0.5s ease ${delayMs}ms`;

          return (
            <g key={n.name}
              onMouseEnter={() => handleMouseEnter(n)}
              onMouseLeave={handleMouseLeave}
              onClick={() => handleClick(n)}
              onMouseDown={(evt) => handleNodeMouseDown(n.name, evt)}
              style={{
                transform: `translate(${offsetX}px, ${offsetY}px)`,
                opacity: nodeOpacity,
                cursor: dragNode === n.name ? "move" : "pointer",
                transition: nodeTransition,
              }}
            >
              {/* Pulse animation for target */}
              {n.ring === "target" && (
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={RED} strokeWidth={2} opacity={0.3} filter="url(#glow-target)">
                  <animate attributeName="r" from={n.radius + 4} to={n.radius + 16} dur="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.4" to="0" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
              {/* Pulse ring for failed nodes in cascade */}
              {cascadeFailed && (
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={RED} strokeWidth={2} opacity={0.4} filter="url(#glow-target)">
                  <animate attributeName="r" from={n.radius + 4} to={n.radius + 18} dur="1.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.5" to="0" dur="1.2s" repeatCount="indefinite" />
                </circle>
              )}
              {/* Outer ring */}
              <circle cx={n.x} cy={n.y} r={n.radius + 3}
                fill="none" stroke={nodeStrokeColor}
                strokeWidth={isTarget || cascadeFailed ? 3 : 2}
                opacity={dimmed ? 0.2 : cascadeHealthy ? 0.35 : 1}
                style={{ transition: "stroke 0.4s, opacity 0.2s" }}
              />
              {/* Inner fill */}
              <circle cx={n.x} cy={n.y} r={n.radius}
                fill={nodeFillColor}
                stroke={isHl ? "#fff" : "none"}
                strokeWidth={isHl ? 2 : 0}
                opacity={dimmed ? 0.2 : cascadeHealthy ? 0.4 : 1}
                style={{ transition: "fill 0.4s, opacity 0.2s" }}
              />
              {/* Label */}
              <text x={n.x} y={n.y + n.radius + 14}
                textAnchor="middle"
                fill={dimmed ? "rgba(255,255,255,0.15)" : cascadeHealthy ? "rgba(255,255,255,0.3)" : cascadeFailed ? RED : "rgba(255,255,255,0.85)"}
                fontSize={n.ring === "target" ? 12 : 10}
                fontWeight={isTarget || isHl || cascadeFailed ? 700 : 400}
                style={{ transition: "fill 0.4s", pointerEvents: "none" }}
              >
                {n.name.length > 20 ? n.name.slice(0, 18) + "…" : n.name}
              </text>
              {!isTarget && n.simulatedFailure > 0 && (
                <text
                  x={n.x}
                  y={n.y - n.radius - 6}
                  textAnchor="middle"
                  fill={simulatedFailure >= 0.8 ? RED : simulatedFailure >= 0.4 ? ORANGE : YELLOW}
                  fontSize={10}
                  fontWeight={700}
                  style={{ pointerEvents: "none" }}
                >
                  {(simulatedFailure * 100).toFixed(0)}%
                </text>
              )}
              {/* Icon inside circle */}
              <text x={n.x} y={n.y + 4} textAnchor="middle"
                fontSize={n.ring === "target" ? 18 : 14}
                style={{ pointerEvents: "none", transition: "opacity 0.4s" }}
              >
                {nodeIcon}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip — matches Dependencies tab style */}
      {tooltip && (() => {
        const ttW = 280;
        const ttH = 320;
        const rawLeft = tooltip.x + 16 + tooltipOffset.dx;
        const rawTop = tooltip.y - 20 + tooltipOffset.dy;
        const clampedLeft = Math.max(8, Math.min(rawLeft, window.innerWidth - ttW - 8));
        const clampedTop = Math.max(8, Math.min(rawTop, window.innerHeight - ttH - 8));
        return createPortal(
          <div style={{
            position: "fixed", left: clampedLeft, top: clampedTop,
            background: "#1c2033", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 12,
            padding: 0, fontSize: 13, color: "#fff", zIndex: 10001,
            pointerEvents: pinned ? "auto" : "none",
            minWidth: 260, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}>
            {/* Header — drag handle */}
            <div
              onMouseDown={pinned ? handleTooltipMouseDown : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "12px 16px 10px",
                borderBottom: "1px solid rgba(99,130,191,0.15)",
                cursor: pinned ? "grab" : "default", userSelect: "none",
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: getNodeColor(tooltip.node.ring), display: "inline-block" }} />
              <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{tooltip.node.name}</span>
              {pinned && (
                <span onClick={() => { setPinned(null); setTooltip(null); }}
                  style={{ cursor: "pointer", fontSize: 16, color: "rgba(255,255,255,0.4)", lineHeight: 1 }}
                >×</span>
              )}
            </div>

            {/* Metrics grid — identical to Dependencies */}
            <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)", background: "rgba(69,137,255,0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5 }}>Simulated Failure</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: tooltip.node.simulatedFailure >= 0.8 ? RED : tooltip.node.simulatedFailure >= 0.4 ? ORANGE : tooltip.node.simulatedFailure >= 0.15 ? YELLOW : "inherit" }}>
                    {(tooltip.node.simulatedFailure * 100).toFixed(1)}%
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5 }}>Expected Failed Requests</div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{formatCount(tooltip.node.expectedFailedRequests)}</div>
                </div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
              {/* Requests */}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)", borderRight: "1px solid rgba(99,130,191,0.1)" }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: BLUE }}>■</span> Requests
                </div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{tooltip.node.hasMetrics ? formatCount(tooltip.node.requests) : "—"}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{tooltip.node.hasMetrics ? "total" : "no data"}</div>
              </div>
              {/* Error Rate */}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)" }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: RED }}>▲</span> Error Rate
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: tooltip.node.hasMetrics && tooltip.node.failureRate >= 2 ? RED : tooltip.node.hasMetrics && tooltip.node.failureRate >= 0.5 ? YELLOW : "inherit" }}>
                  {tooltip.node.hasMetrics ? (tooltip.node.failureRate ?? 0).toFixed(2) + "%" : "—"}
                </div>
              </div>
              {/* P50 Latency */}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)", borderRight: "1px solid rgba(99,130,191,0.1)" }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: YELLOW }}>⚡</span> P50 Latency
                </div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{tooltip.node.hasMetrics ? formatMs(tooltip.node.latencyP50) : "—"}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{tooltip.node.hasMetrics ? "median" : "no data"}</div>
              </div>
              {/* P90 Latency */}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)" }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: "#FF832B" }}>◑</span> P90 Latency
                </div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{tooltip.node.hasMetrics ? formatMs(tooltip.node.latencyP90) : "—"}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{tooltip.node.hasMetrics ? "90th pct" : "no data"}</div>
              </div>
            </div>

            {/* Links section */}
            {(() => {
              const svcType = entityTypeMap?.get(tooltip.node.entityId) ?? "";
              const isDatabase = svcType === "DATABASE_SERVICE";
              const isNonSmartscape = svcType ? NON_DRILLDOWN_TYPES.has(svcType) : false;
              return (
                <div style={{ padding: "8px 16px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                  {tooltip.node.entityId && !isNonSmartscape && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                      <span style={{ fontSize: 14 }}>🔗</span>
                      <a
                        href={`${envUrl}/ui/apps/dynatrace.services/explorer/services?perspective=performance&sort=entity%3Aascending&detailsId=${tooltip.node.entityId}&sidebarOpen=false&tf=${encodeURIComponent(tfFrom.replace(/\(\)/g, '') + ';' + tfTo.replace(/\(\)/g, ''))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                      >
                        Service Details &rsaquo;
                      </a>
                    </div>
                  )}
                  {tooltip.node.entityId && isDatabase && (() => {
                    const dbId = dbEntityMap?.get(tooltip.node.entityId) || tooltip.node.entityId;
                    return (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                        <span style={{ fontSize: 14 }}>🗄</span>
                        <a
                          href={`${envUrl}/ui/apps/dynatrace.database.overview/explorer?perspective=health&sort=healthIndicators%3Adescending&detailsId=${dbId}&sidebarOpen=false&detailsTab=Statement+performance&tf=${encodeURIComponent(tfFrom.replace(/\(\)/g, '') + ';' + tfTo.replace(/\(\)/g, ''))}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                        >
                          Database Overview &rsaquo;
                        </a>
                      </div>
                    );
                  })()}
                  {isNonSmartscape && !isDatabase && (
                    <div style={{ padding: "6px 10px", background: "rgba(255,255,255,0.04)", borderRadius: 6, fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                      {svcType === "MESSAGING_SERVICE" ? "📨 Messaging service — no topology drilldown" : "🌐 External service — no topology drilldown"}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>,
          document.body
        );
      })()}
    </div>
  );
}
