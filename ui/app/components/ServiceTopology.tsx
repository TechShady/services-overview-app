import React, { useMemo, useState, useCallback, useRef, useEffect } from "react";

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
  Status: string;
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
  status: string;
  outDegree: number;
  inDegree: number;
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
  // also include services with no edges
  services.forEach((s) => { if (s.Service) nodeNames.add(s.Service); });

  const names = Array.from(nodeNames);

  // Classify: roots (only callers), leaves (only callees), middle (both)
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

  // Sort each group by request volume for visual hierarchy
  const reqSort = (a: string, b: string) =>
    (metricsMap.get(b)?.Requests ?? 0) - (metricsMap.get(a)?.Requests ?? 0);
  roots.sort(reqSort);
  middle.sort(reqSort);
  leaves.sort(reqSort);

  // Layout in columns: roots left, middle center, leaves right
  const cols = [roots, middle, leaves, isolated].filter((c) => c.length > 0);
  const padX = 140;
  const padY = 60;
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
        status: m?.Status ?? "",
        outDegree: outDeg.get(name) ?? 0,
        inDegree: inDeg.get(name) ?? 0,
      });
    });
  });

  return result;
}

export function ServiceTopology({ edges: rawEdges, services }: Props) {
  // Filter out edges with null/undefined names
  const edges = useMemo(() => rawEdges.filter((e) => e.Caller && e.Callee), [rawEdges]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 600 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: NodePos } | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);

  // Active node = pinned takes priority over hovered
  const activeNode = pinned ?? hovered;

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDimensions({ width, height });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const nodes = useMemo(
    () => layoutNodes(edges, services, dimensions.width, dimensions.height),
    [edges, services, dimensions]
  );

  const nodeMap = useMemo(() => {
    const m = new Map<string, NodePos>();
    nodes.forEach((n) => m.set(n.name, n));
    return m;
  }, [nodes]);

  const maxRequests = useMemo(() => Math.max(1, ...nodes.map((n) => n.requests)), [nodes]);

  const handleMouseEnter = useCallback((node: NodePos, evt: React.MouseEvent) => {
    setHovered(node.name);
    if (!pinned) setTooltip({ x: evt.clientX, y: evt.clientY, node });
  }, [pinned]);

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
      setTooltip({ x: evt.clientX, y: evt.clientY, node });
    }
  }, [pinned]);

  const nodeRadius = (n: NodePos) => {
    const minR = 12;
    const maxR = 32;
    return minR + (n.requests / maxRequests) * (maxR - minR);
  };

  // Highlighted edges for active node (pinned or hovered)
  const hoveredEdges = useMemo(() => {
    if (!activeNode) return new Set<number>();
    const s = new Set<number>();
    edges.forEach((e, i) => {
      if (e.Caller === activeNode || e.Callee === activeNode) s.add(i);
    });
    return s;
  }, [activeNode, edges]);

  // Connected nodes for active node
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

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", position: "relative", minHeight: 400 }}>
      {/* Focus Mode toggle */}
      <div style={{ position: "absolute", top: 8, right: 12, zIndex: 2 }}>
        <button
          onClick={() => setFocusMode(!focusMode)}
          style={{
            background: focusMode ? "rgba(69, 137, 255, 0.25)" : "rgba(99, 130, 191, 0.15)",
            border: `1px solid ${focusMode ? "rgba(69, 137, 255, 0.6)" : "rgba(99, 130, 191, 0.3)"}`,
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 11,
            color: focusMode ? "#4589FF" : "rgba(255,255,255,0.6)",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
          title={focusMode ? "Focus Mode: ON — unrelated nodes hidden on hover" : "Focus Mode: OFF — unrelated nodes dimmed on hover"}
        >
          Focus: {focusMode ? "ON" : "OFF"}
        </button>
      </div>
      <svg width={dimensions.width} height={dimensions.height} style={{ display: "block" }}>
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="rgba(99,130,191,0.5)" />
          </marker>
          <marker id="arrowhead-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={BLUE} />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((e, i) => {
          const src = nodeMap.get(e.Caller);
          const tgt = nodeMap.get(e.Callee);
          if (!src || !tgt) return null;
          const isHl = hoveredEdges.has(i);
          const r = nodeRadius(tgt);
          // Shorten line to stop at node edge
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
              opacity={activeNode && !isHl ? (focusMode ? 0 : 0.15) : 1}
              style={{ transition: "opacity 0.2s" }}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((n) => {
          const r = nodeRadius(n);
          const isHl = activeNode === n.name;
          const dimmed = activeNode && !isHl && !hoveredEdges.size ? false : activeNode && !isHl && !edges.some((e) => (e.Caller === activeNode && e.Callee === n.name) || (e.Callee === activeNode && e.Caller === n.name));
          const hidden = focusMode && activeNode && !connectedNodes.has(n.name);
          const color = getNodeColor(n.failureRate, n.status);
          return (
            <g
              key={n.name}
              onMouseEnter={(evt) => handleMouseEnter(n, evt)}
              onMouseLeave={handleMouseLeave}
              onClick={(evt) => handleClick(n, evt)}
              style={{ cursor: "pointer" }}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={r}
                fill={color}
                opacity={hidden ? 0 : dimmed ? 0.2 : 0.85}
                stroke={isHl ? "#fff" : "rgba(255,255,255,0.15)"}
                strokeWidth={isHl ? 2.5 : 1}
                style={{ transition: "opacity 0.2s" }}
              />
              <text
                x={n.x}
                y={n.y + r + 14}
                textAnchor="middle"
                fill={hidden ? "rgba(255,255,255,0)" : dimmed ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.75)"}
                fontSize={11}
                fontWeight={isHl ? 700 : 400}
                style={{ transition: "fill 0.2s", pointerEvents: "none" }}
              >
                {(n.name ?? "").length > 24 ? n.name.slice(0, 22) + "…" : n.name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "fixed",
            left: tooltip.x + 12,
            top: tooltip.y - 10,
            background: "rgba(20, 24, 40, 0.95)",
            border: "1px solid rgba(99,130,191,0.4)",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 12,
            color: "#fff",
            zIndex: 10000,
            pointerEvents: "none",
            minWidth: 180,
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{tooltip.node.name}</div>
          <div>Requests: <strong>{(tooltip.node.requests ?? 0).toLocaleString()}</strong></div>
          <div>
            Failure Rate:{" "}
            <strong style={{ color: getNodeColor(tooltip.node.failureRate, tooltip.node.status) }}>
              {(tooltip.node.failureRate ?? 0).toFixed(2)}%
            </strong>
          </div>
          <div>Calls out: {tooltip.node.outDegree} &nbsp;|&nbsp; Called by: {tooltip.node.inDegree}</div>
          {tooltip.node.status === "PROBLEM" && (
            <div style={{ color: RED, fontWeight: 600, marginTop: 4 }}>⚠ Active Problem</div>
          )}
        </div>
      )}

      {/* Legend */}
      <div
        style={{
          position: "absolute",
          bottom: 8,
          right: 12,
          display: "flex",
          gap: 12,
          fontSize: 10,
          color: "rgba(255,255,255,0.5)",
        }}
      >
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: GREEN, marginRight: 3 }} />Healthy</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: YELLOW, marginRight: 3 }} />Warning</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: RED, marginRight: 3 }} />Critical</span>
        <span style={{ marginLeft: 8 }}>Node size = request volume</span>
      </div>
    </div>
  );
}
