import React from "react";
import { createPortal } from "react-dom";

// ─── Types & Constants ────────────────────────────────────────────────────────

export interface KpiHeatmapPanelProps {
  label: string;
  color?: string;
  /** Initial hourly Z-score buckets (newest last). If empty, fetched via getRequeryData. */
  scores?: number[];
  pos: { x: number; y: number };
  onDragStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  onClose: () => void;
  getRequeryData: (days: number) => Promise<number[]>;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS  = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtHour = (h: number) =>
  h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;

type LevelKey = "nodata" | "baseline" | "low" | "warm" | "hot" | "spike";

const LEVELS: { key: LevelKey; label: string; color: string; tip: string }[] = [
  { key: "nodata",   label: "No Data",  color: "rgba(255,255,255,0.07)", tip: "No recorded data for this hour × day slot" },
  { key: "baseline", label: "Baseline", color: "rgba(69,137,255,0.18)",  tip: "Normal — at or near average (< 0.1\\u03C3)" },
  { key: "low",      label: "Low",      color: "rgba(69,137,255,0.55)",  tip: "Slightly elevated (0.1–0.75\\u03C3)" },
  { key: "warm",     label: "Warm",     color: "#FFF04D",                tip: "Moderately elevated (0.75–1.5\\u03C3)" },
  { key: "hot",      label: "Hot",      color: "#FF3D9A",                tip: "Significantly elevated (1.5–2.5\\u03C3)" },
  { key: "spike",    label: "Spike",    color: "#FF073A",                tip: "Critical spike (> 2.5\\u03C3)" },
];

function getLevel(val: number | null): LevelKey {
  if (val === null) return "nodata";
  if (val >= 2.5)   return "spike";
  if (val >= 1.5)   return "hot";
  if (val >= 0.75)  return "warm";
  if (val >= 0.1)   return "low";
  return "baseline";
}

function levelColor(key: LevelKey): string {
  return LEVELS.find(l => l.key === key)!.color;
}

// ─── Grid Builder ─────────────────────────────────────────────────────────────

function buildGrid(scores: number[], bucketMs: number): (number | null)[][] {
  const sums = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const cnts = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const startMs = Date.now() - scores.length * bucketMs;
  scores.forEach((z, i) => {
    const d = new Date(startMs + i * bucketMs);
    sums[d.getDay()][d.getHours()] += z;
    cnts[d.getDay()][d.getHours()]++;
  });
  return Array.from({ length: 7 }, (_, dow) =>
    HOURS.map(h => cnts[dow][h] > 0 ? sums[dow][h] / cnts[dow][h] : null)
  );
}

// ─── Analysis Engine ──────────────────────────────────────────────────────────

interface HeatAnalysis {
  hotZoneText: string;
  worstDayText: string;
  worstHourText: string;
  worstHourIdx: number;
  worstDayIdx: number;
  hotHours: number[];
  hotCellCount: number;
  spikeCellCount: number;
  insights: string[];
  recommendations: string[];
}

function analyzeGrid(grid: (number | null)[][], label: string): HeatAnalysis {
  const hourAvg = HOURS.map(h => {
    const vals = DAYS.map((_, d) => grid[d][h]).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  });
  const dayAvg = DAYS.map((_, d) => {
    const vals = HOURS.map(h => grid[d][h]).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  });

  const worstHourIdx = hourAvg.indexOf(Math.max(...hourAvg));
  const worstDayIdx  = dayAvg.indexOf(Math.max(...dayAvg));
  const hotHours     = HOURS.filter(h => hourAvg[h] >= 0.75);

  let hotZoneText = "No significant hot zone detected";
  if (hotHours.length > 0) {
    const ranges: number[][] = [];
    let cur = [hotHours[0]];
    for (let i = 1; i < hotHours.length; i++) {
      if (hotHours[i] === hotHours[i - 1] + 1) cur.push(hotHours[i]);
      else { ranges.push(cur); cur = [hotHours[i]]; }
    }
    ranges.push(cur);
    const longest = ranges.reduce((a, b) => b.length > a.length ? b : a);
    hotZoneText = longest.length === 1
      ? `${fmtHour(longest[0])} daily`
      : `${fmtHour(longest[0])}–${fmtHour(longest[longest.length - 1] + 1)} daily`;
  }

  const hotCellCount   = DAYS.flatMap((_, d) => HOURS.map(h => grid[d][h])).filter(v => v !== null && (v as number) >= 1.5).length;
  const spikeCellCount = DAYS.flatMap((_, d) => HOURS.map(h => grid[d][h])).filter(v => v !== null && (v as number) >= 2.5).length;
  const weekdayMean    = [1, 2, 3, 4, 5].reduce((a, d) => a + dayAvg[d], 0) / 5;
  const weekendMean    = [0, 6].reduce((a, d) => a + dayAvg[d], 0) / 2;

  const insights: string[] = [];
  const recs: string[] = [];
  const peakAvg = hourAvg[worstHourIdx];

  if (peakAvg >= 2.5)      insights.push(`Critical ${label} spike at ${fmtHour(worstHourIdx)} — avg Z-score ${peakAvg.toFixed(1)}\\u03C3.`);
  else if (peakAvg >= 1.5) insights.push(`${label} consistently stressed at ${fmtHour(worstHourIdx)} — avg ${peakAvg.toFixed(1)}\\u03C3.`);
  else if (peakAvg >= 0.75) insights.push(`Elevated ${label} at ${fmtHour(worstHourIdx)} — mildly stressed.`);
  else                     insights.push(`${label} is broadly consistent throughout the day.`);

  const safeWeekend = Math.max(weekendMean, 0.01);
  const safeWeekday = Math.max(weekdayMean, 0.01);
  if (weekdayMean > 0.1 && weekdayMean > weekendMean * 1.5) {
    insights.push(`${((weekdayMean / safeWeekend - 1) * 100).toFixed(0)}% higher on weekdays — typical business-hours pattern.`);
    recs.push(`Scale before weekday peak hours. Pre-warm resources 7–9am Mon–Fri.`);
  } else if (weekendMean > 0.1 && weekendMean > weekdayMean * 1.5) {
    insights.push(`${((weekendMean / safeWeekday - 1) * 100).toFixed(0)}% higher on weekends — batch or consumer workload pattern.`);
    recs.push("Review weekend-specific workloads. Check for batch jobs elevating this metric Sat–Sun.");
  } else {
    insights.push(`Consistent across weekdays and weekends (weekday avg ${weekdayMean.toFixed(2)}\\u03C3, weekend ${weekendMean.toFixed(2)}\\u03C3).`);
  }

  if (spikeCellCount > 0) {
    insights.push(`${spikeCellCount} critical spike cell${spikeCellCount > 1 ? "s" : ""} — check deployments or infra events.`);
    recs.push(`Investigate ${spikeCellCount} spike window${spikeCellCount > 1 ? "s" : ""} around ${fmtHour(worstHourIdx)} on ${DAYS[worstDayIdx]}.`);
  }
  if (hotHours.length > 0) {
    recs.push(`Hot window: ${fmtHour(hotHours[0])}–${fmtHour(hotHours[hotHours.length - 1] + 1)} — scale up before this window.`);
  }
  if (recs.length === 0) recs.push(`No significant action needed — ${label} looks healthy.`);

  return {
    hotZoneText,
    worstDayText:  `${DAYS[worstDayIdx]} (avg ${dayAvg[worstDayIdx].toFixed(2)}\\u03C3)`,
    worstHourText: `${fmtHour(worstHourIdx)} (avg ${hourAvg[worstHourIdx].toFixed(2)}\\u03C3)`,
    worstHourIdx, worstDayIdx, hotHours,
    hotCellCount, spikeCellCount, insights, recommendations: recs,
  };
}

// ─── PDF Export ───────────────────────────────────────────────────────────────

function exportKpiHeatmapPdf(grid: (number | null)[][], analysis: HeatAnalysis, label: string) {
  const ts = new Date().toLocaleString();
  const cellTd = (val: number | null) => {
    const col = levelColor(getLevel(val));
    return `<td style="width:44px;height:17px;background:${col};border-radius:3px;border:1px solid rgba(255,255,255,0.04)"></td>`;
  };
  const legend = LEVELS.map(l =>
    `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${l.color};border:1px solid rgba(255,255,255,0.12)"></span><span style="font-size:10px;opacity:0.65">${l.label}</span></span>`
  ).join("");
  const insHtml = analysis.insights.map(s => `<div style="margin-bottom:5px;padding:7px 11px;background:rgba(128,128,128,0.07);border-radius:6px;font-size:12px;line-height:1.5">💡 ${s}</div>`).join("");
  const recHtml = analysis.recommendations.map(s => `<div style="margin-bottom:5px;padding:7px 11px;background:rgba(69,137,255,0.07);border:1px solid rgba(69,137,255,0.15);border-radius:6px;font-size:12px;line-height:1.5">→ ${s}</div>`).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${label} Heatmap — Services Overview</title>
<style>
  @media print{body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}@page{margin:.6in;size:A4}.pb{page-break-before:always}}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1223;color:#e8eaf0;margin:0;padding:24px}
  h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 10px}
  table{border-collapse:separate;border-spacing:2px}
</style></head><body>
<h1>📅 ${label} Heatmap — Services Overview</h1>
<div style="font-size:11px;opacity:0.4;margin-bottom:18px">Generated ${ts} · 7-day view (Sun–Sat, 12am–11pm)</div>
<table>
  <tr><td style="width:34px"></td>${DAYS.map(d => `<td style="text-align:center;font-size:10px;font-weight:700;padding-bottom:4px;opacity:0.55">${d}</td>`).join("")}</tr>
  ${HOURS.map(h => `<tr><td style="width:34px;text-align:right;padding-right:5px;font-size:9px;opacity:0.45;white-space:nowrap">${fmtHour(h)}</td>${DAYS.map((_, d) => cellTd(grid[d][h])).join("")}</tr>`).join("")}
</table>
<div style="margin:14px 0 24px">${legend}</div>
<div class="pb"></div>
<h2>Analysis</h2>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:18px">
  <div style="background:rgba(255,7,58,0.08);border:1px solid rgba(255,7,58,0.25);border-radius:8px;padding:10px 13px">
    <div style="font-size:9px;opacity:0.5;text-transform:uppercase;margin-bottom:3px">Hot Zone</div>
    <div style="font-size:13px;font-weight:700;color:#FF3D9A">${analysis.hotZoneText}</div>
  </div>
  <div style="background:rgba(255,131,43,0.08);border:1px solid rgba(255,131,43,0.25);border-radius:8px;padding:10px 13px">
    <div style="font-size:9px;opacity:0.5;text-transform:uppercase;margin-bottom:3px">Worst Hour</div>
    <div style="font-size:13px;font-weight:700;color:#FF832B">${analysis.worstHourText}</div>
  </div>
  <div style="background:rgba(255,240,77,0.08);border:1px solid rgba(255,240,77,0.25);border-radius:8px;padding:10px 13px">
    <div style="font-size:9px;opacity:0.5;text-transform:uppercase;margin-bottom:3px">Worst Day</div>
    <div style="font-size:13px;font-weight:700;color:#FFF04D">${analysis.worstDayText}</div>
  </div>
</div>
<h2>Insights</h2>${insHtml}
<h2>Recommendations</h2>${recHtml}
<div style="margin-top:28px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.07);font-size:10px;opacity:0.3">${label} Heatmap · Services Overview</div>
</body></html>`;

  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

// ─── Component ────────────────────────────────────────────────────────────────

type HighlightMode = "hotzone" | "worstHour" | "worstDay" | null;

export function KpiHeatmapPanel({ label, color = "#4589FF", scores: initScores, pos, onDragStart, onClose, getRequeryData }: KpiHeatmapPanelProps) {
  const [scores, setScores]             = React.useState<number[]>(initScores ?? []);
  const [loading, setLoading]           = React.useState(true);
  const [hover, setHover]               = React.useState<{ day: number; hour: number; value: number | null } | null>(null);
  const [filterLevel, setFilterLevel]   = React.useState<LevelKey | null>(null);
  const [showAnalysis, setShowAnalysis] = React.useState(false);
  const [highlightMode, setHighlightMode] = React.useState<HighlightMode>(null);
  const [panelH, setPanelH]             = React.useState(520);
  const resizeRef = React.useRef<{ startY: number; startH: number } | null>(null);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    getRequeryData(7)
      .then(data => { if (active && data.length > 0) setScores(data); })
      .catch(() => undefined)
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const dy = e.clientY - resizeRef.current.startY;
      setPanelH(Math.max(350, resizeRef.current.startH + dy));
    };
    const onUp = () => { resizeRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const grid     = React.useMemo(() => buildGrid(scores, 3_600_000), [scores]);
  const analysis = React.useMemo(() => showAnalysis || highlightMode ? analyzeGrid(grid, label) : null, [grid, showAnalysis, highlightMode, label]);

  const toggleFilter = (key: LevelKey) => setFilterLevel(prev => prev === key ? null : key);

  // Derived highlight sets from mode
  const highlightedHours = React.useMemo<Set<number>>(() => {
    if (!analysis) return new Set();
    if (highlightMode === "hotzone") return new Set(analysis.hotHours);
    if (highlightMode === "worstHour") return new Set([analysis.worstHourIdx]);
    return new Set();
  }, [highlightMode, analysis]);

  const highlightedDays = React.useMemo<Set<number>>(() => {
    if (!analysis || highlightMode !== "worstDay") return new Set();
    return new Set([analysis.worstDayIdx]);
  }, [highlightMode, analysis]);

  const isCellHighlighted = (day: number, hour: number): boolean => {
    if (!highlightMode) return true;
    if (highlightMode === "worstDay") return highlightedDays.has(day);
    return highlightedHours.has(hour);
  };

  const cellOpacity = (key: LevelKey, day: number, hour: number) => {
    const highlighted = isCellHighlighted(day, hour);
    if (!highlighted) return 0.07;
    return filterLevel ? (key === filterLevel ? 1 : 0.1) : 1;
  };

  const cellBorder = (day: number, hour: number) => {
    const isHov = hover?.day === day && hover.hour === hour;
    if (isHov) return "1px solid rgba(255,255,255,0.5)";
    if (highlightMode && isCellHighlighted(day, hour)) return "1px solid rgba(255,255,255,0.2)";
    return "1px solid transparent";
  };

  const CELL_W = 28, CELL_H = 14, GAP = 2, LEFT_PAD = 42;
  const panelW = LEFT_PAD + 7 * (CELL_W + GAP) + 48;

  const handleCardClick = (mode: HighlightMode) => {
    setHighlightMode(prev => prev === mode ? null : mode);
    if (!showAnalysis) setShowAnalysis(true);
  };

  return createPortal(
    <div className="svc-ha-panel" style={{ left: pos.x, top: pos.y, width: panelW, height: panelH, zIndex: 603, fontFamily: "'Segoe UI',system-ui,sans-serif" }}>
      {/* Header */}
      <div className="svc-ha-panel-header" onMouseDown={onDragStart} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 15 }}>📅</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>
            <span style={{ color, marginRight: 4 }}>●</span>{label} Heatmap
          </div>
          <div style={{ fontSize: 10, opacity: 0.45, marginTop: 1 }}>
            {loading ? "Loading 7-day window…" : "Hour-of-day × Day-of-week · 7-day view"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <button
            onClick={() => exportKpiHeatmapPdf(grid, analysis ?? analyzeGrid(grid, label), label)}
            style={{ fontSize: 10, padding: "3px 9px", background: "rgba(69,137,255,0.1)", border: "1px solid rgba(69,137,255,0.3)", borderRadius: 5, color: "#4589FF", cursor: "pointer", fontWeight: 600 }}
            title="Export as PDF"
          >PDF</button>
          <button
            onClick={() => setShowAnalysis(p => !p)}
            style={{ fontSize: 10, padding: "3px 9px", background: showAnalysis ? "rgba(255,61,154,0.15)" : "rgba(128,128,128,0.08)", border: `1px solid ${showAnalysis ? "rgba(255,61,154,0.4)" : "rgba(128,128,128,0.2)"}`, borderRadius: 5, color: showAnalysis ? "#FF3D9A" : "inherit", cursor: "pointer", fontWeight: 600 }}
          >{showAnalysis ? "▲ Analyze" : "▼ Analyze"}</button>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "inherit", fontSize: 16, cursor: "pointer", opacity: 0.45, padding: "2px 6px" }}>✕</button>
        </div>
      </div>

      <div className="svc-ha-panel-body" style={{ padding: "13px 14px 12px", overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 28, textAlign: "center", fontSize: 13, opacity: 0.55 }}>Loading 7 days of data…</div>
        ) : (
          <>
            {/* Day headers */}
            <div style={{ display: "flex", marginLeft: LEFT_PAD, marginBottom: 4, gap: GAP }}>
              {DAYS.map((d, di) => (
                <div key={d} style={{ width: CELL_W, textAlign: "center", fontSize: 9, fontWeight: 700, opacity: highlightedDays.size > 0 && !highlightedDays.has(di) ? 0.2 : 0.45 }}>{d}</div>
              ))}
            </div>

            {/* Grid */}
            {HOURS.map(h => (
              <div key={h} style={{ display: "flex", alignItems: "center", marginBottom: GAP, gap: GAP }}>
                <div style={{ width: LEFT_PAD - GAP, textAlign: "right", paddingRight: 6, fontSize: 9, opacity: highlightedHours.size > 0 && !highlightedHours.has(h) ? 0.15 : 0.35, flexShrink: 0 }}>{fmtHour(h)}</div>
                {DAYS.map((_, day) => {
                  const value = grid[day][h];
                  const key = getLevel(value);
                  return (
                    <div
                      key={day}
                      style={{
                        width: CELL_W, height: CELL_H, borderRadius: 3,
                        background: levelColor(key),
                        opacity: cellOpacity(key, day, h),
                        border: cellBorder(day, h),
                        boxSizing: "border-box" as const,
                        transition: "opacity 0.15s ease",
                      }}
                      onMouseEnter={() => setHover({ day, hour: h, value })}
                      onMouseLeave={() => setHover(null)}
                    />
                  );
                })}
              </div>
            ))}

            {/* Hover tooltip */}
            <div style={{ minHeight: 22, marginTop: 5, fontSize: 11, opacity: 0.6, textAlign: "center" }}>
              {hover
                ? `${DAYS[hover.day]} ${fmtHour(hover.hour)} · ${hover.value === null ? "no data" : `avg Z ${hover.value.toFixed(2)}\\u03C3`}`
                : highlightMode
                  ? `Highlighted: ${highlightMode === "hotzone" ? "Hot Zone hours" : highlightMode === "worstHour" ? "Worst Hour row" : "Worst Day column"} — click card to clear`
                  : "Hover a cell to inspect · click insight cards to highlight sections"}
            </div>

            {/* Legend */}
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center", marginTop: 6, paddingTop: 8, borderTop: "1px solid rgba(128,128,128,0.15)" }}>
              {LEVELS.map(({ key, label: lbl, color: lcol, tip }) => (
                <div key={key} onClick={() => toggleFilter(key)} title={tip} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", padding: "3px 7px", borderRadius: 5, background: filterLevel === key ? "rgba(255,255,255,0.09)" : "transparent", border: filterLevel === key ? "1px solid rgba(255,255,255,0.18)" : "1px solid transparent", transition: "all 0.12s ease" }}>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: lcol, border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0 }} />
                  <span style={{ fontSize: 9, opacity: filterLevel && filterLevel !== key ? 0.35 : 0.75, fontWeight: filterLevel === key ? 700 : 400 }}>{lbl}</span>
                </div>
              ))}
              {filterLevel && <div onClick={() => setFilterLevel(null)} style={{ fontSize: 9, opacity: 0.45, cursor: "pointer", alignSelf: "center", padding: "3px 6px", borderRadius: 4, background: "rgba(255,255,255,0.05)" }}>✕ Clear</div>}
            </div>

            {/* Analysis section */}
            {showAnalysis && analysis && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(128,128,128,0.15)" }}>
                {/* Clickable insight cards */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 12 }}>
                  {/* HOT ZONE */}
                  <div
                    onClick={() => handleCardClick("hotzone")}
                    title="Click to highlight Hot Zone hours in the heatmap"
                    style={{
                      background: highlightMode === "hotzone" ? "rgba(255,7,58,0.18)" : "rgba(255,7,58,0.07)",
                      border: `1px solid ${highlightMode === "hotzone" ? "rgba(255,7,58,0.6)" : "rgba(255,7,58,0.2)"}`,
                      borderRadius: 8, padding: "7px 10px", cursor: "pointer",
                      transform: highlightMode === "hotzone" ? "scale(1.03)" : "scale(1)",
                      transition: "all 0.15s ease",
                      boxShadow: highlightMode === "hotzone" ? "0 0 12px rgba(255,7,58,0.25)" : "none",
                    }}
                  >
                    <div style={{ fontSize: 9, opacity: 0.5, textTransform: "uppercase" as const, marginBottom: 2 }}>Hot Zone</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#FF3D9A" }}>{analysis.hotZoneText}</div>
                    {highlightMode === "hotzone" && <div style={{ fontSize: 8, color: "#FF3D9A", opacity: 0.6, marginTop: 3 }}>● highlighted</div>}
                  </div>
                  {/* WORST HOUR */}
                  <div
                    onClick={() => handleCardClick("worstHour")}
                    title="Click to highlight the Worst Hour row in the heatmap"
                    style={{
                      background: highlightMode === "worstHour" ? "rgba(255,131,43,0.18)" : "rgba(255,131,43,0.07)",
                      border: `1px solid ${highlightMode === "worstHour" ? "rgba(255,131,43,0.6)" : "rgba(255,131,43,0.2)"}`,
                      borderRadius: 8, padding: "7px 10px", cursor: "pointer",
                      transform: highlightMode === "worstHour" ? "scale(1.03)" : "scale(1)",
                      transition: "all 0.15s ease",
                      boxShadow: highlightMode === "worstHour" ? "0 0 12px rgba(255,131,43,0.25)" : "none",
                    }}
                  >
                    <div style={{ fontSize: 9, opacity: 0.5, textTransform: "uppercase" as const, marginBottom: 2 }}>Worst Hour</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#FF832B" }}>{analysis.worstHourText}</div>
                    {highlightMode === "worstHour" && <div style={{ fontSize: 8, color: "#FF832B", opacity: 0.6, marginTop: 3 }}>● highlighted</div>}
                  </div>
                  {/* WORST DAY */}
                  <div
                    onClick={() => handleCardClick("worstDay")}
                    title="Click to highlight the Worst Day column in the heatmap"
                    style={{
                      background: highlightMode === "worstDay" ? "rgba(255,240,77,0.18)" : "rgba(255,240,77,0.07)",
                      border: `1px solid ${highlightMode === "worstDay" ? "rgba(255,240,77,0.5)" : "rgba(255,240,77,0.2)"}`,
                      borderRadius: 8, padding: "7px 10px", cursor: "pointer",
                      transform: highlightMode === "worstDay" ? "scale(1.03)" : "scale(1)",
                      transition: "all 0.15s ease",
                      boxShadow: highlightMode === "worstDay" ? "0 0 12px rgba(255,240,77,0.2)" : "none",
                    }}
                  >
                    <div style={{ fontSize: 9, opacity: 0.5, textTransform: "uppercase" as const, marginBottom: 2 }}>Worst Day</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#FFF04D" }}>{analysis.worstDayText}</div>
                    {highlightMode === "worstDay" && <div style={{ fontSize: 8, color: "#FFF04D", opacity: 0.6, marginTop: 3 }}>● highlighted</div>}
                  </div>
                </div>

                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" as const, opacity: 0.4, marginBottom: 5 }}>Insights</div>
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, marginBottom: 10 }}>
                  {analysis.insights.map((ins, i) => <div key={i} style={{ fontSize: 11, padding: "5px 9px", background: "rgba(128,128,128,0.07)", borderRadius: 5, lineHeight: 1.5 }}>💡 {ins}</div>)}
                </div>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" as const, opacity: 0.4, marginBottom: 5 }}>Recommendations</div>
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                  {analysis.recommendations.map((rec, i) => <div key={i} style={{ fontSize: 11, padding: "5px 9px", background: "rgba(69,137,255,0.07)", borderRadius: 5, lineHeight: 1.5 }}>→ {rec}</div>)}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={e => { e.stopPropagation(); resizeRef.current = { startY: e.clientY, startH: panelH }; }}
        style={{ position: "absolute", bottom: 0, right: 0, width: 18, height: 18, cursor: "ns-resize", display: "flex", alignItems: "flex-end", justifyContent: "flex-end", padding: "3px", zIndex: 1 }}
      >
        <svg width="10" height="6" viewBox="0 0 10 6" style={{ opacity: 0.3 }}>
          <line x1="0" y1="2" x2="10" y2="2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
    </div>,
    document.body
  );
}
