import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

const RED = "#C21930";
const ORANGE = "#FF8C00";
const BLUE = "#4589FF";
const HOST_COLOR = "#6929C4";
const AWS_COLOR = "#FF9900";
const AZURE_COLOR = "#008AD7";
const GCP_COLOR = "#34A853";
const PROCESS_COLOR = "#FF8C00";
const CONTAINER_COLOR = "#00B4D8";
const LAMBDA_COLOR = "#FCD53F";
const AZURE_FUNC_COLOR = "#0078D4";

const REGION_R = 34;
const HOST_R = 14;
const NODE_R = 11;
const MIN_GAP = 26;

function getProvider(region: string): "aws" | "gcp" | "azure" | "unknown" {
  if (/^[a-z]+-[a-z]+-\d+[a-z]?$/.test(region)) return "aws";
  if (/^[a-z]+-[a-z]+\d+$/.test(region)) return "gcp";
  if (/^[a-z]+\d*$/.test(region)) return "azure";
  return "unknown";
}
function getProviderColor(r: string): string {
  const p = getProvider(r);
  return p === "aws" ? AWS_COLOR : p === "azure" ? AZURE_COLOR : p === "gcp" ? GCP_COLOR : BLUE;
}
function formatCount(n: number | undefined): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toLocaleString();
}
function formatMs(val: number | undefined): string {
  if (val == null || isNaN(val)) return "N/A";
  return val >= 1000 ? (val / 1000).toFixed(1) + " s" : val.toFixed(1) + " ms";
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
  hostToProcesses?: Map<string, string[]>;
  hostToContainers?: Map<string, string[]>;
  containerToProcesses?: Map<string, string[]>;
  lambdas?: string[];
  azureFunctions?: string[];
  tfFrom?: string;
  tfTo?: string;
}

type NodeType = "region" | "host" | "service" | "process" | "container" | "lambda" | "azurefunc" | "cascade" | "ctrproc";

interface RadialNode {
  id: string; label: string;
  x: number; y: number; baseX: number; baseY: number;
  radius: number; type: NodeType; ring: number; angle: number;
  arcStart?: number; arcEnd?: number; parentId?: string;
  services?: string[]; processes?: string[]; containers?: string[];
  serviceCount?: number; processCount?: number; containerCount?: number;
  isOverflow?: boolean;
}

export function CloudRegionBlastRadiusGraph({
  region, hosts, clusters, directServices, affectedExternalServices, serviceEdges,
  hostToServices, hostIdMap, serviceDetails, hostToProcesses, hostToContainers,
  containerToProcesses,
  lambdas = [], azureFunctions = [],
  tfFrom = "now()-2h", tfTo = "now()",
}: CloudRegionBlastRadiusGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: RadialNode } | null>(null);
  const [tooltipOffset, setTooltipOffset] = useState({ dx: 0, dy: 0 });
  const [draggingTooltip, setDraggingTooltip] = useState(false);
  const [tooltipDragStart, setTooltipDragStart] = useState({ x: 0, y: 0 });
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [animPhase, setAnimPhase] = useState<"idle" | "live">("idle");
  const [animKey, setAnimKey] = useState(0);
  const [cascadeActive, setCascadeActive] = useState(false);
  const [cascadeFailedSet, setCascadeFailedSet] = useState<Set<string>>(new Set());
  const [cascadeDegradedSet, setCascadeDegradedSet] = useState<Set<string>>(new Set());
  const [cascadeComplete, setCascadeComplete] = useState(false);
  const [cascadeElapsed, setCascadeElapsed] = useState(0);
  const cascadeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cascadeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const blastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const envUrl = useMemo(() => getEnvironmentUrl().replace(/\/$/, ""), []);
  const regionColor = useMemo(() => getProviderColor(region), [region]);

  // Sorted hosts: most children first (no cap)
  const sortedHosts = useMemo(() =>
    [...hosts].sort((a, b) =>
      ((hostToServices.get(b)?.size ?? 0) + (hostToProcesses?.get(b)?.length ?? 0) + (hostToContainers?.get(b)?.length ?? 0)) -
      ((hostToServices.get(a)?.size ?? 0) + (hostToProcesses?.get(a)?.length ?? 0) + (hostToContainers?.get(a)?.length ?? 0))
    ),
  [hosts, hostToServices, hostToProcesses, hostToContainers]);

  // Per-host child data
  const hostChildData = useMemo(() => sortedHosts.map(h => ({
    host: h,
    svcs: [...(hostToServices.get(h) ?? new Set())],
    procs: hostToProcesses?.get(h) ?? [] as string[],
    ctrs: hostToContainers?.get(h) ?? [] as string[],
  })), [sortedHosts, hostToServices, hostToProcesses, hostToContainers]);

  // Container → processes map (only containers with process data)
  const ctrProcData = useMemo(() => {
    const m = new Map<string, string[]>();
    hostChildData.forEach(({ ctrs }) => {
      ctrs.forEach(c => {
        const procs = containerToProcesses?.get(c);
        if (procs?.length) m.set(c, procs);
      });
    });
    return m;
  }, [hostChildData, containerToProcesses]);

  // Flat arrays for animation
  const allSvcs = useMemo(() => [...new Set(hostChildData.flatMap(hd => hd.svcs))], [hostChildData]);
  const allProcs = useMemo(() => [...new Set(hostChildData.flatMap(hd => hd.procs))], [hostChildData]);
  const allCtrs = useMemo(() => [...new Set(hostChildData.flatMap(hd => hd.ctrs))], [hostChildData]);
  const allCtrProcs = useMemo(() => {
    const arr: string[] = [];
    ctrProcData.forEach((procs, ctr) => procs.forEach(p => arr.push(`ctrproc:${ctr}:${p}`)));
    return arr;
  }, [ctrProcData]);

  const ring1Count = sortedHosts.length + lambdas.length + azureFunctions.length;
  const ring2Count = hostChildData.reduce((s, hd) => s + hd.svcs.length + hd.procs.length + hd.ctrs.length, 0);
  const ring3Count = allCtrProcs.length;
  const ringCascCount = affectedExternalServices.length;
  const hasCascade = ringCascCount > 0;
  const hasContainerProcs = ring3Count > 0;
  const hasServerless = lambdas.length > 0 || azureFunctions.length > 0;

  // Dynamic radii
  const { R1, R2, R3ctr, Rcasc, canvasHeight } = useMemo(() => {
    const r = (n: number) => n > 0 ? (n * MIN_GAP) / (2 * Math.PI) : 0;
    const r1 = Math.max(120, r(ring1Count));
    const r2 = ring2Count > 0 ? Math.max(r1 + 90, r(ring2Count)) : 0;
    const r3 = ring3Count > 0 ? Math.max((r2 || r1) + 70, r(ring3Count)) : 0;
    const rcasc = ringCascCount > 0 ? Math.max((r3 || r2 || r1) + 70, r(ringCascCount)) : 0;
    const outer = Math.max(r1, r2, r3, rcasc);
    // Allow canvas larger than container (scrollable)
    const scale = outer > width * 1.4 ? (width * 1.4) / outer : 1;
    return {
      R1: r1 * scale, R2: r2 * scale,
      R3ctr: r3 * scale, Rcasc: rcasc * scale,
      canvasHeight: Math.max(500, 2 * (outer * scale + 90)),
    };
  }, [ring1Count, ring2Count, ring3Count, ringCascCount, width]);

  const cx = width / 2; const cy = canvasHeight / 2;

  // Build nodes with sector-based layout
  const baseNodes = useMemo((): RadialNode[] => {
    const nodes: RadialNode[] = [];

    // Center: region
    nodes.push({ id: "region", label: region, x: cx, y: cy, baseX: cx, baseY: cy, radius: REGION_R, type: "region", ring: 0, angle: 0 });

    // RING 1: sector-based arc allocation
    // Each host gets arc proportional to its child count (min 1); each serverless entity = 1 unit
    const hostWeights = hostChildData.map(hd => Math.max(1, hd.svcs.length + hd.procs.length + hd.ctrs.length));
    const serverlessCount = lambdas.length + azureFunctions.length;
    const totalWeight = hostWeights.reduce((s, w) => s + w, 0) + serverlessCount;
    const unitArc = totalWeight > 0 ? (2 * Math.PI) / totalWeight : (2 * Math.PI) / Math.max(1, ring1Count);

    let curAngle = -Math.PI / 2;
    const hostMeta: { centerAngle: number; arcStart: number; arcSize: number }[] = [];

    hostChildData.forEach((hd, i) => {
      const arcSize = hostWeights[i] * unitArc;
      const centerAngle = curAngle + arcSize / 2;
      hostMeta.push({ centerAngle, arcStart: curAngle, arcSize });
      const x = cx + R1 * Math.cos(centerAngle);
      const y = cy + R1 * Math.sin(centerAngle);
      nodes.push({
        id: `host:${hd.host}`, label: hd.host, x, y, baseX: x, baseY: y,
        radius: HOST_R, type: "host", ring: 1, angle: centerAngle,
        arcStart: curAngle, arcEnd: curAngle + arcSize,
        services: hd.svcs, processes: hd.procs, containers: hd.ctrs,
        serviceCount: hd.svcs.length, processCount: hd.procs.length, containerCount: hd.ctrs.length,
      });
      curAngle += arcSize;
    });

    // Serverless in remaining arc
    [...lambdas.map(l => ({ id: `lambda:${l}`, label: l, type: "lambda" as NodeType })),
     ...azureFunctions.map(f => ({ id: `azfunc:${f}`, label: f, type: "azurefunc" as NodeType })),
    ].forEach(item => {
      const arcSize = unitArc;
      const centerAngle = curAngle + arcSize / 2;
      const x = cx + R1 * Math.cos(centerAngle);
      const y = cy + R1 * Math.sin(centerAngle);
      nodes.push({ id: item.id, label: item.label, x, y, baseX: x, baseY: y, radius: NODE_R, type: item.type, ring: 1, angle: centerAngle, arcStart: curAngle, arcEnd: curAngle + arcSize });
      curAngle += arcSize;
    });

    // RING 2: children of each host within that host's arc sector
    if (R2 > 0) {
      hostChildData.forEach((hd, hi) => {
        const { arcStart, arcSize, centerAngle: hostCenter } = hostMeta[hi];
        const children: { id: string; label: string; type: NodeType }[] = [
          ...hd.svcs.map(s => ({ id: `svc:${s}`, label: s, type: "service" as NodeType })),
          ...hd.procs.map(p => ({ id: `proc:${p}`, label: p, type: "process" as NodeType })),
          ...hd.ctrs.map(c => ({ id: `ctr:${c}`, label: c, type: "container" as NodeType })),
        ];
        const n = children.length;
        if (n === 0) return;
        children.forEach((child, ci) => {
          const angle = n === 1 ? hostCenter : arcStart + (ci + 0.5) * (arcSize / n);
          const subArc = arcSize / n;
          const x = cx + R2 * Math.cos(angle);
          const y = cy + R2 * Math.sin(angle);
          nodes.push({
            id: child.id, label: child.label, x, y, baseX: x, baseY: y,
            radius: NODE_R, type: child.type, ring: 2, angle,
            arcStart: angle - subArc / 2, arcEnd: angle + subArc / 2,
            parentId: `host:${hd.host}`,
          });
        });
      });
    }

    // RING 3: processes inside containers, within each container's arc sub-sector
    if (R3ctr > 0 && hasContainerProcs) {
      const ctrNodeMap = new Map<string, RadialNode>();
      nodes.filter(n => n.type === "container").forEach(n => ctrNodeMap.set(n.label, n));
      ctrProcData.forEach((procs, ctr) => {
        const ctrNode = ctrNodeMap.get(ctr);
        if (!ctrNode) return;
        const cStart = ctrNode.arcStart ?? ctrNode.angle - 0.05;
        const cEnd = ctrNode.arcEnd ?? ctrNode.angle + 0.05;
        const cArcSize = cEnd - cStart;
        const n = procs.length;
        procs.forEach((proc, pi) => {
          const angle = n === 1 ? ctrNode.angle : cStart + (pi + 0.5) * (cArcSize / n);
          const x = cx + R3ctr * Math.cos(angle);
          const y = cy + R3ctr * Math.sin(angle);
          nodes.push({
            id: `ctrproc:${ctr}:${proc}`, label: proc, x, y, baseX: x, baseY: y,
            radius: NODE_R - 1, type: "ctrproc", ring: 3, angle,
            parentId: `ctr:${ctr}`,
          });
        });
      });
    }

    // CASCADE RING: external services that call our services
    if (Rcasc > 0 && hasCascade) {
      const n = affectedExternalServices.length;
      affectedExternalServices.forEach((s, i) => {
        const angle = (2 * Math.PI * i) / n - Math.PI / 2;
        const x = cx + Rcasc * Math.cos(angle);
        const y = cy + Rcasc * Math.sin(angle);
        nodes.push({ id: `casc:${s}`, label: s, x, y, baseX: x, baseY: y, radius: NODE_R, type: "cascade", ring: 4, angle });
      });
    }

    return nodes;
  }, [region, cx, cy, R1, R2, R3ctr, Rcasc, hostChildData, ctrProcData, lambdas, azureFunctions, affectedExternalServices, hasCascade, hasContainerProcs, ring1Count]);

  const nodes = useMemo(() => baseNodes.map(n => {
    const off = nodeOffsets[n.id];
    return off ? { ...n, x: n.baseX + off.dx, y: n.baseY + off.dy } : n;
  }), [baseNodes, nodeOffsets]);

  const nodeMap = useMemo(() => { const m = new Map<string, RadialNode>(); nodes.forEach(n => m.set(n.id, n)); return m; }, [nodes]);

  // Build edges
  const edges = useMemo(() => {
    type ET = "r-host" | "r-sl" | "h-down" | "ctr-proc" | "down-casc";
    const result: { from: string; to: string; type: ET }[] = [];
    sortedHosts.forEach(h => result.push({ from: "region", to: `host:${h}`, type: "r-host" }));
    [...lambdas.map(l => `lambda:${l}`), ...azureFunctions.map(f => `azfunc:${f}`)].forEach(id =>
      result.push({ from: "region", to: id, type: "r-sl" })
    );
    if (R2 > 0) {
      hostChildData.forEach(hd => {
        const hId = `host:${hd.host}`;
        hd.svcs.forEach(s => result.push({ from: hId, to: `svc:${s}`, type: "h-down" }));
        hd.procs.forEach(p => result.push({ from: hId, to: `proc:${p}`, type: "h-down" }));
        hd.ctrs.forEach(c => result.push({ from: hId, to: `ctr:${c}`, type: "h-down" }));
      });
    }
    if (R3ctr > 0) {
      ctrProcData.forEach((procs, ctr) => {
        procs.forEach(p => result.push({ from: `ctr:${ctr}`, to: `ctrproc:${ctr}:${p}`, type: "ctr-proc" }));
      });
    }
    if (Rcasc > 0 && hasCascade) {
      const svcSet = new Set(allSvcs.map(s => `svc:${s}`));
      const cascSet = new Set(affectedExternalServices.map(s => `casc:${s}`));
      let matched = false;
      serviceEdges.forEach(e => {
        const from = `svc:${e.to}`; const to = `casc:${e.from}`;
        if (svcSet.has(from) && cascSet.has(to)) { result.push({ from, to, type: "down-casc" }); matched = true; }
      });
      if (!matched) {
        allSvcs.slice(0, 3).forEach(s =>
          affectedExternalServices.slice(0, 3).forEach(c =>
            result.push({ from: `svc:${s}`, to: `casc:${c}`, type: "down-casc" })
          )
        );
      }
    }
    return result;
  }, [sortedHosts, hostChildData, lambdas, azureFunctions, R2, R3ctr, Rcasc, hasCascade, ctrProcData, allSvcs, affectedExternalServices, serviceEdges]);

  const activeNode = pinned ?? hovered;
  const connectedNodes = useMemo(() => {
    if (!activeNode) return new Set<string>();
    const s = new Set<string>([activeNode]);
    edges.forEach(e => { if (e.from === activeNode) s.add(e.to); if (e.to === activeNode) s.add(e.from); });
    return s;
  }, [activeNode, edges]);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(e => { const w = e[0].contentRect.width; if (w > 0) setWidth(w); });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const triggerAnim = useCallback(() => {
    if (blastTimerRef.current) clearTimeout(blastTimerRef.current);
    setAnimPhase("idle"); setAnimKey(k => k + 1);
    blastTimerRef.current = setTimeout(() => setAnimPhase("live"), 60);
  }, []);
  useEffect(() => { triggerAnim(); }, [region]); // eslint-disable-line

  const stopCascade = useCallback(() => {
    cascadeTimersRef.current.forEach(clearTimeout); cascadeTimersRef.current = [];
    if (cascadeIntervalRef.current) { clearInterval(cascadeIntervalRef.current); cascadeIntervalRef.current = null; }
    setCascadeActive(false); setCascadeFailedSet(new Set()); setCascadeDegradedSet(new Set());
    setCascadeElapsed(0); setCascadeComplete(false);
  }, []);

  const startCascade = useCallback(() => {
    stopCascade(); setCascadeActive(true); setCascadeComplete(false);
    setCascadeFailedSet(new Set(["region"]));
    let e = 0; cascadeIntervalRef.current = setInterval(() => { e++; setCascadeElapsed(e); }, 1000);
    // Ring 1: hosts
    sortedHosts.forEach((h, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(`host:${h}`); return s; }), 400 + i * 40),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(`host:${h}`); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(`host:${h}`); return s; }); }, 750 + i * 40)
      );
    });
    // Ring 1: serverless
    [...lambdas.map(l => `lambda:${l}`), ...azureFunctions.map(f => `azfunc:${f}`)].forEach((id, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(id); return s; }), 450 + i * 40),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(id); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(id); return s; }); }, 800 + i * 40)
      );
    });
    const r1End = 750 + Math.max(0, sortedHosts.length - 1) * 40 + 300;
    // Ring 2: services, processes, containers
    [...allProcs.map(p => `proc:${p}`), ...allCtrs.map(c => `ctr:${c}`), ...allSvcs.map(s => `svc:${s}`)].forEach((id, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(id); return s; }), r1End + i * 50),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(id); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(id); return s; }); }, r1End + 280 + i * 50)
      );
    });
    const r2End = r1End + 280 + Math.max(0, (allProcs.length + allCtrs.length + allSvcs.length - 1)) * 50 + 350;
    // Ring 3: container processes
    allCtrProcs.forEach((id, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const s = new Set(p); s.add(id); return s; }), r2End + i * 40),
        setTimeout(() => { setCascadeFailedSet(p => { const s = new Set(p); s.add(id); return s; }); setCascadeDegradedSet(p => { const s = new Set(p); s.delete(id); return s; }); }, r2End + 250 + i * 40)
      );
    });
    const r3End = r2End + 250 + Math.max(0, allCtrProcs.length - 1) * 40 + 300;
    // Cascade: degrade (not fail)
    affectedExternalServices.forEach((s, i) => {
      cascadeTimersRef.current.push(
        setTimeout(() => setCascadeDegradedSet(p => { const ns = new Set(p); ns.add(`casc:${s}`); return ns; }), r3End + i * 60)
      );
    });
    cascadeTimersRef.current.push(setTimeout(() => setCascadeComplete(true), r3End + Math.max(0, affectedExternalServices.length - 1) * 60 + 600));
  }, [sortedHosts, allSvcs, allProcs, allCtrs, allCtrProcs, lambdas, azureFunctions, affectedExternalServices, stopCascade]);

  useEffect(() => () => stopCascade(), [stopCascade]);

  const handleNodeMouseDown = useCallback((id: string, evt: React.MouseEvent) => {
    evt.stopPropagation(); evt.preventDefault(); setDragNode(id);
  }, []);
  useEffect(() => {
    if (!dragNode) return;
    const move = (evt: MouseEvent) => {
      const svg = containerRef.current?.querySelector("svg"); if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const base = baseNodes.find(n => n.id === dragNode); if (!base) return;
      setNodeOffsets(prev => ({ ...prev, [dragNode]: { dx: evt.clientX - rect.left - base.baseX, dy: evt.clientY - rect.top - base.baseY } }));
    };
    const up = () => setDragNode(null);
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [dragNode, baseNodes]);

  const handleTooltipMouseDown = useCallback((evt: React.MouseEvent) => {
    evt.preventDefault(); evt.stopPropagation(); setDraggingTooltip(true);
    setTooltipDragStart({ x: evt.clientX - tooltipOffset.dx, y: evt.clientY - tooltipOffset.dy });
  }, [tooltipOffset]);
  useEffect(() => {
    if (!draggingTooltip) return;
    const move = (evt: MouseEvent) => setTooltipOffset({ dx: evt.clientX - tooltipDragStart.x, dy: evt.clientY - tooltipDragStart.y });
    const up = () => setDraggingTooltip(false);
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [draggingTooltip, tooltipDragStart]);

  const nodeToScreen = useCallback((node: RadialNode) => {
    const svg = containerRef.current?.querySelector("svg") as SVGSVGElement | null; if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect(); return { x: rect.left + node.x, y: rect.top + node.y };
  }, []);

  const handleMouseEnter = useCallback((node: RadialNode) => {
    if (dragNode) return; setHovered(node.id);
    if (!pinned) { const pos = nodeToScreen(node); setTooltipOffset({ dx: 0, dy: 0 }); setTooltip({ x: pos.x, y: pos.y, node }); }
  }, [dragNode, pinned, nodeToScreen]);
  const handleMouseLeave = useCallback(() => { setHovered(null); if (!pinned) setTooltip(null); }, [pinned]);
  const handleClick = useCallback((node: RadialNode) => {
    if (node.isOverflow) return;
    if (pinned === node.id) { setPinned(null); setTooltip(null); }
    else { setPinned(node.id); const pos = nodeToScreen(node); setTooltipOffset({ dx: 0, dy: 0 }); setTooltip({ x: pos.x, y: pos.y, node }); }
  }, [pinned, nodeToScreen]);

  const isIdle = animPhase === "idle";

  function nodeColor(t: NodeType): string {
    if (t === "region") return regionColor;
    if (t === "host") return HOST_COLOR;
    if (t === "service") return RED;
    if (t === "process") return PROCESS_COLOR;
    if (t === "container") return CONTAINER_COLOR;
    if (t === "ctrproc") return PROCESS_COLOR;
    if (t === "lambda") return LAMBDA_COLOR;
    if (t === "azurefunc") return AZURE_FUNC_COLOR;
    return ORANGE;
  }
  function nodeIcon(n: RadialNode, failed: boolean, deg: boolean): string {
    if (failed) return "💀"; if (deg) return "🔥";
    if (n.type === "region") return "🌍";
    if (n.type === "host") return "🖥";
    if (n.type === "service") return "⚙";
    if (n.type === "process" || n.type === "ctrproc") return "🔧";
    if (n.type === "container") return "📦";
    if (n.type === "lambda") return "λ";
    if (n.type === "azurefunc") return "ƒ";
    return "⚙";
  }
  function edgeColor(type: string, hl: boolean): string {
    if (type === "r-host") return hl ? regionColor : `${regionColor}45`;
    if (type === "r-sl") return hl ? LAMBDA_COLOR : "rgba(252,213,63,0.38)";
    if (type === "ctr-proc") return hl ? CONTAINER_COLOR : "rgba(0,180,216,0.25)";
    if (type === "h-down") return hl ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.1)";
    return hl ? RED : "rgba(194,25,48,0.3)";
  }

  const legend = [
    { color: regionColor, label: "Region" },
    { color: HOST_COLOR, label: "Host" },
    { color: RED, label: "Service" },
    { color: PROCESS_COLOR, label: "Process" },
    { color: CONTAINER_COLOR, label: "Container" },
    ...(hasContainerProcs ? [{ color: PROCESS_COLOR, label: "Ctr Process" }] : []),
    ...(lambdas.length > 0 ? [{ color: LAMBDA_COLOR, label: "Lambda" }] : []),
    ...(azureFunctions.length > 0 ? [{ color: AZURE_FUNC_COLOR, label: "Azure Fn" }] : []),
    ...(hasCascade ? [{ color: "#C86C00", label: "Cascade" }] : []),
  ];

  // Node counts for summary
  const totalNodes = nodes.length - 1; // exclude region

  return (
    <div ref={containerRef} style={{ width: "100%", position: "relative", borderRadius: 8, border: "1px solid rgba(99,130,191,0.15)", overflow: "hidden" }}>
      {/* Toolbar */}
      <div style={{ position: "absolute", top: 8, right: 10, zIndex: 10, display: "flex", gap: 7, alignItems: "center", fontSize: 10, flexWrap: "wrap", maxWidth: "80%", justifyContent: "flex-end" }}>
        {cascadeActive && (
          <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: cascadeComplete ? ORANGE : RED, background: "rgba(194,25,48,0.12)", border: `1px solid ${cascadeComplete ? ORANGE : RED}`, borderRadius: 6, padding: "2px 7px" }}>
            {cascadeComplete ? `⚠ CASCADED — ${cascadeFailedSet.size} FAILING` : `⚡ T+${String(Math.floor(cascadeElapsed / 60)).padStart(2, "0")}:${String(cascadeElapsed % 60).padStart(2, "0")}`}
          </span>
        )}
        <span style={{ opacity: 0.45, fontSize: 9 }}>{totalNodes} entities</span>
        {legend.map(({ color, label }) => (
          <span key={label} style={{ opacity: 0.65 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: color, marginRight: 3 }} />{label}
          </span>
        ))}
        {cascadeActive
          ? <button onClick={stopCascade} style={{ background: "rgba(194,25,48,0.2)", border: "1px solid rgba(194,25,48,0.5)", borderRadius: 6, padding: "2px 7px", fontSize: 10, color: RED, cursor: "pointer", fontWeight: 600 }}>■ Stop</button>
          : <button onClick={startCascade} style={{ background: "rgba(69,137,255,0.12)", border: "1px solid rgba(69,137,255,0.35)", borderRadius: 6, padding: "2px 7px", fontSize: 10, color: BLUE, cursor: "pointer", fontWeight: 600 }}>⚡ Simulate</button>
        }
        <button onClick={() => { stopCascade(); setNodeOffsets({}); setPinned(null); setTooltip(null); setTimeout(triggerAnim, 10); }} style={{ background: "rgba(99,130,191,0.15)", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 6, padding: "2px 7px", fontSize: 10, color: "rgba(255,255,255,0.55)", cursor: "pointer" }}>Reset</button>
      </div>

      <div style={{ overflowX: canvasHeight > width ? "auto" : "visible" }}>
        <svg width={Math.max(width, canvasHeight)} height={canvasHeight} style={{ display: "block", minWidth: width, cursor: dragNode ? "move" : "default" }}
          onClick={e => { if ((e.target as Element).closest("circle,text")) return; if (pinned) { setPinned(null); setTooltip(null); } }}>
          <defs>
            <marker id="cr-casc-arrow" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0, 7 2.5, 0 5" fill="rgba(255,140,0,0.45)" /></marker>
            <filter id="cr-glow"><feGaussianBlur stdDeviation="4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            <filter id="cr-glow-strong"><feGaussianBlur stdDeviation="12" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            <radialGradient id="cr-bg" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={regionColor} stopOpacity="0.06" />
              <stop offset="100%" stopColor={regionColor} stopOpacity="0" />
            </radialGradient>
          </defs>

          {!isIdle && <ellipse cx={cx} cy={cy} rx={Math.max(width, canvasHeight) / 2} ry={canvasHeight / 2} fill="url(#cr-bg)" />}

          {/* Ring guides */}
          {!isIdle && [R1, R2, R3ctr, Rcasc].filter(r => r > 0).map((r, i) => (
            <circle key={`ring-${i}`} cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={1} strokeDasharray="4 6" />
          ))}

          {/* Entry shockwave */}
          {animPhase === "live" && [0, 1, 2].map(i => (
            <circle key={`wave-${animKey}-${i}`} cx={cx} cy={cy} r={REGION_R} fill="none"
              stroke={i === 0 ? regionColor : i === 1 ? RED : ORANGE} strokeWidth={2.5 - i * 0.6} opacity={0}>
              <animate attributeName="r" from={String(REGION_R)} to={String(Math.max(R1, R2, R3ctr, Rcasc, 200) + 60 + i * 40)} dur={`${0.9 + i * 0.2}s`} begin={`${i * 0.15}s`} fill="freeze" calcMode="spline" keySplines="0.1 0.8 0.2 1" />
              <animate attributeName="opacity" values={`0;${0.55 - i * 0.12};0`} dur={`${0.9 + i * 0.2}s`} begin={`${i * 0.15}s`} fill="freeze" />
            </circle>
          ))}
          {animPhase === "live" && (
            <circle key={`flash-${animKey}`} cx={cx} cy={cy} r={REGION_R} fill={regionColor} opacity={0} filter="url(#cr-glow-strong)">
              <animate attributeName="opacity" values="0;0.85;0" dur="0.55s" fill="freeze" />
              <animate attributeName="r" from={String(REGION_R)} to={String(REGION_R + 30)} dur="0.55s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.4 1" />
            </circle>
          )}

          {/* Edges — limit rendering to avoid extreme slow-down on huge graphs */}
          {edges.slice(0, 2000).map((e, i) => {
            const src = nodeMap.get(e.from); const tgt = nodeMap.get(e.to); if (!src || !tgt) return null;
            const dx = tgt.x - src.x; const dy = tgt.y - src.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const x1 = src.x + (dx / dist) * src.radius;
            const y1 = src.y + (dy / dist) * src.radius;
            const x2 = tgt.x - (dx / dist) * (tgt.radius + 2);
            const y2 = tgt.y - (dy / dist) * (tgt.radius + 2);
            const isHl = !!(activeNode && (activeNode === e.from || activeNode === e.to));
            const dimmed = !!(activeNode && !isHl);
            const opacityBase = e.type === "r-host" ? 0.3 : e.type === "r-sl" ? 0.4 : e.type === "ctr-proc" ? 0.2 : e.type === "h-down" ? 0.12 : 0.2;
            const opacity = isIdle ? 0 : dimmed ? 0.02 : isHl ? 0.9 : opacityBase;
            const stroke = edgeColor(e.type, isHl);
            const dash = e.type === "r-sl" ? "4 3" : e.type === "h-down" || e.type === "ctr-proc" ? "2 3" : undefined;
            return (
              <line key={`e-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={stroke} strokeWidth={isHl ? 1.5 : 0.7} strokeDasharray={dash}
                markerEnd={e.type === "down-casc" ? "url(#cr-casc-arrow)" : undefined}
                opacity={opacity}
                style={{ transition: isIdle ? "none" : `opacity 0.5s ease ${Math.min(0.4 + i * 0.003, 1.5)}s` }}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((n) => {
            const isCenter = n.type === "region";
            const isHl = activeNode === n.id;
            const dimmed = !!(activeNode && !connectedNodes.has(n.id));
            const cascFailed = cascadeActive && cascadeFailedSet.has(n.id);
            const cascDeg = cascadeActive && cascadeDegradedSet.has(n.id);
            const cascHealthy = cascadeActive && !cascFailed && !cascDeg;
            const col = cascFailed ? RED : cascDeg ? ORANGE : n.isOverflow ? "rgba(255,255,255,0.2)" : nodeColor(n.type);
            const fill = cascFailed ? "rgba(194,25,48,0.45)" : cascDeg ? "rgba(255,140,0,0.35)" : cascHealthy ? "rgba(99,130,191,0.07)" : `${nodeColor(n.type)}22`;
            const icon = nodeIcon(n, cascFailed, cascDeg);
            const offsetX = !isCenter && isIdle ? (cx - n.x) : 0;
            const offsetY = !isCenter && isIdle ? (cy - n.y) : 0;
            const nodeOpacity = !isCenter && isIdle ? 0 : 1;
            const ringIdx = n.ring as number;
            const ringDelay = ringIdx === 0 ? 0 : ringIdx === 1 ? 80 : ringIdx === 2 ? 400 : ringIdx === 3 ? 600 : 800;
            const posInRing = nodes.filter(x => x.ring === n.ring && !x.isOverflow).indexOf(n);
            const delayMs = ringDelay + posInRing * 15;
            const showLabel = isCenter || n.ring <= 1 || isHl;

            return (
              <g key={n.id}
                onMouseEnter={() => handleMouseEnter(n)} onMouseLeave={handleMouseLeave}
                onClick={() => handleClick(n)} onMouseDown={e => handleNodeMouseDown(n.id, e)}
                style={{
                  transform: `translate(${offsetX}px, ${offsetY}px)`, opacity: nodeOpacity,
                  cursor: n.isOverflow ? "default" : (dragNode === n.id ? "move" : "pointer"),
                  transition: isIdle ? "none" : `transform 1.3s cubic-bezier(0.34, 1.45, 0.64, 1) ${delayMs}ms, opacity 0.5s ease ${delayMs}ms`,
                }}>
                {isCenter && (
                  <circle cx={n.x} cy={n.y} r={n.radius + 8} fill="none" stroke={regionColor} strokeWidth={1.5} opacity={0.18} filter="url(#cr-glow)">
                    <animate attributeName="r" from={n.radius + 4} to={n.radius + 22} dur="2.8s" repeatCount="indefinite" />
                    <animate attributeName="opacity" from="0.25" to="0" dur="2.8s" repeatCount="indefinite" />
                  </circle>
                )}
                {cascFailed && !n.isOverflow && (
                  <circle cx={n.x} cy={n.y} r={n.radius + 5} fill="none" stroke={RED} strokeWidth={1.5} opacity={0} filter="url(#cr-glow)">
                    <animate attributeName="r" from={n.radius + 2} to={n.radius + 14} dur="1s" repeatCount="indefinite" />
                    <animate attributeName="opacity" from="0.55" to="0" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle cx={n.x} cy={n.y} r={n.radius + 2.5} fill="none" stroke={col}
                  strokeWidth={isCenter ? 2.5 : 1.5} strokeDasharray={n.isOverflow ? "3 3" : undefined}
                  opacity={dimmed ? 0.1 : cascHealthy ? 0.22 : isHl ? 1 : 0.7}
                  style={{ transition: "stroke 0.4s, opacity 0.2s" }} />
                <circle cx={n.x} cy={n.y} r={n.radius} fill={fill}
                  stroke={isHl ? "rgba(255,255,255,0.8)" : "none"} strokeWidth={isHl ? 1.5 : 0}
                  opacity={dimmed ? 0.12 : cascHealthy ? 0.25 : 1}
                  style={{ transition: "fill 0.4s, opacity 0.2s" }} />
                <text x={n.x} y={n.y + (isCenter ? 7 : 5)} textAnchor="middle"
                  fontSize={isCenter ? 18 : (n.type === "lambda" || n.type === "azurefunc") ? 11 : 10}
                  fontWeight={(n.type === "lambda" || n.type === "azurefunc") ? 700 : 400}
                  style={{ pointerEvents: "none" }}>
                  {icon}
                </text>
                {showLabel && (
                  <text x={n.x} y={n.y + n.radius + 12} textAnchor="middle"
                    fill={dimmed ? "rgba(255,255,255,0.08)" : cascHealthy ? "rgba(255,255,255,0.22)" : cascFailed ? RED : "rgba(255,255,255,0.82)"}
                    fontSize={isCenter ? 11 : n.ring <= 1 ? 9 : 8} fontWeight={isCenter || isHl ? 700 : 400}
                    style={{ transition: "fill 0.4s", pointerEvents: "none" }}>
                    {n.label.length > (isCenter ? 24 : 16) ? n.label.slice(0, isCenter ? 22 : 14) + "…" : n.label}
                  </text>
                )}
                {n.type === "host" && !n.isOverflow && ((n.serviceCount ?? 0) + (n.processCount ?? 0) + (n.containerCount ?? 0)) > 0 && (
                  <text x={n.x} y={n.y + n.radius + 22} textAnchor="middle"
                    fill={dimmed ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.35)"}
                    fontSize={7.5} style={{ pointerEvents: "none" }}>
                    {[(n.serviceCount ?? 0) > 0 ? `${n.serviceCount}s` : "", (n.processCount ?? 0) > 0 ? `${n.processCount}p` : "", (n.containerCount ?? 0) > 0 ? `${n.containerCount}c` : ""].filter(Boolean).join("·")}
                  </text>
                )}
              </g>
            );
          })}

          {/* Ring labels */}
          {!isIdle && R1 > 0 && <text x={cx + R1 * 0.71} y={cy - R1 * 0.71 - 8} fill="rgba(255,255,255,0.2)" fontSize={8} fontWeight={700} textAnchor="middle" style={{ pointerEvents: "none" }}>HOSTS{hasServerless ? " + SERVERLESS" : ""}</text>}
          {!isIdle && R2 > 0 && <text x={cx + R2 * 0.71} y={cy - R2 * 0.71 - 8} fill="rgba(255,255,255,0.2)" fontSize={8} fontWeight={700} textAnchor="middle" style={{ pointerEvents: "none" }}>SERVICES · PROCESSES · CONTAINERS</text>}
          {!isIdle && R3ctr > 0 && <text x={cx + R3ctr * 0.71} y={cy - R3ctr * 0.71 - 8} fill="rgba(255,255,255,0.2)" fontSize={8} fontWeight={700} textAnchor="middle" style={{ pointerEvents: "none" }}>CONTAINER PROCESSES</text>}
          {!isIdle && Rcasc > 0 && <text x={cx + Rcasc * 0.71} y={cy - Rcasc * 0.71 - 8} fill="rgba(255,255,255,0.2)" fontSize={8} fontWeight={700} textAnchor="middle" style={{ pointerEvents: "none" }}>CASCADE</text>}
        </svg>
      </div>

      {/* Tooltip */}
      {tooltip && !tooltip.node.isOverflow && (() => {
        const n = tooltip.node;
        const ttW = 280;
        const left = Math.max(8, Math.min(tooltip.x + 14 + tooltipOffset.dx, window.innerWidth - ttW - 8));
        const top = Math.max(8, Math.min(tooltip.y - 16 + tooltipOffset.dy, window.innerHeight - 320));
        const svcInfo = (n.type === "service" || n.type === "cascade") ? serviceDetails?.get(n.label) : undefined;
        const hostId = n.type === "host" ? hostIdMap?.get(n.label) : undefined;
        return createPortal(
          <div style={{ position: "fixed", left, top, background: "#1c2033", border: "1px solid rgba(99,130,191,0.3)", borderRadius: 12, fontSize: 13, color: "#fff", zIndex: 10001, minWidth: 240, maxWidth: ttW, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", pointerEvents: pinned ? "auto" : "none" }}>
            <div onMouseDown={pinned ? handleTooltipMouseDown : undefined}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 8px", borderBottom: "1px solid rgba(99,130,191,0.15)", cursor: pinned ? "grab" : "default", userSelect: "none" }}>
              <span style={{ fontSize: 14 }}>{n.type === "region" ? "🌍" : n.type === "host" ? "🖥️" : n.type === "process" || n.type === "ctrproc" ? "🔧" : n.type === "container" ? "📦" : n.type === "lambda" ? "λ" : n.type === "azurefunc" ? "ƒ" : "⚙️"}</span>
              <span style={{ fontWeight: 700, flex: 1, fontSize: 12, wordBreak: "break-all" }}>{n.label}</span>
              {pinned && <span onClick={() => { setPinned(null); setTooltip(null); }} style={{ cursor: "pointer", fontSize: 16, color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>×</span>}
            </div>
            <div style={{ padding: "10px 14px" }}>
              {n.type === "region" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Hosts</div><div style={{ fontSize: 18, fontWeight: 700, color: HOST_COLOR }}>{hosts.length}</div></div>
                  <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Services</div><div style={{ fontSize: 18, fontWeight: 700, color: RED }}>{allSvcs.length}</div></div>
                  <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Processes</div><div style={{ fontSize: 18, fontWeight: 700, color: PROCESS_COLOR }}>{allProcs.length}</div></div>
                  <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Containers</div><div style={{ fontSize: 18, fontWeight: 700, color: CONTAINER_COLOR }}>{allCtrs.length}</div></div>
                  <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Lambda</div><div style={{ fontSize: 18, fontWeight: 700, color: LAMBDA_COLOR }}>{lambdas.length}</div></div>
                  <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Azure Fn</div><div style={{ fontSize: 18, fontWeight: 700, color: AZURE_FUNC_COLOR }}>{azureFunctions.length}</div></div>
                  <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Cascade</div><div style={{ fontSize: 18, fontWeight: 700, color: ORANGE }}>{affectedExternalServices.length}</div></div>
                  {ring3Count > 0 && <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Ctr Procs</div><div style={{ fontSize: 18, fontWeight: 700, color: PROCESS_COLOR }}>{ring3Count}</div></div>}
                </div>
              )}
              {n.type === "host" && (
                <>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 6 }}>HOST — all dependents will fail</div>
                  {(n.serviceCount ?? 0) > 0 && <div style={{ marginBottom: 5 }}><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", marginBottom: 2 }}>Services ({n.serviceCount})</div>{(n.services ?? []).slice(0, 5).map(s => <div key={s} style={{ fontSize: 11, color: "rgba(255,80,80,0.9)", padding: "1px 0" }}>• {s}</div>)}{(n.serviceCount ?? 0) > 5 && <div style={{ fontSize: 11, opacity: 0.4 }}>+{(n.serviceCount ?? 0) - 5} more</div>}</div>}
                  {(n.processCount ?? 0) > 0 && <div style={{ marginBottom: 5 }}><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", marginBottom: 2 }}>Processes ({n.processCount})</div>{(n.processes ?? []).slice(0, 4).map(p => <div key={p} style={{ fontSize: 11, color: "rgba(255,140,0,0.9)", padding: "1px 0" }}>• {p}</div>)}{(n.processCount ?? 0) > 4 && <div style={{ fontSize: 11, opacity: 0.4 }}>+{(n.processCount ?? 0) - 4} more</div>}</div>}
                  {(n.containerCount ?? 0) > 0 && <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", marginBottom: 2 }}>Containers ({n.containerCount})</div>{(n.containers ?? []).slice(0, 4).map(c => <div key={c} style={{ fontSize: 11, color: CONTAINER_COLOR, padding: "1px 0" }}>• {c}</div>)}{(n.containerCount ?? 0) > 4 && <div style={{ fontSize: 11, opacity: 0.4 }}>+{(n.containerCount ?? 0) - 4} more</div>}</div>}
                  {(n.serviceCount ?? 0) === 0 && (n.processCount ?? 0) === 0 && (n.containerCount ?? 0) === 0 && <div style={{ fontSize: 11, opacity: 0.4 }}>No monitored dependents</div>}
                  {hostId && <a href={`${envUrl}/ui/apps/dynatrace.infraops/explorer/Hosts?detailsId=${encodeURIComponent(hostId)}&${tfParam(tfFrom, tfTo)}`} target="_blank" rel="noopener noreferrer" style={{ display: "block", marginTop: 10, padding: "5px 10px", background: "rgba(69,137,255,0.1)", borderRadius: 6, color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>🔗 Host Details ›</a>}
                </>
              )}
              {n.type === "process" && <div style={{ fontSize: 11, opacity: 0.55 }}>Process Group Instance — terminates when its host fails.</div>}
              {n.type === "ctrproc" && <div style={{ fontSize: 11, color: CONTAINER_COLOR }}>Process inside container — fails when container is destroyed.</div>}
              {n.type === "container" && (
                <>
                  <div style={{ fontSize: 11, color: CONTAINER_COLOR, marginBottom: 6 }}>Container — destroyed when its host fails.</div>
                  {(() => {
                    const ctrProcs = ctrProcData.get(n.label);
                    if (!ctrProcs?.length) return <div style={{ fontSize: 11, opacity: 0.4 }}>No monitored processes inside</div>;
                    return (<div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase", marginBottom: 2 }}>Processes inside ({ctrProcs.length})</div>{ctrProcs.slice(0, 5).map(p => <div key={p} style={{ fontSize: 11, color: PROCESS_COLOR, padding: "1px 0" }}>• {p}</div>)}{ctrProcs.length > 5 && <div style={{ fontSize: 11, opacity: 0.4 }}>+{ctrProcs.length - 5} more</div>}</div>);
                  })()}
                </>
              )}
              {n.type === "lambda" && <div style={{ fontSize: 11, color: LAMBDA_COLOR }}>AWS Lambda — serverless, scoped to this region.</div>}
              {n.type === "azurefunc" && <div style={{ fontSize: 11, color: AZURE_FUNC_COLOR }}>Azure Function App — serverless, scoped to this Azure region.</div>}
              {(n.type === "service" || n.type === "cascade") && (
                <>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 6 }}>{n.type === "service" ? "SERVICE — directly down" : "CASCADE — caller impacted"}</div>
                  {svcInfo ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Requests</div><div style={{ fontSize: 17, fontWeight: 700 }}>{formatCount(svcInfo.requests)}</div></div>
                      <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>Error Rate</div><div style={{ fontSize: 17, fontWeight: 700, color: svcInfo.failureRate >= 2 ? RED : "inherit" }}>{svcInfo.failureRate.toFixed(2)}%</div></div>
                      <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>P50</div><div style={{ fontSize: 17, fontWeight: 700 }}>{formatMs(svcInfo.latencyP50)}</div></div>
                      <div><div style={{ fontSize: 10, opacity: 0.45, textTransform: "uppercase" }}>P90</div><div style={{ fontSize: 17, fontWeight: 700 }}>{formatMs(svcInfo.latencyP90)}</div></div>
                    </div>
                  ) : <div style={{ fontSize: 11, opacity: 0.45 }}>No metric data</div>}
                  {svcInfo?.entityId && <a href={`${envUrl}/ui/apps/dynatrace.services/explorer/services?detailsId=${svcInfo.entityId}&${tfParam(tfFrom, tfTo)}`} target="_blank" rel="noopener noreferrer" style={{ display: "block", marginTop: 10, padding: "5px 10px", background: "rgba(69,137,255,0.1)", borderRadius: 6, color: "#fff", fontWeight: 600, textDecoration: "none", fontSize: 12 }}>🔗 Service Details ›</a>}
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
