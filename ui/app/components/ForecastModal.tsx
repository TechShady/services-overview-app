import React, { useMemo, useState } from "react";

// ─── Linear regression forecast ───
export function linearForecast(data: number[], forecastBuckets: number): number[] {
  const n = data.length;
  if (n < 2) return new Array(forecastBuckets).fill(data[0] ?? 0);
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += data[i];
    sumXY += i * data[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  const forecast: number[] = [];
  for (let i = 0; i < forecastBuckets; i++) {
    forecast.push(Math.max(0, intercept + slope * (n + i)));
  }
  return forecast;
}

// ─── Holt-Winters (double exponential smoothing) ───
export function holtWintersForecast(data: number[], forecastBuckets: number, alpha = 0.3, beta = 0.1): number[] {
  const n = data.length;
  if (n < 2) return new Array(forecastBuckets).fill(data[0] ?? 0);
  let level = data[0];
  let trend = data[1] - data[0];
  for (let i = 1; i < n; i++) {
    const prevLevel = level;
    level = alpha * data[i] + (1 - alpha) * (prevLevel + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  const forecast: number[] = [];
  for (let i = 1; i <= forecastBuckets; i++) {
    forecast.push(Math.max(0, level + i * trend));
  }
  return forecast;
}

// ─── Triple Exponential Smoothing (Holt-Winters Seasonal / Additive) ───
export function tripleExpSmoothingForecast(
  data: number[],
  forecastBuckets: number,
  seasonLength?: number,
  alpha = 0.3,
  beta = 0.1,
  gamma = 0.3,
): number[] {
  const n = data.length;
  if (n < 4) return holtWintersForecast(data, forecastBuckets, alpha, beta);

  // Auto-detect season length if not provided (try common periods)
  const m = seasonLength ?? detectSeasonLength(data);
  if (m < 2 || n < 2 * m) {
    // Not enough data for seasonal decomposition, fall back to double
    return holtWintersForecast(data, forecastBuckets, alpha, beta);
  }

  // Initialize level, trend, seasonal
  let level = data.slice(0, m).reduce((a, b) => a + b, 0) / m;
  let trend = 0;
  for (let i = 0; i < m; i++) trend += (data[m + i] - data[i]) / m;
  trend /= m;

  const seasonal: number[] = new Array(n + forecastBuckets).fill(0);
  for (let i = 0; i < m; i++) seasonal[i] = data[i] - level;

  // Smooth
  for (let i = m; i < n; i++) {
    const prevLevel = level;
    level = alpha * (data[i] - seasonal[i - m]) + (1 - alpha) * (prevLevel + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonal[i] = gamma * (data[i] - level) + (1 - gamma) * seasonal[i - m];
  }

  // Forecast
  const forecast: number[] = [];
  for (let i = 1; i <= forecastBuckets; i++) {
    const seasonIdx = n - m + ((i - 1) % m);
    forecast.push(Math.max(0, level + i * trend + seasonal[seasonIdx]));
  }
  return forecast;
}

// ─── Prophet-style forecast (piecewise linear trend + Fourier seasonality) ───
export function prophetForecast(data: number[], forecastBuckets: number): number[] {
  const n = data.length;
  if (n < 4) return linearForecast(data, forecastBuckets);

  // 1. Fit piecewise linear trend with automatic changepoints
  const numChangepoints = Math.min(Math.max(2, Math.floor(n / 10)), 25);
  const cpIndices: number[] = [];
  for (let i = 1; i <= numChangepoints; i++) {
    cpIndices.push(Math.round((i / (numChangepoints + 1)) * n * 0.8)); // first 80% of data
  }

  // Simple piecewise trend: fit slope changes at changepoints using OLS-like approach
  const trend = fitPiecewiseTrend(data, cpIndices);

  // 2. Detrend and extract seasonality via Fourier series
  const detrended = data.map((v, i) => v - trend[i]);
  const seasonality = fitFourierSeasonality(detrended, n + forecastBuckets);

  // 3. Extrapolate trend
  const lastSlope = n >= 2 ? (trend[n - 1] - trend[n - 2]) : 0;
  const lastLevel = trend[n - 1];

  const forecast: number[] = [];
  for (let i = 0; i < forecastBuckets; i++) {
    const trendVal = lastLevel + lastSlope * (i + 1);
    const seasonVal = seasonality[n + i];
    forecast.push(Math.max(0, trendVal + seasonVal));
  }
  return forecast;
}

function fitPiecewiseTrend(data: number[], cpIndices: number[]): number[] {
  const n = data.length;
  // Simplified: fit linear segments between changepoints
  const breakpoints = [0, ...cpIndices, n - 1];
  const trend: number[] = new Array(n).fill(0);

  for (let seg = 0; seg < breakpoints.length - 1; seg++) {
    const start = breakpoints[seg];
    const end = breakpoints[seg + 1];
    if (end <= start) continue;
    const startVal = data[start];
    const endVal = data[end];
    for (let i = start; i <= end; i++) {
      const t = (i - start) / (end - start);
      trend[i] = startVal + t * (endVal - startVal);
    }
  }
  // Smooth the trend with a simple moving average to avoid overfitting
  const smoothed: number[] = [...trend];
  const windowSize = Math.max(3, Math.floor(n / 20));
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - windowSize); j <= Math.min(n - 1, i + windowSize); j++) {
      sum += trend[j];
      count++;
    }
    smoothed[i] = sum / count;
  }
  return smoothed;
}

function fitFourierSeasonality(detrended: number[], totalLength: number): number[] {
  const n = detrended.length;
  // Try to detect dominant period and fit Fourier terms
  const period = detectSeasonLength(detrended) || Math.min(n, 24);
  const numHarmonics = Math.min(4, Math.floor(period / 2));

  // Fit Fourier coefficients using least squares (simplified: direct DFT at target frequencies)
  const coeffs: { a: number; b: number; freq: number }[] = [];
  for (let h = 1; h <= numHarmonics; h++) {
    const freq = (2 * Math.PI * h) / period;
    let sumCos = 0, sumSin = 0;
    for (let i = 0; i < n; i++) {
      sumCos += detrended[i] * Math.cos(freq * i);
      sumSin += detrended[i] * Math.sin(freq * i);
    }
    coeffs.push({ a: (2 * sumCos) / n, b: (2 * sumSin) / n, freq });
  }

  // Reconstruct seasonality for full length
  const seasonality: number[] = new Array(totalLength).fill(0);
  for (let i = 0; i < totalLength; i++) {
    for (const { a, b, freq } of coeffs) {
      seasonality[i] += a * Math.cos(freq * i) + b * Math.sin(freq * i);
    }
  }
  return seasonality;
}

// ─── ARIMA(p, d, q) forecast ───
export function arimaForecast(data: number[], forecastBuckets: number, p = 5, d = 1, q = 2): number[] {
  const n = data.length;
  if (n < p + d + 2) return linearForecast(data, forecastBuckets);

  // 1. Differencing (d times)
  let diffed = [...data];
  const diffHistory: number[][] = [];
  for (let dd = 0; dd < d; dd++) {
    diffHistory.push([...diffed]);
    const newDiff: number[] = [];
    for (let i = 1; i < diffed.length; i++) {
      newDiff.push(diffed[i] - diffed[i - 1]);
    }
    diffed = newDiff;
  }

  // 2. Fit AR(p) coefficients using Yule-Walker (autocorrelation method)
  const arCoeffs = fitAR(diffed, p);

  // 3. Compute residuals from AR model
  const residuals: number[] = new Array(diffed.length).fill(0);
  for (let i = p; i < diffed.length; i++) {
    let predicted = 0;
    for (let j = 0; j < p; j++) {
      predicted += arCoeffs[j] * diffed[i - j - 1];
    }
    residuals[i] = diffed[i] - predicted;
  }

  // 4. Fit MA(q) — simplified: use recent residuals as-is
  const maCoeffs = fitMA(residuals, q);

  // 5. Forecast in differenced space
  const extended = [...diffed];
  const extResiduals = [...residuals];
  for (let i = 0; i < forecastBuckets; i++) {
    let forecast = 0;
    // AR component
    for (let j = 0; j < p; j++) {
      const idx = extended.length - j - 1;
      if (idx >= 0) forecast += arCoeffs[j] * extended[idx];
    }
    // MA component (residuals decay to 0)
    for (let j = 0; j < q; j++) {
      const idx = extResiduals.length - j - 1;
      if (idx >= 0) forecast += maCoeffs[j] * extResiduals[idx];
    }
    extended.push(forecast);
    extResiduals.push(0); // future residuals assumed 0
  }

  // 6. Inverse differencing
  const forecastDiffed = extended.slice(diffed.length);
  let result = [...forecastDiffed];
  for (let dd = d - 1; dd >= 0; dd--) {
    const prev = diffHistory[dd];
    const integrated: number[] = [];
    let lastVal = prev[prev.length - 1];
    for (let i = 0; i < result.length; i++) {
      lastVal = lastVal + result[i];
      integrated.push(lastVal);
    }
    result = integrated;
  }

  return result.map((v) => Math.max(0, v));
}

// ─── SARIMA(p, d, q)(P, D, Q, m) forecast ───
export function sarimaForecast(
  data: number[],
  forecastBuckets: number,
  p = 3, d = 1, q = 1,
  P = 1, D = 1, Q = 1,
  m?: number,
): number[] {
  const n = data.length;
  const season = m ?? detectSeasonLength(data);

  if (n < season * 2 + p + d) {
    // Not enough data for seasonal model, fall back to ARIMA
    return arimaForecast(data, forecastBuckets, p, d, q);
  }

  // 1. Seasonal differencing (D times)
  let diffed = [...data];
  const sDiffHistory: number[][] = [];
  for (let dd = 0; dd < D; dd++) {
    sDiffHistory.push([...diffed]);
    const newDiff: number[] = [];
    for (let i = season; i < diffed.length; i++) {
      newDiff.push(diffed[i] - diffed[i - season]);
    }
    diffed = newDiff;
  }

  // 2. Regular differencing (d times)
  const rDiffHistory: number[][] = [];
  for (let dd = 0; dd < d; dd++) {
    rDiffHistory.push([...diffed]);
    const newDiff: number[] = [];
    for (let i = 1; i < diffed.length; i++) {
      newDiff.push(diffed[i] - diffed[i - 1]);
    }
    diffed = newDiff;
  }

  // 3. Fit AR(p) + SAR(P) using autocorrelation
  const arCoeffs = fitAR(diffed, p);
  const sarCoeffs = fitSeasonalAR(diffed, P, season);

  // 4. Compute residuals
  const residuals: number[] = new Array(diffed.length).fill(0);
  const startIdx = Math.max(p, P * season);
  for (let i = startIdx; i < diffed.length; i++) {
    let predicted = 0;
    for (let j = 0; j < p; j++) predicted += arCoeffs[j] * diffed[i - j - 1];
    for (let j = 0; j < P; j++) {
      const idx = i - (j + 1) * season;
      if (idx >= 0) predicted += sarCoeffs[j] * diffed[idx];
    }
    residuals[i] = diffed[i] - predicted;
  }

  // 5. MA + SMA coefficients
  const maCoeffs = fitMA(residuals, q);
  const smaCoeffs = fitSeasonalMA(residuals, Q, season);

  // 6. Forecast in fully differenced space
  const extended = [...diffed];
  const extResiduals = [...residuals];
  for (let i = 0; i < forecastBuckets; i++) {
    let forecast = 0;
    for (let j = 0; j < p; j++) {
      const idx = extended.length - j - 1;
      if (idx >= 0) forecast += arCoeffs[j] * extended[idx];
    }
    for (let j = 0; j < P; j++) {
      const idx = extended.length - (j + 1) * season;
      if (idx >= 0) forecast += sarCoeffs[j] * extended[idx];
    }
    for (let j = 0; j < q; j++) {
      const idx = extResiduals.length - j - 1;
      if (idx >= 0) forecast += maCoeffs[j] * extResiduals[idx];
    }
    for (let j = 0; j < Q; j++) {
      const idx = extResiduals.length - (j + 1) * season;
      if (idx >= 0) forecast += smaCoeffs[j] * extResiduals[idx];
    }
    extended.push(forecast);
    extResiduals.push(0);
  }

  // 7. Inverse regular differencing
  let result = extended.slice(diffed.length);
  for (let dd = d - 1; dd >= 0; dd--) {
    const prev = rDiffHistory[dd];
    const integrated: number[] = [];
    let lastVal = prev[prev.length - 1];
    for (let i = 0; i < result.length; i++) {
      lastVal = lastVal + result[i];
      integrated.push(lastVal);
    }
    result = integrated;
  }

  // 8. Inverse seasonal differencing
  for (let dd = D - 1; dd >= 0; dd--) {
    const prev = sDiffHistory[dd];
    const integrated: number[] = [];
    for (let i = 0; i < result.length; i++) {
      const seasonIdx = prev.length - season + (i % season);
      const base = i < season
        ? prev[prev.length - season + i]
        : integrated[i - season];
      integrated.push(base + result[i]);
    }
    result = integrated;
  }

  return result.map((v) => Math.max(0, v));
}

// ─── Helper: detect dominant season length via autocorrelation ───
function detectSeasonLength(data: number[]): number {
  const n = data.length;
  if (n < 8) return 0;
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const centered = data.map((v) => v - mean);
  const maxLag = Math.floor(n / 2);

  // Compute autocorrelation
  const acf: number[] = [];
  const variance = centered.reduce((a, v) => a + v * v, 0);
  if (variance === 0) return 0;

  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += centered[i] * centered[i + lag];
    acf.push(sum / variance);
  }

  // Find first peak after lag 2 (skip trivial lag-0 and lag-1)
  let bestLag = 0;
  let bestVal = -Infinity;
  for (let lag = 2; lag < acf.length; lag++) {
    if (acf[lag] > bestVal && acf[lag] > acf[lag - 1] && (lag === acf.length - 1 || acf[lag] >= acf[lag + 1])) {
      bestVal = acf[lag];
      bestLag = lag;
      break; // take first significant peak
    }
  }
  // Only accept if correlation is meaningful
  return bestVal > 0.1 ? bestLag : Math.min(24, Math.floor(n / 4));
}

// ─── Helper: fit AR coefficients via Yule-Walker ───
function fitAR(data: number[], order: number): number[] {
  const n = data.length;
  if (n <= order) return new Array(order).fill(0);

  const mean = data.reduce((a, b) => a + b, 0) / n;
  const centered = data.map((v) => v - mean);

  // Compute autocorrelations
  const r: number[] = new Array(order + 1).fill(0);
  for (let lag = 0; lag <= order; lag++) {
    for (let i = 0; i < n - lag; i++) {
      r[lag] += centered[i] * centered[i + lag];
    }
    r[lag] /= n;
  }
  if (r[0] === 0) return new Array(order).fill(0);

  // Levinson-Durbin recursion
  const coeffs: number[] = new Array(order).fill(0);
  const prevCoeffs: number[] = new Array(order).fill(0);
  coeffs[0] = r[1] / r[0];
  let err = r[0] * (1 - coeffs[0] * coeffs[0]);

  for (let m = 1; m < order; m++) {
    let lambda = r[m + 1];
    for (let j = 0; j < m; j++) {
      lambda -= coeffs[j] * r[m - j];
    }
    if (Math.abs(err) < 1e-12) break;
    const k = lambda / err;

    for (let j = 0; j < m; j++) prevCoeffs[j] = coeffs[j];
    coeffs[m] = k;
    for (let j = 0; j < m; j++) {
      coeffs[j] = prevCoeffs[j] - k * prevCoeffs[m - 1 - j];
    }
    err *= 1 - k * k;
    if (err <= 0) break;
  }

  return coeffs;
}

// ─── Helper: fit seasonal AR coefficients ───
function fitSeasonalAR(data: number[], order: number, season: number): number[] {
  const n = data.length;
  if (n <= order * season) return new Array(order).fill(0);

  const mean = data.reduce((a, b) => a + b, 0) / n;
  const centered = data.map((v) => v - mean);

  const coeffs: number[] = [];
  for (let j = 0; j < order; j++) {
    const lag = (j + 1) * season;
    if (lag >= n) { coeffs.push(0); continue; }
    let num = 0, den = 0;
    for (let i = lag; i < n; i++) {
      num += centered[i] * centered[i - lag];
      den += centered[i - lag] * centered[i - lag];
    }
    coeffs.push(den !== 0 ? num / den : 0);
  }
  return coeffs;
}

// ─── Helper: fit MA coefficients (simplified via residual autocorrelation) ───
function fitMA(residuals: number[], order: number): number[] {
  const n = residuals.length;
  if (n <= order) return new Array(order).fill(0);

  // Approximate MA coefficients from residual autocorrelation
  const mean = residuals.reduce((a, b) => a + b, 0) / n;
  const centered = residuals.map((v) => v - mean);
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += centered[i] * centered[i];
  if (r0 === 0) return new Array(order).fill(0);

  const coeffs: number[] = [];
  for (let lag = 1; lag <= order; lag++) {
    let rk = 0;
    for (let i = lag; i < n; i++) rk += centered[i] * centered[i - lag];
    // theta ≈ rk / r0 (innovation form approximation)
    coeffs.push(Math.max(-0.9, Math.min(0.9, rk / r0)));
  }
  return coeffs;
}

// ─── Helper: fit seasonal MA coefficients ───
function fitSeasonalMA(residuals: number[], order: number, season: number): number[] {
  const n = residuals.length;
  if (n <= order * season) return new Array(order).fill(0);

  const mean = residuals.reduce((a, b) => a + b, 0) / n;
  const centered = residuals.map((v) => v - mean);
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += centered[i] * centered[i];
  if (r0 === 0) return new Array(order).fill(0);

  const coeffs: number[] = [];
  for (let j = 0; j < order; j++) {
    const lag = (j + 1) * season;
    if (lag >= n) { coeffs.push(0); continue; }
    let rk = 0;
    for (let i = lag; i < n; i++) rk += centered[i] * centered[i - lag];
    coeffs.push(Math.max(-0.9, Math.min(0.9, rk / r0)));
  }
  return coeffs;
}

// ─── Confidence band (based on historical std dev) ───
export function confidenceBand(data: number[], forecast: number[]): { upper: number[]; lower: number[] } {
  const n = data.length;
  if (n < 2) return { upper: forecast, lower: forecast };
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const variance = data.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return {
    upper: forecast.map((v, i) => v + std * (1 + 0.1 * i)),
    lower: forecast.map((v, i) => Math.max(0, v - std * (1 + 0.1 * i))),
  };
}

export interface ForecastModalProps {
  label: string;
  sparkline: number[];
  color?: string;
  /** Timeframe start (epoch ms) */
  fromMs: number;
  /** Timeframe end (epoch ms) */
  toMs: number;
  onClose: () => void;
}

export type ForecastMethod = "linear" | "holt-winters" | "triple-exp" | "prophet" | "arima" | "sarima";

function formatAxisValue(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (v >= 10) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

function formatDate(ts: number, short = false): string {
  const d = new Date(ts);
  if (short) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export function ForecastModal({ label, sparkline, color = "#4589FF", fromMs, toMs, onClose }: ForecastModalProps) {
  const [method, setMethod] = useState<ForecastMethod>("prophet");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const historicalData = useMemo(() => sparkline.filter((v) => v != null && isFinite(v)), [sparkline]);

  // Forecast 7 days worth of buckets (same bucket width as historical)
  const forecastData = useMemo(() => {
    const duration = toMs - fromMs;
    const bucketMs = duration / historicalData.length;
    const forecastMs = 7 * 24 * 3600 * 1000; // 7 days
    const forecastBuckets = Math.round(forecastMs / bucketMs);
    switch (method) {
      case "linear": return linearForecast(historicalData, forecastBuckets);
      case "holt-winters": return holtWintersForecast(historicalData, forecastBuckets);
      case "triple-exp": return tripleExpSmoothingForecast(historicalData, forecastBuckets);
      case "prophet": return prophetForecast(historicalData, forecastBuckets);
      case "arima": return arimaForecast(historicalData, forecastBuckets);
      case "sarima": return sarimaForecast(historicalData, forecastBuckets);
      default: return holtWintersForecast(historicalData, forecastBuckets);
    }
  }, [historicalData, method, fromMs, toMs]);

  const confidence = useMemo(() => confidenceBand(historicalData, forecastData), [historicalData, forecastData]);

  // Combined data for rendering
  const allValues = useMemo(() => [...historicalData, ...forecastData, ...confidence.upper], [historicalData, forecastData, confidence.upper]);
  const totalPoints = historicalData.length + forecastData.length;

  // Chart dimensions
  const MARGIN = { top: 40, right: 60, bottom: 60, left: 70 };
  const W = 900;
  const H = 400;
  const plotW = W - MARGIN.left - MARGIN.right;
  const plotH = H - MARGIN.top - MARGIN.bottom;

  const yMin = Math.min(0, ...allValues.filter(isFinite));
  const yMax = Math.max(...allValues.filter(isFinite)) * 1.1 || 1;
  const yRange = yMax - yMin || 1;

  const xScale = (i: number) => MARGIN.left + (i / (totalPoints - 1)) * plotW;
  const yScale = (v: number) => MARGIN.top + plotH - ((v - yMin) / yRange) * plotH;

  // Time axis labels
  const duration = toMs - fromMs;
  const bucketMs = duration / historicalData.length;
  const timeLabels = useMemo(() => {
    const labels: { x: number; text: string }[] = [];
    const totalDuration = duration + 7 * 24 * 3600 * 1000;
    const labelCount = Math.min(12, totalPoints);
    const step = Math.max(1, Math.floor(totalPoints / labelCount));
    for (let i = 0; i < totalPoints; i += step) {
      const ts = fromMs + i * bucketMs;
      labels.push({ x: xScale(i), text: formatDate(ts, totalDuration > 5 * 24 * 3600 * 1000) });
    }
    return labels;
  }, [totalPoints, fromMs, bucketMs, duration]);

  // Y axis labels
  const yTicks = useMemo(() => {
    const count = 6;
    const ticks: { y: number; value: number }[] = [];
    for (let i = 0; i <= count; i++) {
      const value = yMin + (yRange * i) / count;
      ticks.push({ y: yScale(value), value });
    }
    return ticks;
  }, [yMin, yRange]);

  // SVG paths
  const historicalPath = historicalData.map((v, i) => `${i === 0 ? "M" : "L"}${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(" ");
  const forecastPath = forecastData.map((v, i) => {
    const idx = historicalData.length + i;
    return `${i === 0 ? "M" : "L"}${xScale(idx).toFixed(1)},${yScale(v).toFixed(1)}`;
  }).join(" ");
  // Connection from last historical to first forecast
  const connectionPath = historicalData.length > 0 && forecastData.length > 0
    ? `M${xScale(historicalData.length - 1).toFixed(1)},${yScale(historicalData[historicalData.length - 1]).toFixed(1)} L${xScale(historicalData.length).toFixed(1)},${yScale(forecastData[0]).toFixed(1)}`
    : "";

  // Confidence band polygon
  const confidencePoly = useMemo(() => {
    const upper = confidence.upper.map((v, i) => `${xScale(historicalData.length + i).toFixed(1)},${yScale(v).toFixed(1)}`);
    const lower = [...confidence.lower].reverse().map((v, i) => `${xScale(historicalData.length + confidence.lower.length - 1 - i).toFixed(1)},${yScale(v).toFixed(1)}`);
    return [...upper, ...lower].join(" ");
  }, [confidence, historicalData.length]);

  // Hover handler
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round(((x - MARGIN.left) / plotW) * (totalPoints - 1));
    setHoverIdx(Math.max(0, Math.min(totalPoints - 1, idx)));
  };

  const hoverValue = hoverIdx !== null
    ? hoverIdx < historicalData.length
      ? historicalData[hoverIdx]
      : forecastData[hoverIdx - historicalData.length]
    : null;
  const hoverTs = hoverIdx !== null ? fromMs + hoverIdx * bucketMs : null;
  const isForecastPoint = hoverIdx !== null && hoverIdx >= historicalData.length;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: "rgba(0, 0, 0, 0.8)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "rgba(20, 24, 46, 0.97)",
          borderRadius: 12,
          padding: "24px 32px",
          maxWidth: "95vw",
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
          border: "1px solid rgba(128,128,128,0.2)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, color: "#fff", fontSize: 18, fontWeight: 700 }}>{label} — 7-Day Forecast</h2>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
              {formatDate(fromMs)} → {formatDate(toMs + 7 * 24 * 3600 * 1000)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Method toggle */}
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as ForecastMethod)}
              style={{
                background: "#1a1e38",
                color: "#fff",
                border: "1px solid rgba(128,128,128,0.4)",
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: 12,
                cursor: "pointer",
                appearance: "none",
                WebkitAppearance: "none",
                paddingRight: 24,
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23ffffff' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 6px center",
              }}
            >
              <option value="holt-winters" style={{ background: "#1a1e38", color: "#fff" }}>Holt-Winters (Double Exp.)</option>
              <option value="triple-exp" style={{ background: "#1a1e38", color: "#fff" }}>Triple Exp. Smoothing</option>
              <option value="prophet" style={{ background: "#1a1e38", color: "#fff" }}>Prophet</option>
              <option value="arima" style={{ background: "#1a1e38", color: "#fff" }}>ARIMA</option>
              <option value="sarima" style={{ background: "#1a1e38", color: "#fff" }}>SARIMA</option>
              <option value="linear" style={{ background: "#1a1e38", color: "#fff" }}>Linear Regression</option>
            </select>
            <button
              onClick={onClose}
              style={{
                background: "rgba(128,128,128,0.2)",
                color: "#fff",
                border: "1px solid rgba(128,128,128,0.3)",
                borderRadius: 6,
                padding: "6px 14px",
                fontSize: 13,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Chart */}
        <svg
          width={W}
          height={H}
          style={{ display: "block", cursor: "crosshair" }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Grid lines */}
          {yTicks.map((t, i) => (
            <g key={i}>
              <line x1={MARGIN.left} y1={t.y} x2={W - MARGIN.right} y2={t.y} stroke="rgba(128,128,128,0.15)" strokeWidth={1} />
              <text x={MARGIN.left - 8} y={t.y + 4} textAnchor="end" fill="rgba(255,255,255,0.6)" fontSize={11}>
                {formatAxisValue(t.value)}
              </text>
            </g>
          ))}

          {/* X axis labels */}
          {timeLabels.map((l, i) => (
            <text key={i} x={l.x} y={H - MARGIN.bottom + 20} textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize={10}>
              {l.text}
            </text>
          ))}

          {/* Forecast/Historical divider */}
          <line
            x1={xScale(historicalData.length - 1)}
            y1={MARGIN.top}
            x2={xScale(historicalData.length - 1)}
            y2={H - MARGIN.bottom}
            stroke="rgba(255,255,255,0.2)"
            strokeDasharray="4,4"
            strokeWidth={1}
          />
          <text
            x={xScale(historicalData.length - 1)}
            y={MARGIN.top - 8}
            textAnchor="middle"
            fill="rgba(255,255,255,0.4)"
            fontSize={10}
          >
            Now
          </text>

          {/* Confidence band */}
          <polygon points={confidencePoly} fill={color} fillOpacity={0.08} />

          {/* Historical line */}
          <path d={historicalPath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />

          {/* Historical data points */}
          {historicalData.map((v, i) => (
            <circle key={`h-${i}`} cx={xScale(i)} cy={yScale(v)} r={historicalData.length > 60 ? 1.5 : 3} fill={color} opacity={0.8} />
          ))}

          {/* Connection line */}
          <path d={connectionPath} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="4,3" opacity={0.6} />

          {/* Forecast line (dashed) */}
          <path d={forecastPath} fill="none" stroke={color} strokeWidth={2} strokeDasharray="6,4" opacity={0.8} />

          {/* Forecast data points */}
          {forecastData.map((v, i) => (
            <circle key={`f-${i}`} cx={xScale(historicalData.length + i)} cy={yScale(v)} r={forecastData.length > 60 ? 1.5 : 3} fill={color} opacity={0.5} />
          ))}

          {/* Hover crosshair */}
          {hoverIdx !== null && hoverValue !== null && (
            <>
              <line
                x1={xScale(hoverIdx)}
                y1={MARGIN.top}
                x2={xScale(hoverIdx)}
                y2={H - MARGIN.bottom}
                stroke="rgba(255,255,255,0.4)"
                strokeWidth={1}
                strokeDasharray="3,3"
              />
              <line
                x1={MARGIN.left}
                y1={yScale(hoverValue)}
                x2={W - MARGIN.right}
                y2={yScale(hoverValue)}
                stroke="rgba(255,255,255,0.2)"
                strokeWidth={1}
                strokeDasharray="3,3"
              />
              <circle
                cx={xScale(hoverIdx)}
                cy={yScale(hoverValue)}
                r={5}
                fill={isForecastPoint ? "transparent" : color}
                stroke={color}
                strokeWidth={2}
              />
            </>
          )}
        </svg>

        {/* Hover tooltip */}
        {hoverIdx !== null && hoverValue !== null && hoverTs !== null && (
          <div
            style={{
              marginTop: 8,
              display: "flex",
              justifyContent: "center",
              gap: 16,
              fontSize: 12,
              color: "rgba(255,255,255,0.8)",
            }}
          >
            <span>{formatDate(hoverTs)}</span>
            <span style={{ color, fontWeight: 700 }}>
              {isForecastPoint ? "Forecast: " : "Actual: "}
              {formatAxisValue(hoverValue)}
            </span>
            {isForecastPoint && (
              <span style={{ opacity: 0.5 }}>
                (±{formatAxisValue(confidence.upper[hoverIdx - historicalData.length] - hoverValue)})
              </span>
            )}
          </div>
        )}

        {/* Legend */}
        <div style={{ display: "flex", gap: 24, marginTop: 16, justifyContent: "center", fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width={24} height={3}><line x1={0} y1={1.5} x2={24} y2={1.5} stroke={color} strokeWidth={2} /></svg>
            <span style={{ color: "rgba(255,255,255,0.7)" }}>Historical</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width={24} height={3}><line x1={0} y1={1.5} x2={24} y2={1.5} stroke={color} strokeWidth={2} strokeDasharray="4,3" /></svg>
            <span style={{ color: "rgba(255,255,255,0.7)" }}>Forecast (7d)</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width={16} height={12}><rect x={0} y={0} width={16} height={12} fill={color} fillOpacity={0.15} rx={2} /></svg>
            <span style={{ color: "rgba(255,255,255,0.7)" }}>Confidence Band</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width={8} height={8}><circle cx={4} cy={4} r={3} fill={color} /></svg>
            <span style={{ color: "rgba(255,255,255,0.7)" }}>Data Points</span>
          </div>
        </div>
      </div>
    </div>
  );
}
