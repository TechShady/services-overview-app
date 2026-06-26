import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const RED = "#C21930";
const ORANGE = "#FF8C00";
const BLUE = "#4589FF";
const K8S_COLOR = "#326CE5"; // K8s blue
const NODE_COLOR = "#0D9C29"; // Green for nodes

interface WorkloadOnNode {
  workloadName: string;
  services: string[];
  serviceCount: number;
}

export interface K8sNodeBlastRadiusGraphProps {
  targetNode: string;
  nodeId?: string;
  workloadsOnNode: WorkloadOnNode[];
  servicesOnNode: string[];
  affectedExternalWorkloads: { workloadName: string; affectedServices: string[]; serviceCount: number }[];
  serviceEdges: { from: string; to: string }[]; // from = external service, to = node service
  tfFrom?: string;
  tfTo?: string;
  workloadNameToId?: Map<string, string>;
}

interface NodeData {
  name: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  ring: "target" | "workload" | "external";
  type: "node" | "workload";
  serviceCount?: number;
  services?: string[];
}

function getNodeColor(ring: string): string {
  if (ring === "target") return NODE_COLOR;
  if (ring === "workload") return K8S_COLOR;
  return ORANGE;
}

function getNodeFill(ring: string): string {
  if (ring === "target") return NODE_COLOR;
  if (ring === "workload") return "rgba(50, 108, 229, 0.25)";
  return "rgba(255, 140, 0, 0.15)";
}

function tfAppParam(from?: string, to?: string): string {
  if (!from || !to) return "";
  const clean = (s: string) => s.replace(/now\(\)/g, 'now');
  return `tf=${encodeURIComponent(clean(from) + ';' + clean(to))}`;
}

export function K8sNodeBlastRadiusGraph({ targetNode, nodeId, workloadsOnNode, servicesOnNode, affectedExternalWorkloads, serviceEdges, tfFrom = "now()-2h", tfTo = "now()", workloadNameToId }: K8sNodeBlastRadiusGraphProps) {
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
    if (!targetNode) return;
    triggerAnimation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetNode, animTrigger]);

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
    // Phase 1: Node fails
    setCascadeFailedSet(new Set([`node:${targetNode}`]));
    let e = 0;
    cascadeIntervalRef.current = setInterval(() => { e++; setCascadeElapsed(e); }, 1000);
    // Phase 2: Workloads on node degrade then fail
    workloadsOnNode.forEach((wl, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(`wl:${wl.workloadName}`); return s; }), 800 + i * 200),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(`wl:${wl.workloadName}`); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(`wl:${wl.workloadName}`); return s; }); }, 1400 + i * 200)
      );
    });
    // Phase 3: External workloads degrade
    const wlEnd = 1400 + Math.max(0, workloadsOnNode.length - 1) * 200 + 600;
    affectedExternalWorkloads.forEach((ew, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(`wl:${ew.workloadName}`); return s; }), wlEnd + i * 300),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(`wl:${ew.workloadName}`); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(`wl:${ew.workloadName}`); return s; }); }, wlEnd + 600 + i * 300)
      );
    });
    const totalDone = wlEnd + 600 + Math.max(0, affectedExternalWorkloads.length - 1) * 300 + 500;
    cascadeTimersRef.current.push(setTimeout(() => setCascadeComplete(true), totalDone));
  }, [targetNode, workloadsOnNode, affectedExternalWorkloads, stopCascade]);

  useEffect(() => () => stopCascade(), [stopCascade]);

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

  // Layout nodes
  const baseNodes = useMemo((): NodeData[] => {
    const { width, height } = dimensions;
    const cx = width / 2;
    const cy = height / 2;
    const result: NodeData[] = [];

    // Target node (center)
    result.push({
      name: `node:${targetNode}`, label: targetNode, x: cx, y: cy, radius: 30,
      ring: "target", type: "node", serviceCount: servicesOnNode.length, services: servicesOnNode,
    });

    // Workloads on node (inner ring)
    const innerRadius = Math.min(width, height) * 0.26;
    workloadsOnNode.forEach((wl, i) => {
      const angle = (2 * Math.PI * i) / Math.max(workloadsOnNode.length, 1) - Math.PI / 2;
      result.push({
        name: `wl:${wl.workloadName}`, label: wl.workloadName, x: cx + innerRadius * Math.cos(angle), y: cy + innerRadius * Math.sin(angle),
        radius: 20, ring: "workload", type: "workload", serviceCount: wl.serviceCount, services: wl.services,
      });
    });

    // Affected external workloads (outer ring)
    const outerRadius = Math.min(width, height) * 0.44;
    affectedExternalWorkloads.forEach((ew, i) => {
      const angle = (2 * Math.PI * i) / Math.max(affectedExternalWorkloads.length, 1) - Math.PI / 4;
      result.push({
        name: `wl:${ew.workloadName}`, label: ew.workloadName, x: cx + outerRadius * Math.cos(angle), y: cy + outerRadius * Math.sin(angle),
        radius: 18, ring: "external", type: "workload", serviceCount: ew.serviceCount, services: ew.affectedServices,
      });
    });

    return result;
  }, [targetNode, workloadsOnNode, affectedExternalWorkloads, servicesOnNode, dimensions]);

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

  // Edges: node → workloads (implicit), external workloads → local workloads
  const graphEdges = useMemo(() => {
    const edges: { from: string; to: string }[] = [];
    affectedExternalWorkloads.forEach(ew => {
      // Connect external workloads to the local workloads whose services they depend on
      const localWlsAffected = new Set<string>();
      serviceEdges.forEach(se => {
        // se.from = external service, se.to = local service
        workloadsOnNode.forEach(wl => {
          if (wl.services.includes(se.to)) localWlsAffected.add(wl.workloadName);
        });
      });
      if (localWlsAffected.size > 0) {
        localWlsAffected.forEach(lwl => edges.push({ from: `wl:${ew.workloadName}`, to: `wl:${lwl}` }));
      } else {
        // fallback: connect to all local workloads
        workloadsOnNode.forEach(wl => edges.push({ from: `wl:${ew.workloadName}`, to: `wl:${wl.workloadName}` }));
      }
    });
    return edges;
  }, [affectedExternalWorkloads, serviceEdges, workloadsOnNode]);

  // Highlighted edges when a node is active
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
    if (activeNode === `node:${targetNode}`) {
      workloadsOnNode.forEach(wl => s.add(`wl:${wl.workloadName}`));
    }
    if (activeNode.startsWith("wl:") && workloadsOnNode.some(wl => `wl:${wl.workloadName}` === activeNode)) {
      s.add(`node:${targetNode}`);
    }
    return s;
  }, [activeNode, graphEdges, targetNode, workloadsOnNode]);

  // Convert node SVG coords to screen coords
  const nodeToScreen = useCallback((node: NodeData): { x: number; y: number } => {
    const svgEl = containerRef.current?.querySelector("svg") as SVGSVGElement | null;
    if (!svgEl) return { x: 0, y: 0 };
    const rect = svgEl.getBoundingClientRect();
    return { x: rect.left + node.x, y: rect.top + node.y };
  }, []);

  // Drag node handlers
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

  // Tooltip drag
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

  // Hover / click handlers
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
      <div style={{ position: "absolute", top: 8, right: 12, zIndex: 10, display: "flex", gap: 10, alignItems: "center", fontSize: 11 }}>
        {cascadeActive && (
          <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: cascadeComplete ? ORANGE : RED, background: "rgba(194,25,48,0.12)", border: `1px solid ${cascadeComplete ? ORANGE : RED}`, borderRadius: 6, padding: "2px 8px", letterSpacing: 0.5 }}>
            {cascadeComplete ? `\u26A0 CASCADED \u2014 ${cascadeFailedSet.size} FAILING` : `\u26A1 T+${String(Math.floor(cascadeElapsed / 60)).padStart(2, "0")}:${String(cascadeElapsed % 60).padStart(2, "0")} \u2014 ${cascadeFailedSet.size} failing`}
          </span>
        )}
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: NODE_COLOR, marginRight: 4 }} />Node</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: K8S_COLOR, marginRight: 4 }} />Workload</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: ORANGE, marginRight: 4 }} />Affected</span>
        {cascadeActive ? (
          <button onClick={stopCascade} style={{ background: "rgba(194,25,48,0.2)", border: "1px solid rgba(194,25,48,0.5)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: RED, cursor: "pointer", fontWeight: 600 }}>\u25A0 Stop</button>
        ) : (
          <button onClick={startCascade} style={{ background: "rgba(69,137,255,0.12)", border: "1px solid rgba(69,137,255,0.35)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: BLUE, cursor: "pointer", fontWeight: 600 }}>\u26A1 Simulate Cascade</button>
        )}
        <button
          onClick={() => { stopCascade(); setNodeOffsets({}); setPinned(null); setTooltip(null); setAnimTrigger(k => k + 1); }}
          style={{ background: "rgba(99,130,191,0.15)", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "rgba(255,255,255,0.6)", cursor: "pointer" }}
        >Reset</button>
      </div>

      <svg width={dimensions.width} height={dimensions.height} style={{ display: "block", cursor: dragNode ? "move" : "default" }} onClick={handleSvgClick}>
        <defs>
          <marker id="node-blast-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="rgba(255, 140, 0, 0.5)" />
          </marker>
          <marker id="node-blast-arrow-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={ORANGE} />
          </marker>
          <filter id="node-glow-target">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="node-glow-blast">
            <feGaussianBlur stdDeviation="10" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Shockwave rings */}
        {animPhase === "live" && [0, 1, 2].map((i) => (
          <circle
            key={`wave-${animKey}-${i}`}
            cx={cx} cy={cy} r={30}
            fill="none"
            stroke={i === 0 ? NODE_COLOR : i === 1 ? K8S_COLOR : ORANGE}
            strokeWidth={3 - i * 0.7}
            opacity={0}
          >
            <animate attributeName="r" from="30" to={String(240 + i * 55)} dur={`${0.9 + i * 0.28}s`} begin={`${i * 0.18}s`} fill="freeze" calcMode="spline" keySplines="0.1 0.8 0.2 1" />
            <animate attributeName="opacity" values={`0;${0.65 - i * 0.12};0`} dur={`${0.9 + i * 0.28}s`} begin={`${i * 0.18}s`} fill="freeze" />
          </circle>
        ))}

        {/* Center flash */}
        {animPhase === "live" && (
          <circle key={`flash-${animKey}`} cx={cx} cy={cy} r={30} fill={NODE_COLOR} opacity={0} filter="url(#node-glow-blast)">
            <animate attributeName="opacity" values="0;0.9;0" dur="0.55s" begin="0s" fill="freeze" />
            <animate attributeName="r" from="30" to="64" dur="0.55s" begin="0s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.4 1" />
          </circle>
        )}

        {/* Implicit edges: node → workloads (dashed) */}
        {nodes.filter(n => n.ring === "workload").map((wlNode, i) => {
          const targetNodeObj = nodes.find(n => n.ring === "target");
          if (!targetNodeObj) return null;
          const dx = wlNode.x - targetNodeObj.x;
          const dy = wlNode.y - targetNodeObj.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const x1 = targetNodeObj.x + (dx / dist) * targetNodeObj.radius;
          const y1 = targetNodeObj.y + (dy / dist) * targetNodeObj.radius;
          const x2 = wlNode.x - (dx / dist) * (wlNode.radius + 4);
          const y2 = wlNode.y - (dy / dist) * (wlNode.radius + 4);
          const edgeOpacity = isIdle ? 0 : (activeNode && !connectedNodes.has(wlNode.name) && !connectedNodes.has(`node:${targetNode}`) ? 0.1 : 0.5);
          return (
            <line key={`node-wl-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="rgba(13, 156, 41, 0.7)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              opacity={edgeOpacity}
              style={{ transition: edgesSettled ? "opacity 0.2s" : isIdle ? "none" : `opacity 0.4s ease 1.5s` }}
            />
          );
        })}

        {/* Dependency edges: external workloads → local workloads */}
        {graphEdges.map((e, i) => {
          const src = nodeMap.get(e.from);
          const tgt = nodeMap.get(e.to);
          if (!src || !tgt) return null;
          const dx = tgt.x - src.x;
          const dy = tgt.y - src.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const x1 = src.x + (dx / dist) * src.radius;
          const y1 = src.y + (dy / dist) * src.radius;
          const x2 = tgt.x - (dx / dist) * (tgt.radius + 6);
          const y2 = tgt.y - (dy / dist) * (tgt.radius + 6);
          const isHl = hoveredEdges.has(i);
          const dashLen = Math.ceil(dist);
          const edgeOpacity = isIdle ? 0 : (activeNode && !isHl ? 0.15 : 1);
          const edgeTransition = edgesSettled ? "opacity 0.2s" : isIdle ? "none" : `stroke-dashoffset 0.7s cubic-bezier(0.4,0,0.2,1) 1.5s, opacity 0.4s ease 1.5s`;

          return (
            <line key={`dep-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={isHl ? ORANGE : "rgba(255, 140, 0, 0.35)"}
              strokeWidth={isHl ? 2.5 : 1.5}
              markerEnd={isHl ? "url(#node-blast-arrow-hl)" : "url(#node-blast-arrow)"}
              strokeDasharray={edgesSettled ? undefined : `${dashLen} ${dashLen}`}
              strokeDashoffset={edgesSettled ? undefined : (isIdle ? dashLen : 0)}
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
          const nodeIcon = cascadeFailed ? "\uD83D\uDC80" : cascadeDegraded ? "\uD83D\uDD25" : n.type === "node" ? "\uD83D\uDDA5\uFE0F" : "\u2638\uFE0F";

          const ringIdx = n.ring === "workload"
            ? workloadsOnNode.findIndex(wl => wl.workloadName === n.label)
            : affectedExternalWorkloads.findIndex(ew => ew.workloadName === n.label);
          const delayMs = isTarget ? 0
            : n.ring === "workload" ? 80 + ringIdx * 60
            : 280 + ringIdx * 40;

          const offsetX = !isTarget && isIdle ? cx - n.x : 0;
          const offsetY = !isTarget && isIdle ? cy - n.y : 0;
          const nodeOpacity = !isTarget && isIdle ? 0 : 1;
          const nodeTransition = isIdle ? "none" : isTarget ? "none"
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
              {isTarget && (
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={NODE_COLOR} strokeWidth={2} opacity={0.3} filter="url(#node-glow-target)">
                  <animate attributeName="r" from={n.radius + 4} to={n.radius + 16} dur="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.4" to="0" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
              {cascadeFailed && (
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={RED} strokeWidth={2} opacity={0.4} filter="url(#node-glow-target)">
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
                fontSize={isTarget ? 11 : 10}
                fontWeight={isTarget || isHl || cascadeFailed ? 700 : 400}
                style={{ transition: "fill 0.4s", pointerEvents: "none" }}
              >
                {n.label.length > 22 ? n.label.slice(0, 20) + "\u2026" : n.label}
              </text>
              {/* Service count badge */}
              {n.serviceCount != null && (
                <text x={n.x} y={n.y + n.radius + 26}
                  textAnchor="middle"
                  fill={dimmed ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.5)"}
                  fontSize={9}
                  style={{ pointerEvents: "none" }}
                >
                  {n.serviceCount} svc{n.serviceCount !== 1 ? "s" : ""}
                </text>
              )}
              {/* Icon inside circle */}
              <text x={n.x} y={n.y + 5} textAnchor="middle"
                fontSize={isTarget ? 18 : 14}
                style={{ pointerEvents: "none", transition: "opacity 0.4s" }}
              >
                {nodeIcon}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (() => {
        const ttW = 260;
        const ttH = 200;
        const rawLeft = tooltip.x + 16 + tooltipOffset.dx;
        const rawTop = tooltip.y - 20 + tooltipOffset.dy;
        const clampedLeft = Math.max(8, Math.min(rawLeft, window.innerWidth - ttW - 8));
        const clampedTop = Math.max(8, Math.min(rawTop, window.innerHeight - ttH - 8));
        const isNodeType = tooltip.node.type === "node";
        return createPortal(
          <div style={{
            position: "fixed", left: clampedLeft, top: clampedTop,
            background: "#1c2033", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 12,
            padding: 0, fontSize: 13, color: "#fff", zIndex: 10001,
            pointerEvents: pinned ? "auto" : "none",
            minWidth: 240, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}>
            {/* Header */}
            <div
              onMouseDown={pinned ? handleTooltipMouseDown : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "12px 16px 10px",
                borderBottom: "1px solid rgba(99,130,191,0.15)",
                cursor: pinned ? "grab" : "default", userSelect: "none",
              }}
            >
              <span style={{ fontSize: 16 }}>{isNodeType ? "🖥️" : "☸️"}</span>
              <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{tooltip.node.label}</span>
              {pinned && (
                <span onClick={() => { setPinned(null); setTooltip(null); }}
                  style={{ cursor: "pointer", fontSize: 16, color: "rgba(255,255,255,0.4)", lineHeight: 1 }}
                >×</span>
              )}
            </div>

            {/* Body */}
            <div style={{ padding: "10px 16px" }}>
              {isNodeType && (
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                  K8s Node — {workloadsOnNode.length} workloads, {servicesOnNode.length} services
                </div>
              )}
              {!isNodeType && tooltip.node.ring === "workload" && (
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                  Workload on this node — {tooltip.node.serviceCount ?? 0} services
                </div>
              )}
              {!isNodeType && tooltip.node.ring === "external" && (
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                  External workload affected by node failure
                </div>
              )}
            </div>

            {/* Link */}
            <div style={{ padding: "8px 16px 12px" }}>
              {isNodeType && nodeId && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(13,156,41,0.08)", borderRadius: 6 }}>
                  <span style={{ fontSize: 14 }}>🔗</span>
                  <a
                    href={`${envUrl}/ui/apps/dynatrace.kubernetes/smartscape/K8S_NODE?perspective=Health&sort=healthIndicators%3Adescending&search=${encodeURIComponent(tooltip.node.label).replace(/\(/g, "%28").replace(/\)/g, "%29")}&detailsId=${encodeURIComponent(nodeId)}&sidebarOpen=false&${tfAppParam(tfFrom, tfTo)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                  >
                    K8s Node Details ›
                  </a>
                </div>
              )}
              {!isNodeType && (() => {
                const wlId = workloadNameToId?.get(tooltip.node.label);
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                    <span style={{ fontSize: 14 }}>🔗</span>
                    <a
                      href={(() => {
                        const searchParam = `search=${encodeURIComponent(tooltip.node.label).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;
                        const detailsParam = wlId ? `&detailsId=${encodeURIComponent(wlId)}&sidebarOpen=false` : "";
                        return `${envUrl}/ui/apps/dynatrace.kubernetes/smartscape/workload/K8S_WORKLOAD?perspective=Health&sort=workload-entity%3Aascending&${searchParam}${detailsParam}&${tfAppParam(tfFrom, tfTo)}`;
                      })()}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                    >
                      K8s Workload Details ›
                    </a>
                  </div>
                );
              })()}
            </div>
          </div>,
          document.body
        );
      })()}
    </div>
  );
}
