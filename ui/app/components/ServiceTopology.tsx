import React, { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const GREEN = "#0D9C29";
const YELLOW = "#FCD53F";
const RED = "#C21930";
const BLUE = "#4589FF";

interface Edge {
  Caller: string;
  Callee: string;
}

interface ServiceMetrics {
  Service: string;
  Requests: number;
  FailureRate: number;
  Latency_Avg?: number;
  Latency_p50?: number;
  Latency_p90?: number;
  Status: string;
  "dt.entity.service"?: string;
  "event.id"?: string;
}

interface Props {
  edges: Edge[];
  services: ServiceMetrics[];
}

interface NodePos {
  name: string;
  x: number;
  y: number;
  requests: number;
  failureRate: number;
  latencyAvg: number;
  latencyP50: number;
  latencyP90: number;
  status: string;
  outDegree: number;
  inDegree: number;
  entityId: string;
  eventId: string;
}

function getNodeColor(failureRate: number, status: string): string {
  if (status === "PROBLEM") return RED;
  if (failureRate >= 2) return RED;
  if (failureRate >= 0.5) return YELLOW;
  return GREEN;
}

function getEdgeColor(callerRate: number, calleeRate: number): string {
  const maxRate = Math.max(callerRate, calleeRate);
  if (maxRate >= 2) return "rgba(194, 25, 48, 0.6)";
  if (maxRate >= 0.5) return "rgba(252, 213, 63, 0.5)";
  return "rgba(99, 130, 191, 0.3)";
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

function layoutNodes(edges: Edge[], services: ServiceMetrics[], width: number, height: number): NodePos[] {
  const metricsMap = new Map<string, ServiceMetrics>();
  services.forEach((s) => metricsMap.set(s.Service, s));

  const nodeNames = new Set<string>();
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  edges.forEach((e) => {
    if (!e.Caller || !e.Callee) return;
    nodeNames.add(e.Caller);
    nodeNames.add(e.Callee);
    outDeg.set(e.Caller, (outDeg.get(e.Caller) ?? 0) + 1);
    inDeg.set(e.Callee, (inDeg.get(e.Callee) ?? 0) + 1);
  });
  services.forEach((s) => { if (s.Service) nodeNames.add(s.Service); });

  const names = Array.from(nodeNames);
  const roots: string[] = [];
  const leaves: string[] = [];
  const middle: string[] = [];
  const isolated: string[] = [];

  names.forEach((n) => {
    const out = outDeg.get(n) ?? 0;
    const inp = inDeg.get(n) ?? 0;
    if (out === 0 && inp === 0) isolated.push(n);
    else if (out > 0 && inp === 0) roots.push(n);
    else if (out === 0 && inp > 0) leaves.push(n);
    else middle.push(n);
  });

  const reqSort = (a: string, b: string) =>
    (metricsMap.get(b)?.Requests ?? 0) - (metricsMap.get(a)?.Requests ?? 0);
  roots.sort(reqSort);
  middle.sort(reqSort);
  leaves.sort(reqSort);

  const cols = [roots, middle, leaves, isolated].filter((c) => c.length > 0);
  const padX = 180;
  const padY = 100;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;

  const result: NodePos[] = [];
  cols.forEach((col, ci) => {
    const x = cols.length === 1 ? width / 2 : padX + (ci / (cols.length - 1)) * usableW;
    col.forEach((name, ri) => {
      const y = col.length === 1 ? height / 2 : padY + (ri / Math.max(col.length - 1, 1)) * usableH;
      const m = metricsMap.get(name);
      result.push({
        name,
        x,
        y,
        requests: m?.Requests ?? 0,
        failureRate: m?.FailureRate ?? 0,
        latencyAvg: m?.Latency_Avg ?? 0,
        latencyP50: m?.Latency_p50 ?? 0,
        latencyP90: m?.Latency_p90 ?? 0,
        status: m?.Status ?? "",
        outDegree: outDeg.get(name) ?? 0,
        inDegree: inDeg.get(name) ?? 0,
        entityId: m?.["dt.entity.service"] ?? "",
        eventId: m?.["event.id"] ?? "",
      });
    });
  });

  return result;
}

export function ServiceTopology({ edges: rawEdges, services }: Props) {
  const edges = useMemo(() => rawEdges.filter((e) => e.Caller && e.Callee), [rawEdges]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1000, height: 700 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: NodePos } | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [tooltipOffset, setTooltipOffset] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [draggingTooltip, setDraggingTooltip] = useState(false);
  const [tooltipDragStart, setTooltipDragStart] = useState({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const envUrl = useMemo(() => getEnvironmentUrl().replace(/\/$/, ""), []);

  const activeNode = pinned ?? hovered;

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) setDimensions((prev) => ({ ...prev, width }));
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Spacing: minimum 80px between nodes
  const minNodeSpacing = 80;
  const maxColSize = useMemo(() => {
    const nodeNames = new Set<string>();
    const outDeg = new Map<string, number>();
    const inDeg = new Map<string, number>();
    edges.forEach((e) => {
      if (!e.Caller || !e.Callee) return;
      nodeNames.add(e.Caller); nodeNames.add(e.Callee);
      outDeg.set(e.Caller, (outDeg.get(e.Caller) ?? 0) + 1);
      inDeg.set(e.Callee, (inDeg.get(e.Callee) ?? 0) + 1);
    });
    services.forEach((s) => { if (s.Service) nodeNames.add(s.Service); });
    const roots: string[] = []; const leaves: string[] = []; const middle: string[] = []; const isolated: string[] = [];
    nodeNames.forEach((n) => {
      const out = outDeg.get(n) ?? 0; const inp = inDeg.get(n) ?? 0;
      if (out === 0 && inp === 0) isolated.push(n);
      else if (out > 0 && inp === 0) roots.push(n);
      else if (out === 0 && inp > 0) leaves.push(n);
      else middle.push(n);
    });
    return Math.max(roots.length, middle.length, leaves.length, isolated.length, 1);
  }, [edges, services]);

  const svgHeight = Math.max(700, maxColSize * minNodeSpacing + 200);

  const baseNodes = useMemo(
    () => layoutNodes(edges, services, dimensions.width, svgHeight),
    [edges, services, dimensions.width, svgHeight]
  );

  // Apply drag offsets to base layout
  const nodes = useMemo(() => baseNodes.map((n) => {
    const off = nodeOffsets[n.name];
    return off ? { ...n, x: n.x + off.dx, y: n.y + off.dy } : n;
  }), [baseNodes, nodeOffsets]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, NodePos>();
    nodes.forEach((n) => m.set(n.name, n));
    return m;
  }, [nodes]);

  const maxRequests = useMemo(() => Math.max(1, ...nodes.map((n) => n.requests)), [nodes]);

  const nodeRadius = (n: NodePos) => {
    const minR = 18;
    const maxR = 40;
    return minR + (n.requests / maxRequests) * (maxR - minR);
  };

  // --- Drag handlers ---
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
      const svgX = (evt.clientX - rect.left - pan.x) / zoom;
      const svgY = (evt.clientY - rect.top - pan.y) / zoom;
      const base = baseNodes.find((n) => n.name === dragNode);
      if (!base) return;
      setNodeOffsets((prev) => ({ ...prev, [dragNode]: { dx: svgX - base.x, dy: svgY - base.y } }));
    };
    const handleUp = () => setDragNode(null);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [dragNode, baseNodes, zoom, pan]);

  // --- Pan handlers ---
  const handleSvgMouseDown = useCallback((evt: React.MouseEvent) => {
    if (dragNode) return;
    if ((evt.target as Element).closest("circle")) return;
    setIsPanning(true);
    setPanStart({ x: evt.clientX - pan.x, y: evt.clientY - pan.y });
  }, [pan, dragNode]);

  useEffect(() => {
    if (!isPanning) return;
    const handleMove = (evt: MouseEvent) => {
      setPan({ x: evt.clientX - panStart.x, y: evt.clientY - panStart.y });
    };
    const handleUp = () => setIsPanning(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isPanning, panStart]);

  // --- Zoom handler ---
  const handleWheel = useCallback((evt: React.WheelEvent) => {
    evt.preventDefault();
    const delta = evt.deltaY > 0 ? -0.1 : 0.1;
    setZoom((z) => Math.min(3, Math.max(0.3, z + delta)));
  }, []);

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

  // --- Hover / click / tooltip ---
  const handleMouseEnter = useCallback((node: NodePos, evt: React.MouseEvent) => {
    if (dragNode) return;
    setHovered(node.name);
    if (!pinned) {
      setTooltipOffset({ dx: 0, dy: 0 });
      setTooltip({ x: evt.clientX, y: evt.clientY, node });
    }
  }, [pinned, dragNode]);

  const handleMouseLeave = useCallback(() => {
    setHovered(null);
    if (!pinned) setTooltip(null);
  }, [pinned]);

  const handleClick = useCallback((node: NodePos, evt: React.MouseEvent) => {
    if (pinned === node.name) {
      setPinned(null);
      setTooltip(null);
    } else {
      setPinned(node.name);
      setTooltipOffset({ dx: 0, dy: 0 });
      setTooltip({ x: evt.clientX, y: evt.clientY, node });
    }
  }, [pinned]);

  const hoveredEdges = useMemo(() => {
    if (!activeNode) return new Set<number>();
    const s = new Set<number>();
    edges.forEach((e, i) => {
      if (e.Caller === activeNode || e.Callee === activeNode) s.add(i);
    });
    return s;
  }, [activeNode, edges]);

  const connectedNodes = useMemo(() => {
    if (!activeNode) return new Set<string>();
    const s = new Set<string>();
    s.add(activeNode);
    edges.forEach((e) => {
      if (e.Caller === activeNode) s.add(e.Callee);
      if (e.Callee === activeNode) s.add(e.Caller);
    });
    return s;
  }, [activeNode, edges]);

  // Fit view to focused (connected) nodes when focus mode + pinned
  const savedView = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    if (focusMode && pinned && connectedNodes.size > 0) {
      // Save current view on first focus
      if (!savedView.current) {
        savedView.current = { zoom, pan: { ...pan } };
      }
      const focused = nodes.filter((n) => connectedNodes.has(n.name));
      if (focused.length === 0) return;
      const padding = 100;
      const minX = Math.min(...focused.map((n) => n.x - nodeRadius(n)));
      const maxX = Math.max(...focused.map((n) => n.x + nodeRadius(n)));
      const minY = Math.min(...focused.map((n) => n.y - nodeRadius(n)));
      const maxY = Math.max(...focused.map((n) => n.y + nodeRadius(n)));
      const bboxW = maxX - minX + padding * 2;
      const bboxH = maxY - minY + padding * 2;
      const containerW = dimensions.width;
      // Use actual visible height from the container element, not the full SVG height
      const visibleH = containerRef.current?.clientHeight ?? 600;
      const newZoom = Math.min(3, Math.max(0.3, Math.min(containerW / bboxW, visibleH / bboxH)));
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const newPanX = containerW / 2 - centerX * newZoom;
      const newPanY = visibleH / 2 - centerY * newZoom;
      setAnimating(true);
      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
      const timer = setTimeout(() => setAnimating(false), 700);
      return () => clearTimeout(timer);
    } else if (savedView.current) {
      // Restore previous view when leaving focus
      setAnimating(true);
      setZoom(savedView.current.zoom);
      setPan(savedView.current.pan);
      savedView.current = null;
      const timer = setTimeout(() => setAnimating(false), 700);
      return () => clearTimeout(timer);
    }
  }, [focusMode, pinned, connectedNodes]);

  const containerStyle: React.CSSProperties = { width: "100%", position: "relative", minHeight: 500, maxHeight: "80vh", overflow: "hidden", borderRadius: 8, border: "1px solid rgba(99,130,191,0.15)" };

  const btnStyle: React.CSSProperties = {
    background: "rgba(99, 130, 191, 0.15)",
    border: "1px solid rgba(99, 130, 191, 0.3)",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 11,
    color: "rgba(255,255,255,0.6)",
    cursor: "pointer",
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      {/* Toolbar */}
      <div style={{ position: "absolute", top: 8, right: 12, zIndex: 10, display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          {nodes.length} services &middot; {edges.length} call relationships
        </span>
        <button style={btnStyle} onClick={() => setZoom((z) => Math.min(3, z + 0.2))} title="Zoom In">+</button>
        <button style={btnStyle} onClick={() => setZoom((z) => Math.max(0.3, z - 0.2))} title="Zoom Out">−</button>
        <button style={btnStyle} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); setNodeOffsets({}); }} title="Reset View">Reset</button>
        <button
          style={{ ...btnStyle, color: focusMode ? "#4589FF" : "rgba(255,255,255,0.6)", background: focusMode ? "rgba(69, 137, 255, 0.25)" : btnStyle.background, border: focusMode ? "1px solid rgba(69, 137, 255, 0.6)" : btnStyle.border }}
          onClick={() => setFocusMode(!focusMode)}
          title={focusMode ? "Focus Mode: ON — unrelated nodes hidden on hover" : "Focus Mode: OFF — unrelated nodes dimmed on hover"}
        >
          Focus: {focusMode ? "ON" : "OFF"}
        </button>
      </div>

      <svg
        width={dimensions.width}
        height={svgHeight}
        style={{ display: "block", cursor: isPanning ? "grabbing" : dragNode ? "move" : "grab" }}
        onMouseDown={handleSvgMouseDown}
        onWheel={handleWheel}
      >
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="rgba(99,130,191,0.5)" />
          </marker>
          <marker id="arrowhead-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={BLUE} />
          </marker>
        </defs>

        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`} style={{ transition: animating ? "transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)" : "none" }}>
          {/* Edges */}
          {edges.map((e, i) => {
            const src = nodeMap.get(e.Caller);
            const tgt = nodeMap.get(e.Callee);
            if (!src || !tgt) return null;
            const isHl = hoveredEdges.has(i);
            const r = nodeRadius(tgt);
            const dx = tgt.x - src.x;
            const dy = tgt.y - src.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const x2 = tgt.x - (dx / dist) * (r + 4);
            const y2 = tgt.y - (dy / dist) * (r + 4);
            return (
              <line
                key={i}
                x1={src.x}
                y1={src.y}
                x2={x2}
                y2={y2}
                stroke={isHl ? BLUE : getEdgeColor(src.failureRate, tgt.failureRate)}
                strokeWidth={isHl ? 2.5 : 1.5}
                markerEnd={isHl ? "url(#arrowhead-hl)" : "url(#arrowhead)"}
                opacity={activeNode && !isHl ? (focusMode ? 0 : 0.12) : 1}
                style={{ transition: "opacity 0.2s" }}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((n) => {
            const r = nodeRadius(n);
            const isHl = activeNode === n.name;
            const dimmed = activeNode && !connectedNodes.has(n.name);
            const hidden = focusMode && activeNode && !connectedNodes.has(n.name);
            const color = getNodeColor(n.failureRate, n.status);
            return (
              <g
                key={n.name}
                onMouseEnter={(evt) => handleMouseEnter(n, evt)}
                onMouseLeave={handleMouseLeave}
                onClick={(evt) => handleClick(n, evt)}
                onMouseDown={(evt) => handleNodeMouseDown(n.name, evt)}
                style={{ cursor: dragNode === n.name ? "move" : "pointer" }}
              >
                {/* Outer ring */}
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r + 3}
                  fill="none"
                  stroke={color}
                  strokeWidth={2.5}
                  opacity={hidden ? 0 : dimmed ? 0.15 : 0.9}
                  style={{ transition: "opacity 0.2s" }}
                />
                {/* Inner fill */}
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r}
                  fill="transparent"
                  opacity={hidden ? 0 : dimmed ? 0.15 : 0.85}
                  stroke={isHl ? "#fff" : "none"}
                  strokeWidth={isHl ? 2 : 0}
                  style={{ transition: "opacity 0.2s" }}
                />
                <text
                  x={n.x}
                  y={n.y + 4}
                  textAnchor="middle"
                  fill={hidden ? "rgba(255,255,255,0)" : dimmed ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.85)"}
                  fontSize={10}
                  fontWeight={isHl ? 700 : 500}
                  style={{ transition: "fill 0.2s", pointerEvents: "none" }}
                >
                  {(n.name ?? "").length > 16 ? n.name.slice(0, 14) + "…" : n.name}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Tooltip */}
      {tooltip && (() => {
        const ttW = 280;
        const ttH = 320;
        const rawLeft = tooltip.x + 16 + tooltipOffset.dx;
        const rawTop = tooltip.y - 20 + tooltipOffset.dy;
        const clampedLeft = Math.max(8, Math.min(rawLeft, window.innerWidth - ttW - 8));
        const clampedTop = Math.max(8, Math.min(rawTop, window.innerHeight - ttH - 8));
        return (
        <div
          ref={tooltipRef}
          style={{
            position: "fixed",
            left: clampedLeft,
            top: clampedTop,
            background: "#1c2033",
            border: "1px solid rgba(99,130,191,0.3)",
            borderRadius: 12,
            padding: 0,
            fontSize: 13,
            color: "#fff",
            zIndex: 10001,
            pointerEvents: pinned ? "auto" : "none",
            minWidth: 260,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          {/* Header — drag handle */}
          <div
            onMouseDown={pinned ? handleTooltipMouseDown : undefined}
            style={{
            display: "flex", alignItems: "center", gap: 8, padding: "12px 16px 10px",
            borderBottom: "1px solid rgba(99,130,191,0.15)",
            cursor: pinned ? "grab" : "default",
            userSelect: "none",
          }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: getNodeColor(tooltip.node.failureRate, tooltip.node.status), display: "inline-block" }} />
            <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{tooltip.node.name}</span>
            {pinned && (
              <span
                onClick={() => { setPinned(null); setTooltip(null); }}
                style={{ cursor: "pointer", fontSize: 16, color: "rgba(255,255,255,0.4)", lineHeight: 1 }}
              >×</span>
            )}
          </div>

          {/* Metrics grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
            {/* Requests */}
            <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)", borderRight: "1px solid rgba(99,130,191,0.1)" }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: BLUE }}>■</span> Requests
              </div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{formatCount(tooltip.node.requests)}</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>total</div>
            </div>
            {/* Error Rate */}
            <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)" }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: RED }}>▲</span> Error Rate
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: getNodeColor(tooltip.node.failureRate, tooltip.node.status) }}>
                {(tooltip.node.failureRate ?? 0).toFixed(2)}%
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{tooltip.node.failureRate < 0.01 ? "0 errors" : ""}</div>
            </div>
            {/* P50 Latency */}
            <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)", borderRight: "1px solid rgba(99,130,191,0.1)" }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: YELLOW }}>⚡</span> P50 Latency
              </div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{formatMs(tooltip.node.latencyP50)}</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>median</div>
            </div>
            {/* P90 Latency */}
            <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(99,130,191,0.1)" }}>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: "#FF832B" }}>◑</span> P90 Latency
              </div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{formatMs(tooltip.node.latencyP90)}</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>90th pct</div>
            </div>
          </div>

          {/* Links section */}
          <div style={{ padding: "8px 16px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            {tooltip.node.status === "PROBLEM" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(194,25,48,0.1)", borderRadius: 6 }}>
                <span style={{ fontSize: 14 }}>🔴</span>
                {tooltip.node.eventId ? (
                  <a
                    href={`${envUrl}/ui/apps/dynatrace.davis.problems/problem/${tooltip.node.eventId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                  >
                    Problems &rsaquo;
                  </a>
                ) : (
                  <span style={{ color: RED, fontWeight: 600, fontSize: 12 }}>Active Problem</span>
                )}
              </div>
            )}
            {tooltip.node.entityId && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "rgba(69,137,255,0.08)", borderRadius: 6 }}>
                <span style={{ fontSize: 14 }}>🔗</span>
                <a
                  href={`${envUrl}/ui/apps/dynatrace.smartscape/view/dynatrace.smartscape.vertical-topology/${tooltip.node.entityId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                >
                  Service Details &rsaquo;
                </a>
              </div>
            )}
          </div>
        </div>
        );
      })()}
    </div>
  );
}
