import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
} from "react";
import type { Timeframe } from "@dynatrace/strato-components/core";

export interface AppTimeframe {
  /** DQL expression or ISO string for the start of the timeframe */
  from: string;
  /** Whether `from` is an ISO datetime ("iso8601") or a DQL expression ("expression") */
  fromType: "expression" | "iso8601";
  /** DQL expression or ISO string for the end of the timeframe */
  to: string;
  /** Whether `to` is an ISO datetime or a DQL expression */
  toType: "expression" | "iso8601";
  /** Resolved absolute start (epoch ms) — for duration math / previous-period calculation */
  fromMs: number;
  /** Resolved absolute end (epoch ms) */
  toMs: number;
  /** Original Timeframe object from TimeframeSelector (for the selector value) */
  raw: Timeframe | null;
}

const DEFAULT_FROM = "now()-7d";
const DEFAULT_TO = "now()";
const DEFAULT_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const computeDefault = (): AppTimeframe => {
  const nowMs = Date.now();
  return {
    from: DEFAULT_FROM,
    fromType: "expression",
    to: DEFAULT_TO,
    toType: "expression",
    fromMs: nowMs - DEFAULT_DURATION_MS,
    toMs: nowMs,
    raw: null,
  };
};

interface Ctx {
  timeframe: AppTimeframe;
  setTimeframe: (tf: Timeframe | null) => void;
}

const TimeframeContext = createContext<Ctx>({
  timeframe: computeDefault(),
  setTimeframe: () => {
    /* no-op */
  },
});

export const TimeframeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [timeframe, setTimeframeState] = useState<AppTimeframe>(computeDefault);

  const setTimeframe = useCallback((tf: Timeframe | null) => {
    if (!tf) {
      setTimeframeState(computeDefault());
      return;
    }
    const fromMs = tf.from?.absoluteDate
      ? new Date(tf.from.absoluteDate).getTime()
      : Date.now() - DEFAULT_DURATION_MS;
    const toMs = tf.to?.absoluteDate
      ? new Date(tf.to.absoluteDate).getTime()
      : Date.now();
    setTimeframeState({
      from: tf.from?.value || DEFAULT_FROM,
      fromType: tf.from?.type || "expression",
      to: tf.to?.value || DEFAULT_TO,
      toType: tf.to?.type || "expression",
      fromMs,
      toMs,
      raw: tf,
    });
  }, []);

  const value = useMemo(() => ({ timeframe, setTimeframe }), [
    timeframe,
    setTimeframe,
  ]);

  return (
    <TimeframeContext.Provider value={value}>
      {children}
    </TimeframeContext.Provider>
  );
};

export const useAppTimeframe = (): Ctx => useContext(TimeframeContext);

// ---------------------------------------------------------------------------
// Helpers used by query builders
// ---------------------------------------------------------------------------
export interface TF {
  from: string;
  fromType: "expression" | "iso8601";
  to: string;
  toType: "expression" | "iso8601";
}

const escapeStr = (s: string) => s.replace(/"/g, '\\"');

/** Render a `from`/`to` value for inline use inside a DQL clause. */
export const tfArg = (
  value: string,
  type: "expression" | "iso8601",
): string => (type === "iso8601" ? `"${escapeStr(value)}"` : value);

/** Render a `from:..., to:...` clause for use inside DQL commands like fetch / timeseries. */
export const tfClause = (tf: TF): string =>
  `from:${tfArg(tf.from, tf.fromType)}, to:${tfArg(tf.to, tf.toType)}`;

/**
 * Compute a "previous period" timeframe of the same length, ending where
 * the current period starts. Always emits ISO datetimes so the offset is
 * exact regardless of how the current timeframe was expressed.
 */
export const previousPeriod = (tf: AppTimeframe): TF => {
  const durationMs = Math.max(0, tf.toMs - tf.fromMs);
  const prevToMs = tf.fromMs;
  const prevFromMs = tf.fromMs - durationMs;
  return {
    from: new Date(prevFromMs).toISOString(),
    fromType: "iso8601",
    to: new Date(prevToMs).toISOString(),
    toType: "iso8601",
  };
};

/** Convert an `AppTimeframe` to a plain `TF` (drops absolute ms / raw). */
export const toTF = (tf: AppTimeframe): TF => ({
  from: tf.from,
  fromType: tf.fromType,
  to: tf.to,
  toType: tf.toType,
});
