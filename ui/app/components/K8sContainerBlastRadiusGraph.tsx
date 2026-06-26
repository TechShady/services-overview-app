import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const RED = "#C21930";
const ORANGE = "#FF8C00";
const BLUE = "#4589FF";
const GREEN = "#0D9C29";
const K8S_COLOR = "#326CE5";
const POD_COLOR = "#7B2FBE";
const CONTAINER_COLOR = "#E91E63"; // Pink for containers
const YELLOW = "#F5A623";

function formatMs(us: number): string {
  if (us >= 1_000_000) return (us / 1_000_000).toFixed(1) + " s";
  if (us >= 1_000) return (us / 1_000).toFixed(1) + " ms";
  return us.toFixed(0) + " µs";
}
function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(Math.round(n));
}

export interface K8sContainerBlastRadiusGraphProps {
  targetContainer: string;
  podName: string;
  podNamespace?: string;
  workloadName: string;
  workloadId?: string;
  siblingContainers: string[]; // other containers in the same pod
  containersInPod: number;
  replicaCount: number;
  servicesOnWorkload: string[];
  affectedExternalServices: string[];
  serviceEdges: { from: string; to: string }[];
  tfFrom?: string;
  tfTo?: string;
  serviceDetails?: Map<string, { entityId: string; requests: number; failureRate: number; latencyP50: number; latencyP90: number }>;
  workloadNameToId?: Map<string, string>;
}

interface NodeData {
  name: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  ring: "target" | "pod" | "workload" | "sibling" | "service";
  type: "container" | "pod" | "workload" | "sibling-container" | "service";
  serviceCount?: number;
  services?: string[];
}

function getNodeColor(ring: string): string {
  if (ring === "target") return CONTAINER_COLOR;
  if (ring === "pod") return POD_COLOR;
  if (ring === "workload") return K8S_COLOR;
  if (ring === "sibling") return "rgba(233, 30, 99, 0.5)";
  return RED;
}

function getNodeFill(ring: string): string {
  if (ring === "target") return CONTAINER_COLOR;
  if (ring === "pod") return "rgba(123, 47, 190, 0.25)";
  if (ring === "workload") return "rgba(50, 108, 229, 0.25)";
  if (ring === "sibling") return "rgba(233, 30, 99, 0.15)";
  return "rgba(194, 25, 48, 0.2)";
}

function tfAppParam(from?: string, to?: string): string {
  if (!from || !to) return "";
  const clean = (s: string) => s.replace(/now\(\)/g, 'now');
  return `tf=${encodeURIComponent(clean(from) + ';' + clean(to))}`;
}

export function K8sContainerBlastRadiusGraph({ targetContainer, podName, podNamespace, workloadName, workloadId, siblingContainers, containersInPod, replicaCount, servicesOnWorkload, affectedExternalServices, serviceEdges, tfFrom = "now()-2h", tfTo = "now()", serviceDetails, workloadNameToId }: K8sContainerBlastRadiusGraphProps) {
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

  const isSingleContainer = containersInPod <= 1;
  const isSPOF = replicaCount <= 1;
  // If single container in pod, container crash = pod crash. If multi-container, only that container restarts.
  const podImpact = isSingleContainer ? "crash" : "degraded";

  // Animation
  const [animPhase, setAnimPhase] = useState<"idle" | "live">("idle");
  const [animKey, setAnimKey] = useState(0);
  const [edgesSettled, setEdgesSettled] = useState(false);
  const [animTrigger, setAnimTrigger] = useState(0);
  const blastTimersRef = useRef<{ live?: ReturnType<typeof setTimeout>; settle?: ReturnType<typeof setTimeout> }>({});

  const triggerAnimation = useCallback(() => {
    clearTimeout(blastTimersRef.current.live);
    clearTimeout(blastTimersRef.current.settle);
    setAnimPhase("idle");
    setEdgesSettled(false);
    setAnimKey(k => k + 1);
    blastTimersRef.current.live = setTimeout(() => setAnimPhase("live"), 50);
    blastTimersRef.current.settle = setTimeout(() => setEdgesSettled(true), 2450);
  }, []);

  useEffect(() => {
    if (!targetContainer) return;
    triggerAnimation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetContainer, animTrigger]);

  // Cascade simulation
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
    // Phase 1: Container crashes
    setCascadeFailedSet(new Set([`ctr:${targetContainer}`]));
    let e = 0;
    cascadeIntervalRef.current = setInterval(() => { e++; setCascadeElapsed(e); }, 1000);
    // Phase 2: Pod impact
    cascadeTimersRef.current.push(
      setTimeout(() => {
        if (isSingleContainer) {
          setCascadeFailedSet(p => { const s = new Set(p); s.add(`pod:${podName}`); return s; });
        } else {
          setCascadeDegradedSet(p => { const s = new Set(p); s.add(`pod:${podName}`); return s; });
        }
      }, 500)
    );
    // Phase 3: Workload impact
    cascadeTimersRef.current.push(
      setTimeout(() => {
        if (isSingleContainer && isSPOF) {
          setCascadeFailedSet(p => { const s = new Set(p); s.add(`wl:${workloadName}`); return s; });
        } else if (isSingleContainer) {
          setCascadeDegradedSet(p => { const s = new Set(p); s.add(`wl:${workloadName}`); return s; });
        } else {
          setCascadeDegradedSet(p => { const s = new Set(p); s.add(`wl:${workloadName}`); return s; });
        }
      }, 900)
    );
    // Phase 4: Services impact
    const svcStart = 1200;
    servicesOnWorkload.forEach((svc, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => {
          if (isSingleContainer && isSPOF) {
            setCascadeFailedSet(p => { const s = new Set(p); s.add(`svc:${svc}`); return s; });
          } else {
            setCascadeDegradedSet(p => { const s = new Set(p); s.add(`svc:${svc}`); return s; });
          }
        }, svcStart + i * 60)
      );
    });
    const totalDone = svcStart + Math.max(0, servicesOnWorkload.length - 1) * 60 + 500;
    cascadeTimersRef.current.push(setTimeout(() => setCascadeComplete(true), totalDone));
  }, [targetContainer, podName, workloadName, servicesOnWorkload, isSingleContainer, isSPOF, stopCascade]);

  useEffect(() => () => stopCascade(), [stopCascade]);

  const activeNode = pinned ?? hovered;

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) setDimensions({ width, height: Math.max(420, Math.min(620, width * 0.55)) });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Layout nodes
  const baseNodes = useMemo((): NodeData[] => {
    const { width, height } = dimensions;
    const cx = width / 2;
    const cy = height / 2;
    const result: NodeData[] = [];

    // Target container (center)
    result.push({
      name: `ctr:${targetContainer}`, label: targetContainer, x: cx, y: cy, radius: 28,
      ring: "target", type: "container", serviceCount: servicesOnWorkload.length, services: servicesOnWorkload,
    });

    // Pod (above-left)
    result.push({
      name: `pod:${podName}`, label: podName, x: cx - Math.min(width, height) * 0.12, y: cy - Math.min(height, width) * 0.18,
      radius: 22, ring: "pod", type: "pod",
    });

    // Workload (above-right)
    result.push({
      name: `wl:${workloadName}`, label: workloadName, x: cx + Math.min(width, height) * 0.12, y: cy - Math.min(height, width) * 0.22,
      radius: 22, ring: "workload", type: "workload", serviceCount: servicesOnWorkload.length, services: servicesOnWorkload,
    });

    // Sibling containers (arc below target)
    const maxSiblings = Math.min(siblingContainers.length, 8);
    const sibRadius = Math.min(width, height) * 0.16;
    siblingContainers.slice(0, maxSiblings).forEach((sib, i) => {
      const angle = Math.PI * 0.35 + (Math.PI * 0.3 * i) / Math.max(maxSiblings - 1, 1);
      result.push({
        name: `sib:${sib}`, label: sib, x: cx + sibRadius * Math.cos(angle), y: cy + sibRadius * Math.sin(angle),
        radius: 11, ring: "sibling", type: "sibling-container",
      });
    });

    // Services (outer ring)
    const maxShownServices = Math.min(servicesOnWorkload.length, 24);
    const outerRadius = Math.min(width, height) * 0.42;
    servicesOnWorkload.slice(0, maxShownServices).forEach((svc, i) => {
      const angle = (2 * Math.PI * i) / Math.max(maxShownServices, 1) - Math.PI / 2;
      result.push({
        name: `svc:${svc}`, label: svc, x: cx + outerRadius * Math.cos(angle), y: cy + outerRadius * Math.sin(angle),
        radius: 14, ring: "service", type: "service",
      });
    });

    return result;
  }, [targetContainer, podName, workloadName, siblingContainers, servicesOnWorkload, dimensions]);

  const nodes = useMemo(() => baseNodes.map(n => {
    const off = nodeOffsets[n.name];
    return off ? { ...n, x: n.x + off.dx, y: n.y + off.dy } : n;
  }), [baseNodes, nodeOffsets]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, NodeData>();
    nodes.forEach(n => m.set(n.name, n));
    return m;
  }, [nodes]);

  const graphEdges = useMemo(() => {
    const edges: { from: string; to: string; type: "ctr-pod" | "pod-wl" | "wl-svc" | "ctr-sib" }[] = [];
    // Container → pod
    edges.push({ from: `ctr:${targetContainer}`, to: `pod:${podName}`, type: "ctr-pod" });
    // Pod → workload
    edges.push({ from: `pod:${podName}`, to: `wl:${workloadName}`, type: "pod-wl" });
    // Sibling containers → pod
    siblingContainers.slice(0, 8).forEach(sib => {
      edges.push({ from: `sib:${sib}`, to: `pod:${podName}`, type: "ctr-sib" });
    });
    // Workload → services
    servicesOnWorkload.forEach((svc, i) => {
      if (i < 24) edges.push({ from: `wl:${workloadName}`, to: `svc:${svc}`, type: "wl-svc" });
    });
    return edges;
  }, [targetContainer, podName, workloadName, siblingContainers, servicesOnWorkload]);

  const hoveredEdges = useMemo(() => {
    if (!activeNode) return new Set<number>();
    const s = new Set<number>();
    graphEdges.forEach((e, i) => { if (e.from === activeNode || e.to === activeNode) s.add(i); });
    return s;
  }, [activeNode, graphEdges]);

  const connectedNodes = useMemo(() => {
    if (!activeNode) return new Set<string>();
    const s = new Set<string>([activeNode]);
    graphEdges.forEach(e => {
      if (e.from === activeNode) s.add(e.to);
      if (e.to === activeNode) s.add(e.from);
    });
    return s;
  }, [activeNode, graphEdges]);

  const nodeToScreen = useCallback((node: NodeData): { x: number; y: number } => {
    const svgEl = containerRef.current?.querySelector("svg") as SVGSVGElement | null;
    if (!svgEl) return { x: 0, y: 0 };
    const rect = svgEl.getBoundingClientRect();
    return { x: rect.left + node.x, y: rect.top + node.y };
  }, []);

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
    return () => { window.removeEventListener("mousemove", handleMove); window.removeEventListener("mouseup", handleUp); };
  }, [dragNode, baseNodes]);

  const handleTooltipMouseDown = useCallback((evt: React.MouseEvent) => {
    evt.preventDefault();
    evt.stopPropagation();
    setDraggingTooltip(true);
    setTooltipDragStart({ x: evt.clientX - tooltipOffset.dx, y: evt.clientY - tooltipOffset.dy });
  }, [tooltipOffset]);

  useEffect(() => {
    if (!draggingTooltip) return;
    const handleMove = (evt: MouseEvent) => { setTooltipOffset({ dx: evt.clientX - tooltipDragStart.x, dy: evt.clientY - tooltipDragStart.y }); };
    const handleUp = () => setDraggingTooltip(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => { window.removeEventListener("mousemove", handleMove); window.removeEventListener("mouseup", handleUp); };
  }, [draggingTooltip, tooltipDragStart]);

  const handleMouseEnter = useCallback((node: NodeData) => {
    if (dragNode) return;
    setHovered(node.name);
    if (!pinned) { const pos = nodeToScreen(node); setTooltipOffset({ dx: 0, dy: 0 }); setTooltip({ x: pos.x, y: pos.y, node }); }
  }, [pinned, dragNode, nodeToScreen]);

  const handleMouseLeave = useCallback(() => { setHovered(null); if (!pinned) setTooltip(null); }, [pinned]);

  const handleClick = useCallback((node: NodeData) => {
    if (pinned === node.name) { setPinned(null); setTooltip(null); }
    else { setPinned(node.name); const pos = nodeToScreen(node); setTooltipOffset({ dx: 0, dy: 0 }); setTooltip({ x: pos.x, y: pos.y, node }); }
  }, [pinned, nodeToScreen]);

  const handleSvgClick = useCallback((evt: React.MouseEvent) => {
    if ((evt.target as Element).closest("circle") || (evt.target as Element).closest("text")) return;
    if (pinned) { setPinned(null); setTooltip(null); }
  }, [pinned]);

  const cx = dimensions.width / 2;
  const cy = dimensions.height / 2;
  const isIdle = animPhase === "idle";

  // Severity label
  const severityLabel = isSingleContainer && isSPOF ? "FULL OUTAGE" : isSingleContainer ? "POD CRASH" : "CONTAINER RESTART";
  const severityColor = isSingleContainer && isSPOF ? RED : isSingleContainer ? ORANGE : YELLOW;

  return (
    <div ref={containerRef} style={{ width: "100%", position: "relative", borderRadius: 8, border: "1px solid rgba(99,130,191,0.15)", overflow: "hidden" }}>
      {/* Legend + toolbar */}
      <div style={{ position: "absolute", top: 8, right: 12, zIndex: 10, display: "flex", gap: 10, alignItems: "center", fontSize: 11 }}>
        {cascadeActive && (
          <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: cascadeComplete ? severityColor : RED, background: "rgba(194,25,48,0.12)", border: `1px solid ${cascadeComplete ? severityColor : RED}`, borderRadius: 6, padding: "2px 8px", letterSpacing: 0.5 }}>
            {cascadeComplete ? `${isSingleContainer && isSPOF ? "💀 SPOF" : isSingleContainer ? "🔥 POD DOWN" : "⚠ DEGRADED"} — ${severityLabel}` : `⚡ T+${String(Math.floor(cascadeElapsed / 60)).padStart(2, "0")}:${String(cascadeElapsed % 60).padStart(2, "0")} — cascading`}
          </span>
        )}
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: CONTAINER_COLOR, marginRight: 4 }} />Container</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: POD_COLOR, marginRight: 4 }} />Pod</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: K8S_COLOR, marginRight: 4 }} />Workload</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: RED, marginRight: 4 }} />Service</span>
        {isSingleContainer && <span style={{ background: "rgba(233,30,99,0.15)", border: "1px solid rgba(233,30,99,0.4)", borderRadius: 4, padding: "2px 6px", fontSize: 10, color: CONTAINER_COLOR, fontWeight: 700 }}>SOLE CONTAINER</span>}
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
          <marker id="ctr-blast-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="rgba(50, 108, 229, 0.5)" />
          </marker>
          <marker id="ctr-blast-arrow-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={K8S_COLOR} />
          </marker>
          <filter id="ctr-glow-target">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="ctr-glow-blast">
            <feGaussianBlur stdDeviation="10" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Shockwave rings */}
        {animPhase === "live" && [0, 1, 2].map((i) => (
          <circle key={`wave-${animKey}-${i}`} cx={cx} cy={cy} r={28} fill="none"
            stroke={i === 0 ? CONTAINER_COLOR : i === 1 ? POD_COLOR : K8S_COLOR} strokeWidth={3 - i * 0.7} opacity={0}>
            <animate attributeName="r" from="28" to={String(200 + i * 50)} dur={`${1.0 + i * 0.3}s`} begin={`${i * 0.2}s`} fill="freeze" calcMode="spline" keySplines="0.1 0.8 0.2 1" />
            <animate attributeName="opacity" values={`0;${0.6 - i * 0.12};0`} dur={`${1.0 + i * 0.3}s`} begin={`${i * 0.2}s`} fill="freeze" />
          </circle>
        ))}

        {animPhase === "live" && (
          <circle key={`flash-${animKey}`} cx={cx} cy={cy} r={28} fill={CONTAINER_COLOR} opacity={0} filter="url(#ctr-glow-blast)">
            <animate attributeName="opacity" values="0;0.9;0" dur="0.6s" begin="0s" fill="freeze" />
            <animate attributeName="r" from="28" to="55" dur="0.6s" begin="0s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.4 1" />
          </circle>
        )}

        {/* Edges */}
        {graphEdges.map((e, i) => {
          const src = nodeMap.get(e.from);
          const tgt = nodeMap.get(e.to);
          if (!src || !tgt) return null;
          const dx = tgt.x - src.x;
          const dy = tgt.y - src.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const x1 = src.x + (dx / dist) * src.radius;
          const y1 = src.y + (dy / dist) * src.radius;
          const x2 = tgt.x - (dx / dist) * (tgt.radius + 4);
          const y2 = tgt.y - (dy / dist) * (tgt.radius + 4);
          const isHl = hoveredEdges.has(i);
          const isInternal = e.type === "ctr-pod" || e.type === "pod-wl" || e.type === "ctr-sib";
          const edgeOpacity = isIdle ? 0 : (activeNode && !isHl ? 0.12 : isInternal ? 0.5 : 0.45);
          const dashLen = Math.ceil(dist);
          const edgeTransition = edgesSettled ? "opacity 0.2s" : isIdle ? "none" : `stroke-dashoffset 0.7s cubic-bezier(0.4,0,0.2,1) 1.5s, opacity 0.4s ease 1.5s`;

          return (
            <line key={`edge-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={isHl ? (isInternal ? CONTAINER_COLOR : K8S_COLOR) : isInternal ? "rgba(233, 30, 99, 0.35)" : "rgba(50, 108, 229, 0.3)"}
              strokeWidth={isHl ? 2.5 : isInternal ? 1.5 : 1.2}
              strokeDasharray={isInternal ? "4 3" : (edgesSettled ? undefined : `${dashLen} ${dashLen}`)}
              strokeDashoffset={edgesSettled || isInternal ? undefined : (isIdle ? dashLen : 0)}
              markerEnd={isInternal ? undefined : (isHl ? "url(#ctr-blast-arrow-hl)" : "url(#ctr-blast-arrow)")}
              opacity={edgeOpacity}
              style={{ transition: edgeTransition }}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((n) => {
          const isTarget = n.ring === "target";
          const isHl = activeNode === n.name;
          const dimmed = activeNode && !connectedNodes.has(n.name);
          const cascadeFailed = cascadeActive && cascadeFailedSet.has(n.name);
          const cascadeDegraded = cascadeActive && cascadeDegradedSet.has(n.name);
          const cascadeHealthy = cascadeActive && !cascadeFailed && !cascadeDegraded;
          const nodeStrokeColor = cascadeFailed ? RED : cascadeDegraded ? ORANGE : getNodeColor(n.ring);
          const nodeFillColor = cascadeFailed ? "rgba(194,25,48,0.45)" : cascadeDegraded ? "rgba(255,140,0,0.35)" : cascadeHealthy ? "rgba(99,130,191,0.1)" : getNodeFill(n.ring);
          const nodeIcon = cascadeFailed ? "💀" : cascadeDegraded ? "🔥" : n.type === "container" ? "📦" : n.type === "pod" ? "🫛" : n.type === "workload" ? "☸️" : n.type === "sibling-container" ? "📦" : "⚙️";

          const ringIdx = n.ring === "sibling" ? siblingContainers.indexOf(n.label) : servicesOnWorkload.indexOf(n.label);
          const delayMs = isTarget ? 0 : n.ring === "pod" ? 50 : n.ring === "workload" ? 80 : n.ring === "sibling" ? 100 + ringIdx * 40 : 200 + ringIdx * 30;
          const offsetX = !isTarget && isIdle ? cx - n.x : 0;
          const offsetY = !isTarget && isIdle ? cy - n.y : 0;
          const nodeOpacity = !isTarget && isIdle ? 0 : 1;
          const nodeTransition = isIdle ? "none" : isTarget ? "none" : `transform 1.7s cubic-bezier(0.34, 1.45, 0.64, 1) ${delayMs}ms, opacity 0.5s ease ${delayMs}ms`;

          return (
            <g key={n.name}
              onMouseEnter={() => handleMouseEnter(n)}
              onMouseLeave={handleMouseLeave}
              onClick={() => handleClick(n)}
              onMouseDown={(evt) => handleNodeMouseDown(n.name, evt)}
              style={{ transform: `translate(${offsetX}px, ${offsetY}px)`, opacity: nodeOpacity, cursor: dragNode === n.name ? "move" : "pointer", transition: nodeTransition }}
            >
              {isTarget && (
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={CONTAINER_COLOR} strokeWidth={2} opacity={0.3} filter="url(#ctr-glow-target)">
                  <animate attributeName="r" from={n.radius + 4} to={n.radius + 18} dur="2.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.4" to="0" dur="2.2s" repeatCount="indefinite" />
                </circle>
              )}
              {cascadeFailed && (
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={RED} strokeWidth={2} opacity={0.4} filter="url(#ctr-glow-target)">
                  <animate attributeName="r" from={n.radius + 4} to={n.radius + 18} dur="1.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.5" to="0" dur="1.2s" repeatCount="indefinite" />
                </circle>
              )}
              <circle cx={n.x} cy={n.y} r={n.radius + 3} fill="none" stroke={nodeStrokeColor}
                strokeWidth={isTarget || cascadeFailed ? 3 : 2} opacity={dimmed ? 0.2 : cascadeHealthy ? 0.35 : 1}
                style={{ transition: "stroke 0.4s, opacity 0.2s" }} />
              <circle cx={n.x} cy={n.y} r={n.radius} fill={nodeFillColor}
                stroke={isHl ? "#fff" : "none"} strokeWidth={isHl ? 2 : 0}
                opacity={dimmed ? 0.2 : cascadeHealthy ? 0.4 : 1} style={{ transition: "fill 0.4s, opacity 0.2s" }} />
              <text x={n.x} y={n.y + n.radius + 14} textAnchor="middle"
                fill={dimmed ? "rgba(255,255,255,0.15)" : cascadeHealthy ? "rgba(255,255,255,0.3)" : cascadeFailed ? RED : "rgba(255,255,255,0.85)"}
                fontSize={isTarget ? 11 : n.ring === "pod" || n.ring === "workload" ? 10 : n.ring === "sibling" ? 8 : 9}
                fontWeight={isTarget || isHl || cascadeFailed ? 700 : 400}
                style={{ transition: "fill 0.4s", pointerEvents: "none" }}>
                {n.label.length > 22 ? n.label.slice(0, 20) + "…" : n.label}
              </text>
              {n.type === "workload" && (
                <text x={n.x} y={n.y + n.radius + 26} textAnchor="middle"
                  fill={dimmed ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.5)"} fontSize={9} style={{ pointerEvents: "none" }}>
                  {replicaCount} replica{replicaCount !== 1 ? "s" : ""} / {servicesOnWorkload.length} svc
                </text>
              )}
              <text x={n.x} y={n.y + (n.ring === "sibling" ? 4 : 5)} textAnchor="middle"
                fontSize={isTarget ? 16 : n.ring === "pod" || n.ring === "workload" ? 13 : n.ring === "sibling" ? 9 : 12}
                style={{ pointerEvents: "none", transition: "opacity 0.4s" }}>
                {nodeIcon}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (() => {
        const ttW = 280;
        const ttH = 300;
        const rawLeft = tooltip.x + 16 + tooltipOffset.dx;
        const rawTop = tooltip.y - 20 + tooltipOffset.dy;
        const clampedLeft = Math.max(8, Math.min(rawLeft, window.innerWidth - ttW - 8));
        const clampedTop = Math.max(8, Math.min(rawTop, window.innerHeight - ttH - 8));
        const svcInfo = tooltip.node.type === "service" ? serviceDetails?.get(tooltip.node.label) : undefined;
        return createPortal(
          <div style={{
            position: "fixed", left: clampedLeft, top: clampedTop,
            background: "#1c2033", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 12,
            padding: 0, fontSize: 13, color: "#fff", zIndex: 10001,
            pointerEvents: pinned ? "auto" : "none",
            minWidth: 260, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}>
            {/* Header */}
            <div onMouseDown={pinned ? handleTooltipMouseDown : undefined}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px 10px", borderBottom: "1px solid rgba(99,130,191,0.15)", cursor: pinned ? "grab" : "default", userSelect: "none" }}>
              <span style={{ fontSize: 16 }}>{tooltip.node.type === "container" || tooltip.node.type === "sibling-container" ? "📦" : tooltip.node.type === "pod" ? "🫛" : tooltip.node.type === "workload" ? "☸️" : "⚙️"}</span>
              <span style={{ fontWeight: 700, fontSize: 12, flex: 1, wordBreak: "break-all" }}>{tooltip.node.label}</span>
              {pinned && (
                <span onClick={() => { setPinned(null); setTooltip(null); }}
                  style={{ cursor: "pointer", fontSize: 16, color: "rgba(255,255,255,0.4)", lineHeight: 1 }}>×</span>
              )}
            </div>

            {/* Content */}
            {tooltip.node.type === "container" && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
                  {isSingleContainer ? "⚠️ SOLE CONTAINER — crash kills the pod" : `Container in pod "${podName}" (${containersInPod} containers)`}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: severityColor }}>
                  {severityLabel}
                </div>
                {podNamespace && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>Namespace: {podNamespace}</div>}
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>Pod: {podName} / Workload: {workloadName}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>Services affected: {servicesOnWorkload.length}</div>
              </div>
            )}
            {tooltip.node.type === "sibling-container" && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>SIBLING CONTAINER — same pod</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(233,30,99,0.8)" }}>
                  Co-located in pod "{podName}"
                </div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>If target container crashes, this sibling {isSingleContainer ? "is also affected" : "continues running (multi-container pod)"}</div>
              </div>
            )}
            {tooltip.node.type === "pod" && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
                  PARENT POD — {isSingleContainer ? "will CRASH (sole container)" : "will be DEGRADED (multi-container)"}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: POD_COLOR }}>{containersInPod} container{containersInPod !== 1 ? "s" : ""}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>Workload: {workloadName} ({replicaCount} replicas)</div>
              </div>
            )}
            {tooltip.node.type === "workload" && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
                  PARENT WORKLOAD — {isSingleContainer && isSPOF ? "will FAIL" : "will be DEGRADED"}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: K8S_COLOR }}>{replicaCount} replica{replicaCount !== 1 ? "s" : ""} / {servicesOnWorkload.length} svc</div>
                {tooltip.node.services && tooltip.node.services.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.6)", maxHeight: 100, overflow: "auto" }}>
                    {tooltip.node.services.slice(0, 8).map(s => (<div key={s} style={{ padding: "2px 0" }}>• {s}</div>))}
                    {tooltip.node.services.length > 8 && <div style={{ opacity: 0.5 }}>+{tooltip.node.services.length - 8} more</div>}
                  </div>
                )}
              </div>
            )}
            {tooltip.node.type === "service" && svcInfo && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)", borderRight: "1px solid rgba(99,130,191,0.1)" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}><span style={{ color: BLUE }}>■</span> Requests</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{formatCount(svcInfo.requests)}</div>
                </div>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}><span style={{ color: RED }}>▲</span> Error Rate</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: svcInfo.failureRate >= 2 ? RED : svcInfo.failureRate >= 0.5 ? YELLOW : "inherit" }}>{svcInfo.failureRate.toFixed(2)}%</div>
                </div>
                <div style={{ padding: "12px 16px", borderRight: "1px solid rgba(99,130,191,0.1)" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}><span style={{ color: YELLOW }}>⚡</span> P50</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{formatMs(svcInfo.latencyP50)}</div>
                </div>
                <div style={{ padding: "12px 16px" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}><span style={{ color: "#FF832B" }}>◑</span> P90</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{formatMs(svcInfo.latencyP90)}</div>
                </div>
              </div>
            )}
            {tooltip.node.type === "service" && !svcInfo && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                  Service on workload "{workloadName}" — {isSingleContainer && isSPOF ? "will be DESTROYED" : "will be DEGRADED"}
                </div>
              </div>
            )}

            {/* Links */}
            <div style={{ padding: "8px 16px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              {(tooltip.node.type === "container" || tooltip.node.type === "sibling-container") && (() => {
                const wlId = workloadNameToId?.get(workloadName) || workloadId;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(233,30,99,0.08)", borderRadius: 6 }}>
                    <span style={{ fontSize: 14 }}>🔗</span>
                    <a href={`${envUrl}/ui/apps/dynatrace.kubernetes/smartscape/workload/K8S_WORKLOAD?perspective=Health&sort=workload-entity%3Aascending&search=${encodeURIComponent(workloadName)}${wlId ? `&detailsId=${encodeURIComponent(wlId)}&sidebarOpen=false` : ""}&${tfAppParam(tfFrom, tfTo)}`}
                      target="_blank" rel="noopener noreferrer" style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>
                      View in Workload (Pods/Containers) ›
                    </a>
                  </div>
                );
              })()}
              {tooltip.node.type === "pod" && (() => {
                const wlId = workloadNameToId?.get(workloadName) || workloadId;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(123,47,190,0.08)", borderRadius: 6 }}>
                    <span style={{ fontSize: 14 }}>🔗</span>
                    <a href={`${envUrl}/ui/apps/dynatrace.kubernetes/smartscape/workload/K8S_WORKLOAD?perspective=Health&sort=workload-entity%3Aascending&search=${encodeURIComponent(workloadName)}${wlId ? `&detailsId=${encodeURIComponent(wlId)}&sidebarOpen=false` : ""}&${tfAppParam(tfFrom, tfTo)}`}
                      target="_blank" rel="noopener noreferrer" style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>
                      K8s Workload (Pod Details) ›
                    </a>
                  </div>
                );
              })()}
              {tooltip.node.type === "workload" && (() => {
                const wlId = workloadNameToId?.get(tooltip.node.label) || workloadId;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                    <span style={{ fontSize: 14 }}>🔗</span>
                    <a href={`${envUrl}/ui/apps/dynatrace.kubernetes/smartscape/workload/K8S_WORKLOAD?perspective=Health&sort=workload-entity%3Aascending&search=${encodeURIComponent(tooltip.node.label)}${wlId ? `&detailsId=${encodeURIComponent(wlId)}&sidebarOpen=false` : ""}&${tfAppParam(tfFrom, tfTo)}`}
                      target="_blank" rel="noopener noreferrer" style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>
                      K8s Workload Details ›
                    </a>
                  </div>
                );
              })()}
              {tooltip.node.type === "service" && svcInfo?.entityId && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                  <span style={{ fontSize: 14 }}>🔗</span>
                  <a href={`${envUrl}/ui/apps/dynatrace.services/explorer/services?perspective=performance&sort=entity%3Aascending&detailsId=${svcInfo.entityId}&sidebarOpen=false&${tfAppParam(tfFrom, tfTo)}`}
                    target="_blank" rel="noopener noreferrer" style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>
                    Service Details ›
                  </a>
                </div>
              )}
            </div>
          </div>,
          document.body
        );
      })()}
    </div>
  );
}
