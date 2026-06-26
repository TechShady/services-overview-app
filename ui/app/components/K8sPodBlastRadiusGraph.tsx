import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const RED = "#C21930";
const ORANGE = "#FF8C00";
const BLUE = "#4589FF";
const GREEN = "#0D9C29";
const K8S_COLOR = "#326CE5";
const POD_COLOR = "#7B2FBE"; // Purple for pods
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

export interface K8sPodBlastRadiusGraphProps {
  targetPod: string;
  podId?: string;
  podNamespace?: string;
  workloadName: string;
  workloadId?: string;
  siblingPods: string[]; // other pods in the same workload
  replicaCount: number; // total replicas (including target)
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
  ring: "target" | "workload" | "sibling" | "service";
  type: "pod" | "workload" | "sibling-pod" | "service";
  serviceCount?: number;
  services?: string[];
  isSPOF?: boolean;
}

function getNodeColor(ring: string): string {
  if (ring === "target") return POD_COLOR;
  if (ring === "workload") return K8S_COLOR;
  if (ring === "sibling") return "rgba(123, 47, 190, 0.5)";
  return RED;
}

function getNodeFill(ring: string): string {
  if (ring === "target") return POD_COLOR;
  if (ring === "workload") return "rgba(50, 108, 229, 0.25)";
  if (ring === "sibling") return "rgba(123, 47, 190, 0.15)";
  return "rgba(194, 25, 48, 0.2)";
}

function tfAppParam(from?: string, to?: string): string {
  if (!from || !to) return "";
  const clean = (s: string) => s.replace(/now\(\)/g, 'now');
  return `tf=${encodeURIComponent(clean(from) + ';' + clean(to))}`;
}

export function K8sPodBlastRadiusGraph({ targetPod, podId, podNamespace, workloadName, workloadId, siblingPods, replicaCount, servicesOnWorkload, affectedExternalServices, serviceEdges, tfFrom = "now()-2h", tfTo = "now()", serviceDetails, workloadNameToId }: K8sPodBlastRadiusGraphProps) {
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

  const isSPOF = replicaCount <= 1;

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
    if (!targetPod) return;
    triggerAnimation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPod, animTrigger]);

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
    // Phase 1: Pod fails
    setCascadeFailedSet(new Set([`pod:${targetPod}`]));
    let e = 0;
    cascadeIntervalRef.current = setInterval(() => { e++; setCascadeElapsed(e); }, 1000);
    // Phase 2: Workload degrades (or fails if SPOF)
    cascadeTimersRef.current.push(
      setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(`wl:${workloadName}`); return s; }), 600),
      setTimeout(() => {
        if (isSPOF) {
          setCascadeFailedSet(p => { const s = new Set(p); s.add(`wl:${workloadName}`); return s; });
          setCascadeDegradedSet(p => { const s = new Set(p); s.delete(`wl:${workloadName}`); return s; });
        }
      }, 1000)
    );
    // Phase 3: Services degrade/fail
    const svcStart = isSPOF ? 1200 : 1400;
    servicesOnWorkload.forEach((svc, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(`svc:${svc}`); return s; }), svcStart + i * 80),
        setTimeout(() => {
          if (isSPOF) {
            setCascadeFailedSet(p => { const s = new Set(p); s.add(`svc:${svc}`); return s; });
            setCascadeDegradedSet(p => { const s = new Set(p); s.delete(`svc:${svc}`); return s; });
          }
        }, svcStart + 400 + i * 80)
      );
    });
    const totalDone = svcStart + 400 + Math.max(0, servicesOnWorkload.length - 1) * 80 + 500;
    cascadeTimersRef.current.push(setTimeout(() => setCascadeComplete(true), totalDone));
  }, [targetPod, workloadName, servicesOnWorkload, isSPOF, stopCascade]);

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

    // Target pod (center)
    result.push({
      name: `pod:${targetPod}`, label: targetPod, x: cx, y: cy, radius: 30,
      ring: "target", type: "pod", serviceCount: servicesOnWorkload.length, services: servicesOnWorkload, isSPOF,
    });

    // Workload (above center)
    result.push({
      name: `wl:${workloadName}`, label: workloadName, x: cx, y: cy - Math.min(height, width) * 0.2,
      radius: 24, ring: "workload", type: "workload", serviceCount: servicesOnWorkload.length, services: servicesOnWorkload,
    });

    // Sibling pods (arc below/around target)
    const maxSiblings = Math.min(siblingPods.length, 12);
    const sibRadius = Math.min(width, height) * 0.18;
    siblingPods.slice(0, maxSiblings).forEach((sib, i) => {
      const angle = Math.PI * 0.3 + (Math.PI * 0.4 * i) / Math.max(maxSiblings - 1, 1);
      result.push({
        name: `sib:${sib}`, label: sib, x: cx + sibRadius * Math.cos(angle), y: cy + sibRadius * Math.sin(angle),
        radius: 12, ring: "sibling", type: "sibling-pod",
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
  }, [targetPod, workloadName, siblingPods, servicesOnWorkload, dimensions, isSPOF]);

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
    const edges: { from: string; to: string; type: "pod-wl" | "wl-svc" | "pod-sib" }[] = [];
    // Pod → workload
    edges.push({ from: `pod:${targetPod}`, to: `wl:${workloadName}`, type: "pod-wl" });
    // Sibling pods → workload
    siblingPods.slice(0, 12).forEach(sib => {
      edges.push({ from: `sib:${sib}`, to: `wl:${workloadName}`, type: "pod-sib" });
    });
    // Workload → services
    servicesOnWorkload.forEach(svc => {
      if (servicesOnWorkload.indexOf(svc) < 24) {
        edges.push({ from: `wl:${workloadName}`, to: `svc:${svc}`, type: "wl-svc" });
      }
    });
    return edges;
  }, [targetPod, workloadName, siblingPods, servicesOnWorkload]);

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

  return (
    <div ref={containerRef} style={{ width: "100%", position: "relative", borderRadius: 8, border: "1px solid rgba(99,130,191,0.15)", overflow: "hidden" }}>
      {/* Legend + toolbar */}
      <div style={{ position: "absolute", top: 8, right: 12, zIndex: 10, display: "flex", gap: 10, alignItems: "center", fontSize: 11 }}>
        {cascadeActive && (
          <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: cascadeComplete ? ORANGE : RED, background: "rgba(194,25,48,0.12)", border: `1px solid ${cascadeComplete ? ORANGE : RED}`, borderRadius: 6, padding: "2px 8px", letterSpacing: 0.5 }}>
            {cascadeComplete ? (isSPOF ? `💀 SPOF — ALL SERVICES DOWN` : `⚠ DEGRADED — ${replicaCount - 1}/${replicaCount} replicas`) : `⚡ T+${String(Math.floor(cascadeElapsed / 60)).padStart(2, "0")}:${String(cascadeElapsed % 60).padStart(2, "0")} — cascading`}
          </span>
        )}
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: POD_COLOR, marginRight: 4 }} />Pod</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: K8S_COLOR, marginRight: 4 }} />Workload</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: RED, marginRight: 4 }} />Service</span>
        {isSPOF && <span style={{ background: "rgba(194,25,48,0.15)", border: "1px solid rgba(194,25,48,0.4)", borderRadius: 4, padding: "2px 6px", fontSize: 10, color: RED, fontWeight: 700 }}>⚠ SINGLE REPLICA</span>}
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
          <marker id="pod-blast-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="rgba(50, 108, 229, 0.5)" />
          </marker>
          <marker id="pod-blast-arrow-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={K8S_COLOR} />
          </marker>
          <filter id="pod-glow-target">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="pod-glow-blast">
            <feGaussianBlur stdDeviation="10" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Shockwave rings */}
        {animPhase === "live" && [0, 1, 2].map((i) => (
          <circle key={`wave-${animKey}-${i}`} cx={cx} cy={cy} r={30} fill="none"
            stroke={i === 0 ? POD_COLOR : i === 1 ? K8S_COLOR : RED} strokeWidth={3 - i * 0.7} opacity={0}>
            <animate attributeName="r" from="30" to={String(220 + i * 50)} dur={`${1.0 + i * 0.3}s`} begin={`${i * 0.2}s`} fill="freeze" calcMode="spline" keySplines="0.1 0.8 0.2 1" />
            <animate attributeName="opacity" values={`0;${0.6 - i * 0.12};0`} dur={`${1.0 + i * 0.3}s`} begin={`${i * 0.2}s`} fill="freeze" />
          </circle>
        ))}

        {animPhase === "live" && (
          <circle key={`flash-${animKey}`} cx={cx} cy={cy} r={30} fill={POD_COLOR} opacity={0} filter="url(#pod-glow-blast)">
            <animate attributeName="opacity" values="0;0.9;0" dur="0.6s" begin="0s" fill="freeze" />
            <animate attributeName="r" from="30" to="60" dur="0.6s" begin="0s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.4 1" />
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
          const isPodEdge = e.type === "pod-wl" || e.type === "pod-sib";
          const edgeOpacity = isIdle ? 0 : (activeNode && !isHl ? 0.12 : isPodEdge ? 0.5 : 0.45);
          const dashLen = Math.ceil(dist);
          const edgeTransition = edgesSettled ? "opacity 0.2s" : isIdle ? "none" : `stroke-dashoffset 0.7s cubic-bezier(0.4,0,0.2,1) 1.5s, opacity 0.4s ease 1.5s`;

          return (
            <line key={`edge-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={isHl ? (isPodEdge ? POD_COLOR : K8S_COLOR) : isPodEdge ? "rgba(123, 47, 190, 0.35)" : "rgba(50, 108, 229, 0.3)"}
              strokeWidth={isHl ? 2.5 : isPodEdge ? 1.5 : 1.2}
              strokeDasharray={isPodEdge ? "4 3" : (edgesSettled ? undefined : `${dashLen} ${dashLen}`)}
              strokeDashoffset={edgesSettled || isPodEdge ? undefined : (isIdle ? dashLen : 0)}
              markerEnd={isPodEdge ? undefined : (isHl ? "url(#pod-blast-arrow-hl)" : "url(#pod-blast-arrow)")}
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
          const nodeIcon = cascadeFailed ? "💀" : cascadeDegraded ? "🔥" : n.type === "pod" ? "🫛" : n.type === "workload" ? "☸️" : n.type === "sibling-pod" ? "🫛" : "⚙️";

          const ringIdx = n.ring === "sibling" ? siblingPods.indexOf(n.label) : servicesOnWorkload.indexOf(n.label);
          const delayMs = isTarget ? 0 : n.ring === "workload" ? 60 : n.ring === "sibling" ? 100 + ringIdx * 40 : 200 + ringIdx * 30;
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
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={isSPOF ? RED : POD_COLOR} strokeWidth={2} opacity={0.3} filter="url(#pod-glow-target)">
                  <animate attributeName="r" from={n.radius + 4} to={n.radius + 18} dur="2.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.4" to="0" dur="2.2s" repeatCount="indefinite" />
                </circle>
              )}
              {cascadeFailed && (
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={RED} strokeWidth={2} opacity={0.4} filter="url(#pod-glow-target)">
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
                fontSize={isTarget ? 11 : n.ring === "workload" ? 10 : n.ring === "sibling" ? 8 : 9}
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
                fontSize={isTarget ? 18 : n.ring === "workload" ? 14 : n.ring === "sibling" ? 10 : 12}
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
        const ttH = 320;
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
              <span style={{ fontSize: 16 }}>{tooltip.node.type === "pod" || tooltip.node.type === "sibling-pod" ? "🫛" : tooltip.node.type === "workload" ? "☸️" : "⚙️"}</span>
              <span style={{ fontWeight: 700, fontSize: 12, flex: 1, wordBreak: "break-all" }}>{tooltip.node.label}</span>
              {pinned && (
                <span onClick={() => { setPinned(null); setTooltip(null); }}
                  style={{ cursor: "pointer", fontSize: 16, color: "rgba(255,255,255,0.4)", lineHeight: 1 }}>×</span>
              )}
            </div>

            {/* Content */}
            {tooltip.node.type === "pod" && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
                  {isSPOF ? "⚠️ SINGLE REPLICA — pod failure = full service outage" : `Pod in workload "${workloadName}" (${replicaCount} replicas)`}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: isSPOF ? RED : POD_COLOR }}>
                  {isSPOF ? "SPOF — Full Outage" : `Degraded (${replicaCount - 1}/${replicaCount} remain)`}
                </div>
                {podNamespace && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>Namespace: {podNamespace}</div>}
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>Services affected: {servicesOnWorkload.length}</div>
              </div>
            )}
            {tooltip.node.type === "sibling-pod" && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>SIBLING POD — same workload</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(123,47,190,0.8)" }}>
                  Replica of "{workloadName}"
                </div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>If target pod fails, this replica continues serving traffic</div>
              </div>
            )}
            {tooltip.node.type === "workload" && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
                  PARENT WORKLOAD — {isSPOF ? "will FAIL (single replica)" : `will be DEGRADED (${replicaCount - 1}/${replicaCount} replicas)`}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: K8S_COLOR }}>{replicaCount} replica{replicaCount !== 1 ? "s" : ""} / {servicesOnWorkload.length} svc</div>
                {tooltip.node.services && tooltip.node.services.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.6)", maxHeight: 120, overflow: "auto" }}>
                    {tooltip.node.services.slice(0, 10).map(s => (<div key={s} style={{ padding: "2px 0" }}>• {s}</div>))}
                    {tooltip.node.services.length > 10 && <div style={{ opacity: 0.5 }}>+{tooltip.node.services.length - 10} more</div>}
                  </div>
                )}
              </div>
            )}
            {tooltip.node.type === "service" && svcInfo && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)", borderRight: "1px solid rgba(99,130,191,0.1)" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}><span style={{ color: BLUE }}>■</span> Requests</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{formatCount(svcInfo.requests)}</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>total</div>
                </div>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}><span style={{ color: RED }}>▲</span> Error Rate</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: svcInfo.failureRate >= 2 ? RED : svcInfo.failureRate >= 0.5 ? YELLOW : "inherit" }}>{svcInfo.failureRate.toFixed(2)}%</div>
                </div>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)", borderRight: "1px solid rgba(99,130,191,0.1)" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}><span style={{ color: YELLOW }}>⚡</span> P50 Latency</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{formatMs(svcInfo.latencyP50)}</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>median</div>
                </div>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)" }}>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}><span style={{ color: "#FF832B" }}>◑</span> P90 Latency</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{formatMs(svcInfo.latencyP90)}</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>90th pct</div>
                </div>
              </div>
            )}
            {tooltip.node.type === "service" && !svcInfo && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                  Service on workload "{workloadName}" — {isSPOF ? "will be DESTROYED" : "will be DEGRADED"}
                </div>
              </div>
            )}

            {/* Links */}
            <div style={{ padding: "8px 16px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              {(tooltip.node.type === "pod" || tooltip.node.type === "sibling-pod") && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(123,47,190,0.08)", borderRadius: 6 }}>
                  <span style={{ fontSize: 14 }}>🔗</span>
                  <a
                    href={(() => {
                      const searchParam = `search=${encodeURIComponent(tooltip.node.label).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;
                      return `${envUrl}/ui/apps/dynatrace.kubernetes/smartscape/K8S_POD?perspective=Health&sort=healthIndicators%3Adescending&${searchParam}${podId && tooltip.node.type === "pod" ? `&detailsId=${encodeURIComponent(podId)}&sidebarOpen=false` : ""}&${tfAppParam(tfFrom, tfTo)}`;
                    })()}
                    target="_blank" rel="noopener noreferrer"
                    style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>
                    K8s Pod Details ›
                  </a>
                </div>
              )}
              {tooltip.node.type === "workload" && (() => {
                const wlId = workloadNameToId?.get(tooltip.node.label) || workloadId;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                    <span style={{ fontSize: 14 }}>🔗</span>
                    <a
                      href={(() => {
                        const searchParam = `search=${encodeURIComponent(tooltip.node.label).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;
                        const detailsParam = wlId ? `&detailsId=${encodeURIComponent(wlId)}&sidebarOpen=false` : "";
                        return `${envUrl}/ui/apps/dynatrace.kubernetes/smartscape/workload/K8S_WORKLOAD?perspective=Health&sort=workload-entity%3Aascending&${searchParam}${detailsParam}&${tfAppParam(tfFrom, tfTo)}`;
                      })()}
                      target="_blank" rel="noopener noreferrer"
                      style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>
                      K8s Workload Details ›
                    </a>
                  </div>
                );
              })()}
              {tooltip.node.type === "service" && svcInfo?.entityId && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                  <span style={{ fontSize: 14 }}>🔗</span>
                  <a
                    href={`${envUrl}/ui/apps/dynatrace.services/explorer/services?perspective=performance&sort=entity%3Aascending&detailsId=${svcInfo.entityId}&sidebarOpen=false&${tfAppParam(tfFrom, tfTo)}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>
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
