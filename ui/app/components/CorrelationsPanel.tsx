import React, { useMemo, useState } from "react";
import { Heading, Text, Strong } from "@dynatrace/strato-components/typography";
import { Flex } from "@dynatrace/strato-components/layouts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface MetricEntry {
  label: string;
  sparkline: number[];
  color?: string;
  /** When true, lower values are "better" (e.g. Error Rate, Latency) */
  inverted?: boolean;
}

export interface CorrelationResult {
  label: string;
  color?: string;
  /** Pearson correlation coefficient (-1 to +1) */
  r: number;
  /** Absolute correlation strength (0 to 1) */
  strength: number;
  /** Human-readable direction description */
  direction: string;
  /** Influence narrative for the user */
  narrative: string;
  /** Mini sparkline data of the correlated metric */
  sparkline: number[];
}

// ---------------------------------------------------------------------------
// Pearson Correlation Coefficient
// ---------------------------------------------------------------------------
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const xs = x.slice(0, n);
  const ys = y.slice(0, n);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return 0;
  return num / den;
}

// ---------------------------------------------------------------------------
// Compute correlations for a target metric vs all other registered metrics
// ---------------------------------------------------------------------------
export function computeCorrelations(
  target: MetricEntry,
  allMetrics: MetricEntry[],
  minStrength = 0.3
): CorrelationResult[] {
  const results: CorrelationResult[] = [];
  if (!target.sparkline || target.sparkline.length < 3) return results;

  for (const metric of allMetrics) {
    if (metric.label === target.label) continue;
    if (!metric.sparkline || metric.sparkline.length < 3) continue;

    const r = pearsonCorrelation(target.sparkline, metric.sparkline);
    const strength = Math.abs(r);
    if (strength < minStrength) continue;

    const positive = r > 0;
    let direction: string;
    if (positive) {
      direction = `As ${metric.label} increases, ${target.label} also increases`;
    } else {
      direction = `As ${metric.label} increases, ${target.label} decreases`;
    }

    let narrative: string;
    const strengthLabel = strength >= 0.8 ? "very strong" : strength >= 0.6 ? "strong" : strength >= 0.4 ? "moderate" : "weak";
    if (target.inverted) {
      if (positive) {
        narrative = `${metric.label} shows a ${strengthLabel} positive correlation (r=${r.toFixed(2)}) — when ${metric.label} rises, ${target.label} tends to worsen.`;
      } else {
        narrative = `${metric.label} shows a ${strengthLabel} inverse correlation (r=${r.toFixed(2)}) — higher ${metric.label} is associated with improved ${target.label}.`;
      }
    } else {
      if (positive) {
        narrative = `${metric.label} shows a ${strengthLabel} positive correlation (r=${r.toFixed(2)}) — they tend to move together.`;
      } else {
        narrative = `${metric.label} shows a ${strengthLabel} inverse correlation (r=${r.toFixed(2)}) — when ${metric.label} rises, ${target.label} tends to drop.`;
      }
    }

    results.push({ label: metric.label, color: metric.color, r, strength, direction, narrative, sparkline: metric.sparkline });
  }

  results.sort((a, b) => b.strength - a.strength);
  return results;
}

// ---------------------------------------------------------------------------
// Context — allows any card to register metrics for cross-correlation
// ---------------------------------------------------------------------------
export type MetricsRegistry = MetricEntry[];
export type CorrelationOpener = (target: MetricEntry) => void;
export const CorrelationsContext = React.createContext<{
  registry: MetricsRegistry;
  register: (metrics: MetricEntry[]) => void;
  open: CorrelationOpener;
} | null>(null);

// ---------------------------------------------------------------------------
// Mini Sparkline (for the panel rows)
// ---------------------------------------------------------------------------
function MiniSparkline({ data, color = "#4589FF" }: { data: number[]; color?: string }) {
  const W = 72, H = 22;
  const valid = data.filter(v => v != null && !isNaN(v) && isFinite(v));
  if (valid.length < 2) return null;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  const points = valid.map((v, i) => ({
    x: (i / (valid.length - 1)) * W,
    y: H - ((v - min) / range) * (H - 3) - 1.5,
  }));
  const pts = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} style={{ display: "block", opacity: 0.8 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={2} fill={color} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Strength Bar
// ---------------------------------------------------------------------------
function StrengthBar({ value, positive }: { value: number; positive: boolean }) {
  const GREEN = "#0D9C29";
  const RED = "#C21930";
  const color = positive ? GREEN : RED;
  const pct = Math.round(value * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 100 }}>
      <div style={{ flex: 1, height: 5, background: "rgba(128,128,128,0.15)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.3s" }} />
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, color, minWidth: 28, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Correlations Panel (full-screen overlay)
// ---------------------------------------------------------------------------
export function CorrelationsPanel({ target, allMetrics, onClose }: {
  target: MetricEntry;
  allMetrics: MetricEntry[];
  onClose: () => void;
}) {
  const [minStrength, setMinStrength] = useState(0.3);
  const correlations = useMemo(() => computeCorrelations(target, allMetrics, minStrength), [target, allMetrics, minStrength]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 10000,
        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "rgba(20,24,46,0.97)", border: "1px solid rgba(128,128,128,0.25)",
          borderRadius: 16, padding: "28px 32px", maxWidth: 680, width: "90%",
          maxHeight: "85vh", overflowY: "auto",
          boxShadow: "0 16px 64px rgba(0,0,0,0.5)",
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 16 }}>
          <div>
            <Heading level={4} style={{ margin: 0 }}>Related Metrics</Heading>
            <Text style={{ fontSize: 12, opacity: 0.6 }}>
              Metrics correlated with <Strong style={{ color: target.color ?? "#4589FF" }}>{target.label}</Strong> based on time-series similarity
            </Text>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "rgba(128,128,128,0.15)", border: "1px solid rgba(128,128,128,0.25)",
              borderRadius: 8, padding: "6px 14px", color: "inherit", cursor: "pointer", fontSize: 13,
            }}
          >
            Close
          </button>
        </Flex>

        {/* Strength filter */}
        <Flex alignItems="center" gap={12} style={{ marginBottom: 16 }}>
          <Text style={{ fontSize: 11, opacity: 0.5 }}>Min correlation strength:</Text>
          {[0.3, 0.5, 0.7].map(v => (
            <button
              key={v}
              onClick={() => setMinStrength(v)}
              style={{
                background: minStrength === v ? "rgba(69,137,255,0.2)" : "rgba(128,128,128,0.08)",
                border: `1px solid ${minStrength === v ? "rgba(69,137,255,0.5)" : "rgba(128,128,128,0.2)"}`,
                borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "pointer", color: "inherit",
              }}
            >
              {v * 100}%+
            </button>
          ))}
        </Flex>

        {/* Results */}
        {correlations.length === 0 ? (
          <div style={{ padding: "32px 0", textAlign: "center" }}>
            <Text style={{ opacity: 0.5 }}>No metrics found with correlation strength above {minStrength * 100}%</Text>
            <br />
            <Text style={{ fontSize: 12, opacity: 0.4 }}>Try lowering the threshold or ensuring more metrics have sparkline data in the current timeframe.</Text>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {correlations.map((c, idx) => (
              <div
                key={c.label}
                style={{
                  background: "rgba(128,128,128,0.05)", border: "1px solid rgba(128,128,128,0.15)",
                  borderRadius: 10, padding: "12px 16px",
                  borderLeft: `3px solid ${c.r > 0 ? "rgba(13,156,41,0.6)" : "rgba(194,25,48,0.6)"}`,
                }}
              >
                <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 6 }}>
                  <Flex alignItems="center" gap={8}>
                    <span style={{ fontSize: 11, opacity: 0.35, fontWeight: 600 }}>#{idx + 1}</span>
                    <Strong style={{ fontSize: 13, color: c.color ?? "#4589FF" }}>{c.label}</Strong>
                    <span style={{
                      fontSize: 10, padding: "1px 6px", borderRadius: 4,
                      background: c.r > 0 ? "rgba(13,156,41,0.12)" : "rgba(194,25,48,0.12)",
                      color: c.r > 0 ? "#0D9C29" : "#C21930",
                      border: `1px solid ${c.r > 0 ? "rgba(13,156,41,0.3)" : "rgba(194,25,48,0.3)"}`,
                    }}>
                      r = {c.r > 0 ? "+" : ""}{c.r.toFixed(2)}
                    </span>
                  </Flex>
                  <MiniSparkline data={c.sparkline} color={c.color ?? "#4589FF"} />
                </Flex>
                <StrengthBar value={c.strength} positive={c.r > 0} />
                <Text style={{ fontSize: 11, opacity: 0.6, marginTop: 6, display: "block" }}>{c.direction}</Text>
                <Text style={{ fontSize: 11, opacity: 0.5, marginTop: 2, display: "block", fontStyle: "italic" }}>{c.narrative}</Text>
              </div>
            ))}
          </div>
        )}

        {/* Legend */}
        <div style={{ marginTop: 20, padding: "10px 14px", background: "rgba(128,128,128,0.04)", borderRadius: 8, border: "1px solid rgba(128,128,128,0.1)" }}>
          <Text style={{ fontSize: 10, opacity: 0.4, display: "block", marginBottom: 4 }}>How it works</Text>
          <Text style={{ fontSize: 11, opacity: 0.5, display: "block" }}>
            Pearson correlation coefficient (r) measures linear relationship between two time-series sparklines.
            Values near +1 indicate strong positive co-movement; values near -1 indicate strong inverse movement.
            A green bar means the metrics move together; a red bar means they move in opposite directions.
            Relationships with |r| below the threshold are filtered out.
          </Text>
        </div>
      </div>
    </div>
  );
}
