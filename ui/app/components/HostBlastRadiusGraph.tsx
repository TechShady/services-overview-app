import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const RED = "#C21930";
const RED_LIGHT = "rgba(194, 25, 48, 0.7)";
const ORANGE = "#FF8C00";
const YELLOW = "#FCD53F";
const BLUE = "#4589FF";
const GREEN = "#24A148";
const HOST_COLOR = "#6929C4";
const HOST_COLOR_LIGHT = "rgba(105, 41, 196, 0.7)";

interface RemoteHost {
  hostName: string;
  services: string[];
  serviceCount: number;
  affectedServices: string[]; // services on this host that call the dead services
}

export interface HostBlastRadiusGraphProps {
  targetHost: string;
  servicesOnHost: string[];
  remoteHosts: RemoteHost[];
  serviceEdges: { from: string; to: string }[]; // from = remote service, to = local service (remote calls local)
  tfFrom?: string;
  tfTo?: string;
  serviceDetails?: Map<string, { entityId: string; requests: number; failureRate: number; latencyP50: number; latencyP90: number }>;
  hostIdMap?: Map<string, string>;
}

interface NodeData {
  name: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  ring: "target" | "service" | "remote";
  type: "host" | "service";
  serviceCount?: number;
  services?: string[];
}

function getNodeColor(ring: string): string {
  if (ring === "target") return HOST_COLOR;
  if (ring === "service") return RED;
  return ORANGE;
}

function getNodeFill(ring: string): string {
  if (ring === "target") return HOST_COLOR;
  if (ring === "service") return "rgba(194, 25, 48, 0.25)";
  return "rgba(255, 140, 0, 0.15)";
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

function tfParam(from?: string, to?: string): string {
  if (!from || !to) return "";
  return `tf=${encodeURIComponent(from.replace(/\(\)/g, '') + ';' + to.replace(/\(\)/g, ''))}`;
}

export function HostBlastRadiusGraph({ targetHost, servicesOnHost, remoteHosts, serviceEdges, tfFrom = "now()-2h", tfTo = "now()", serviceDetails, hostIdMap }: HostBlastRadiusGraphProps) {
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
    if (!targetHost) return;
    triggerAnimation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetHost, animTrigger]);

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
    // Phase 1: Host fails
    setCascadeFailedSet(new Set([`host:${targetHost}`]));
    let e = 0;
    cascadeIntervalRef.current = setInterval(() => { e++; setCascadeElapsed(e); }, 1000);
    // Phase 2: Services on host degrade then fail
    servicesOnHost.forEach((name, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(`svc:${name}`); return s; }), 800 + i * 200),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(`svc:${name}`); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(`svc:${name}`); return s; }); }, 1400 + i * 200)
      );
    });
    // Phase 3: Remote hosts degrade
    const svcEnd = 1400 + Math.max(0, servicesOnHost.length - 1) * 200 + 600;
    remoteHosts.forEach((rh, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(`host:${rh.hostName}`); return s; }), svcEnd + i * 300),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(`host:${rh.hostName}`); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(`host:${rh.hostName}`); return s; }); }, svcEnd + 600 + i * 300)
      );
    });
    const totalDone = svcEnd + 600 + Math.max(0, remoteHosts.length - 1) * 300 + 500;
    cascadeTimersRef.current.push(setTimeout(() => setCascadeComplete(true), totalDone));
  }, [targetHost, servicesOnHost, remoteHosts, stopCascade]);

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

    // Target host (center)
    result.push({
      name: `host:${targetHost}`, label: targetHost, x: cx, y: cy, radius: 30,
      ring: "target", type: "host", serviceCount: servicesOnHost.length, services: servicesOnHost,
    });

    // Services on host (inner ring)
    const innerRadius = Math.min(width, height) * 0.26;
    servicesOnHost.forEach((name, i) => {
      const angle = (2 * Math.PI * i) / Math.max(servicesOnHost.length, 1) - Math.PI / 2;
      result.push({
        name: `svc:${name}`, label: name, x: cx + innerRadius * Math.cos(angle), y: cy + innerRadius * Math.sin(angle),
        radius: 18, ring: "service", type: "service",
      });
    });

    // Remote hosts (outer ring) — collapsed with service counts
    const outerRadius = Math.min(width, height) * 0.44;
    remoteHosts.forEach((rh, i) => {
      const angle = (2 * Math.PI * i) / Math.max(remoteHosts.length, 1) - Math.PI / 4;
      result.push({
        name: `host:${rh.hostName}`, label: rh.hostName, x: cx + outerRadius * Math.cos(angle), y: cy + outerRadius * Math.sin(angle),
        radius: 20, ring: "remote", type: "host", serviceCount: rh.serviceCount, services: rh.affectedServices,
      });
    });

    return result;
  }, [targetHost, servicesOnHost, remoteHosts, dimensions]);

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

  // Edges: from remote hosts → services on target host
  // We draw edges from the remote host node to the local service it depends on
  const graphEdges = useMemo(() => {
    const edges: { from: string; to: string }[] = [];
    // For each remote host, connect it to the services on target host that its services call
    remoteHosts.forEach(rh => {
      // Find which local services this remote host's services call
      const localServicesCalled = new Set<string>();
      serviceEdges.forEach(e => {
        // e.from = remote service name, e.to = local service name
        if (rh.services?.includes(e.from) || rh.affectedServices.includes(e.from)) {
          if (servicesOnHost.includes(e.to)) localServicesCalled.add(e.to);
        }
      });
      localServicesCalled.forEach(localSvc => {
        edges.push({ from: `host:${rh.hostName}`, to: `svc:${localSvc}` });
      });
      // If no specific edges found, connect to all local services (simplified)
      if (localServicesCalled.size === 0) {
        servicesOnHost.forEach(localSvc => {
          edges.push({ from: `host:${rh.hostName}`, to: `svc:${localSvc}` });
        });
      }
    });
    return edges;
  }, [remoteHosts, serviceEdges, servicesOnHost]);

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
    // Target host is always connected to its services
    if (activeNode === `host:${targetHost}`) {
      servicesOnHost.forEach(svc => s.add(`svc:${svc}`));
    }
    if (activeNode.startsWith("svc:")) {
      s.add(`host:${targetHost}`);
    }
    return s;
  }, [activeNode, graphEdges, targetHost, servicesOnHost]);

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
            {cascadeComplete ? `⚠ CASCADED — ${cascadeFailedSet.size} FAILING` : `⚡ T+${String(Math.floor(cascadeElapsed / 60)).padStart(2, "0")}:${String(cascadeElapsed % 60).padStart(2, "0")} — ${cascadeFailedSet.size} failing`}
          </span>
        )}
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: HOST_COLOR, marginRight: 4 }} />Host</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: RED, marginRight: 4 }} />Service</span>
        <span style={{ opacity: 0.6 }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: ORANGE, marginRight: 4 }} />Affected Host</span>
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
          <marker id="host-blast-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="rgba(255, 140, 0, 0.5)" />
          </marker>
          <marker id="host-blast-arrow-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={ORANGE} />
          </marker>
          <filter id="host-glow-target">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="host-glow-blast">
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
            stroke={i === 0 ? HOST_COLOR : i === 1 ? RED : ORANGE}
            strokeWidth={3 - i * 0.7}
            opacity={0}
          >
            <animate attributeName="r" from="30" to={String(240 + i * 55)} dur={`${0.9 + i * 0.28}s`} begin={`${i * 0.18}s`} fill="freeze" calcMode="spline" keySplines="0.1 0.8 0.2 1" />
            <animate attributeName="opacity" values={`0;${0.65 - i * 0.12};0`} dur={`${0.9 + i * 0.28}s`} begin={`${i * 0.18}s`} fill="freeze" />
          </circle>
        ))}

        {/* Center flash */}
        {animPhase === "live" && (
          <circle key={`flash-${animKey}`} cx={cx} cy={cy} r={30} fill={HOST_COLOR} opacity={0} filter="url(#host-glow-blast)">
            <animate attributeName="opacity" values="0;0.9;0" dur="0.55s" begin="0s" fill="freeze" />
            <animate attributeName="r" from="30" to="64" dur="0.55s" begin="0s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.4 1" />
          </circle>
        )}

        {/* Implicit edges: target host → services (dashed) */}
        {nodes.filter(n => n.ring === "service").map((svcNode, i) => {
          const hostNode = nodes.find(n => n.ring === "target");
          if (!hostNode) return null;
          const dx = svcNode.x - hostNode.x;
          const dy = svcNode.y - hostNode.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const x1 = hostNode.x + (dx / dist) * hostNode.radius;
          const y1 = hostNode.y + (dy / dist) * hostNode.radius;
          const x2 = svcNode.x - (dx / dist) * (svcNode.radius + 4);
          const y2 = svcNode.y - (dy / dist) * (svcNode.radius + 4);
          const edgeOpacity = isIdle ? 0 : (activeNode && !connectedNodes.has(svcNode.name) && !connectedNodes.has(`host:${targetHost}`) ? 0.1 : 0.5);
          return (
            <line key={`host-svc-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={HOST_COLOR_LIGHT}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              opacity={edgeOpacity}
              style={{ transition: edgesSettled ? "opacity 0.2s" : isIdle ? "none" : `opacity 0.4s ease 1.5s` }}
            />
          );
        })}

        {/* Dependency edges: remote hosts → local services */}
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
              markerEnd={isHl ? "url(#host-blast-arrow-hl)" : "url(#host-blast-arrow)"}
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
          const nodeIcon = cascadeFailed ? "💀" : cascadeDegraded ? "🔥" : n.type === "host" ? "🖥️" : "⚙️";

          const ringIdx = n.ring === "service"
            ? servicesOnHost.indexOf(n.label)
            : remoteHosts.findIndex(rh => rh.hostName === n.label);
          const delayMs = isTarget ? 0
            : n.ring === "service" ? 80 + ringIdx * 60
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
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={HOST_COLOR} strokeWidth={2} opacity={0.3} filter="url(#host-glow-target)">
                  <animate attributeName="r" from={n.radius + 4} to={n.radius + 16} dur="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.4" to="0" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
              {cascadeFailed && (
                <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={RED} strokeWidth={2} opacity={0.4} filter="url(#host-glow-target)">
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
                {n.label.length > 22 ? n.label.slice(0, 20) + "…" : n.label}
              </text>
              {/* Service count badge for host nodes */}
              {n.type === "host" && n.serviceCount != null && (
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
        const ttW = 280;
        const ttH = 320;
        const rawLeft = tooltip.x + 16 + tooltipOffset.dx;
        const rawTop = tooltip.y - 20 + tooltipOffset.dy;
        const clampedLeft = Math.max(8, Math.min(rawLeft, window.innerWidth - ttW - 8));
        const clampedTop = Math.max(8, Math.min(rawTop, window.innerHeight - ttH - 8));
        const isHost = tooltip.node.type === "host";
        const svcInfo = !isHost ? serviceDetails?.get(tooltip.node.label) : undefined;
        return createPortal(
          <div style={{
            position: "fixed", left: clampedLeft, top: clampedTop,
            background: "#1c2033", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 12,
            padding: 0, fontSize: 13, color: "#fff", zIndex: 10001,
            pointerEvents: pinned ? "auto" : "none",
            minWidth: 260, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
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
              <span style={{ fontSize: 16 }}>{isHost ? "🖥️" : "⚙️"}</span>
              <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{tooltip.node.label}</span>
              {pinned && (
                <span onClick={() => { setPinned(null); setTooltip(null); }}
                  style={{ cursor: "pointer", fontSize: 16, color: "rgba(255,255,255,0.4)", lineHeight: 1 }}
                >×</span>
              )}
            </div>

            {/* Content */}
            {isHost && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
                  {tooltip.node.ring === "target" ? "TARGET HOST — services will fail" : "AFFECTED — depends on target's services"}
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: tooltip.node.ring === "target" ? HOST_COLOR : ORANGE }}>
                  {tooltip.node.serviceCount} service{tooltip.node.serviceCount !== 1 ? "s" : ""}
                </div>
                {tooltip.node.services && tooltip.node.services.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.6)", maxHeight: 120, overflow: "auto" }}>
                    {tooltip.node.services.slice(0, 10).map(s => (
                      <div key={s} style={{ padding: "2px 0" }}>• {s}</div>
                    ))}
                    {tooltip.node.services.length > 10 && <div style={{ opacity: 0.5 }}>+{tooltip.node.services.length - 10} more</div>}
                  </div>
                )}
              </div>
            )}
            {!isHost && svcInfo && (
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
            {!isHost && !svcInfo && (
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>Service running on {targetHost}</div>
              </div>
            )}

            {/* Link */}
            <div style={{ padding: "8px 16px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              {isHost && (() => {
                const hostId = hostIdMap?.get(tooltip.node.label);
                if (!hostId) return null;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                    <span style={{ fontSize: 14 }}>🔗</span>
                    <a
                      href={`${envUrl}/ui/apps/dynatrace.infraops/explorer/Hosts?perspective=Health&sort=healthIndicators%3Adescending&detailsId=${encodeURIComponent(hostId)}&sidebarOpen=false&${tfParam(tfFrom, tfTo)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                    >
                      Host Details ›
                    </a>
                  </div>
                );
              })()}
              {!isHost && svcInfo?.entityId && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                  <span style={{ fontSize: 14 }}>🔗</span>
                  <a
                    href={`${envUrl}/ui/apps/dynatrace.services/explorer/services?perspective=performance&sort=entity%3Aascending&detailsId=${svcInfo.entityId}&sidebarOpen=false&${tfParam(tfFrom, tfTo)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                  >
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
