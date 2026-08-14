import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTimelapseOptional } from "../TimelapseContext";
import { useUserAppState, useSetUserAppState } from "@dynatrace-sdk/react-hooks";
import { Text } from "@dynatrace/strato-components/typography";
import { Button } from "@dynatrace/strato-components/buttons";
import { Modal } from "@dynatrace/strato-components/overlays";
import { TextInput } from "@dynatrace/strato-components-preview/forms";
import { Select } from "@dynatrace/strato-components-preview/forms";

const ANNOTATIONS_KEY = "svc-annotations";

export type AnnotationType = "incident" | "maintenance" | "deployment" | "note";

export interface Annotation {
  id: string;
  timestampMs: number;
  type: AnnotationType;
  label: string;
  note?: string;
}

export const TYPE_COLORS: Record<AnnotationType, string> = {
  incident: "#C21930",
  maintenance: "#FCD53F",
  deployment: "#4589FF",
  note: "#9EA6B4",
};

const TYPE_LABELS: Record<AnnotationType, string> = {
  incident: "🔴 Incident",
  maintenance: "🟡 Maintenance",
  deployment: "🔵 Deployment",
  note: "⚪ Note",
};

// ---------------------------------------------------------------------------
// Context — lets ChartTile read annotations without prop-drilling
// ---------------------------------------------------------------------------
interface AnnotationContextValue {
  annotations: Annotation[];
  addAnnotation: (ann: Omit<Annotation, "id">) => void;
  removeAnnotation: (id: string) => void;
}

const AnnotationContext = createContext<AnnotationContextValue>({
  annotations: [],
  addAnnotation: () => {},
  removeAnnotation: () => {},
});

export function useAnnotations() {
  return useContext(AnnotationContext);
}

// ---------------------------------------------------------------------------
// Provider — mount once near the root of ServicesOverview
// ---------------------------------------------------------------------------
export function AnnotationProvider({ children }: { children: React.ReactNode }) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const savedState = useUserAppState({ key: ANNOTATIONS_KEY });
  const { execute: saveAppState } = useSetUserAppState();

  useEffect(() => {
    if (savedState.data?.value) {
      try {
        const parsed = JSON.parse(savedState.data.value as string);
        if (Array.isArray(parsed)) setAnnotations(parsed);
      } catch {
        /* ignore corrupt state */
      }
    }
  }, [savedState.data]);

  const addAnnotation = useCallback(
    (ann: Omit<Annotation, "id">) => {
      setAnnotations((prev) => {
        const next = [
          ...prev,
          { ...ann, id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
        ];
        saveAppState({ key: ANNOTATIONS_KEY, body: { value: JSON.stringify(next) } });
        return next;
      });
    },
    [saveAppState],
  );

  const removeAnnotation = useCallback(
    (id: string) => {
      setAnnotations((prev) => {
        const next = prev.filter((a) => a.id !== id);
        saveAppState({ key: ANNOTATIONS_KEY, body: { value: JSON.stringify(next) } });
        return next;
      });
    },
    [saveAppState],
  );

  return (
    <AnnotationContext.Provider value={{ annotations, addAnnotation, removeAnnotation }}>
      {children}
    </AnnotationContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// AnnotationStrip — thin timeline above a chart
// ---------------------------------------------------------------------------
interface AnnotationStripProps {
  fromMs: number;
  toMs: number;
  /** Optional chart-tile context label shown in the add modal */
  context?: string;
}

export function AnnotationStrip({ fromMs, toMs, context }: AnnotationStripProps) {
  const { annotations, removeAnnotation, addAnnotation } = useAnnotations();
  const [modalOpen, setModalOpen] = useState(false);
  const rangeMs = Math.max(toMs - fromMs, 1);
  const visible = annotations.filter((a) => a.timestampMs >= fromMs && a.timestampMs <= toMs);

  const tl = useTimelapseOptional();
  const tlCursorLeft = tl?.enabled && tl.totalBuckets > 0
    ? (tl.index / tl.totalBuckets) * 100
    : -1;
  const tlCursorWidth = tl?.enabled && tl.totalBuckets > 0
    ? (1 / tl.totalBuckets) * 100
    : 0;

  return (
    <>
      <div
        style={{
          position: "relative",
          height: 18,
          marginBottom: 2,
          display: "flex",
          alignItems: "center",
        }}
        title="Annotation timeline — coloured markers indicate notes, incidents, maintenance windows, and deployments"
      >
        {/* baseline rule */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 18,
            top: "50%",
            height: 1,
            background: "rgba(128,128,128,0.12)",
            pointerEvents: "none",
          }}
        />
        {/* Timelapse cursor band */}
        {tlCursorLeft >= 0 && (
          <div
            style={{
              position: "absolute",
              left: `${tlCursorLeft}%`,
              width: `${Math.max(tlCursorWidth, 0.5)}%`,
              top: 0,
              height: 18,
              background: "rgba(255,61,154,0.18)",
              borderLeft: "2px solid rgba(255,61,154,0.7)",
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        )}
        {visible.map((ann) => {
          const pct = ((ann.timestampMs - fromMs) / rangeMs) * 100;
          const clamped = Math.min(Math.max(pct, 0), 97);
          return (
            <div
              key={ann.id}
              title={`${TYPE_LABELS[ann.type]}: ${ann.label}${ann.note ? "\n" + ann.note : ""}\n\nClick to remove`}
              onClick={() => {
                if (window.confirm(`Remove annotation "${ann.label}"?`)) removeAnnotation(ann.id);
              }}
              style={{
                position: "absolute",
                left: `${clamped}%`,
                top: 0,
                width: 3,
                height: 18,
                background: TYPE_COLORS[ann.type],
                cursor: "pointer",
                zIndex: 2,
                borderRadius: 2,
                transition: "opacity 0.1s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.opacity = "0.65")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.opacity = "1")}
            />
          );
        })}
        {/* Add button */}
        <button
          onClick={() => setModalOpen(true)}
          title="Add note, incident marker, maintenance window, or deployment annotation"
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            height: 18,
            width: 18,
            borderRadius: "50%",
            border: "1px dashed rgba(128,128,128,0.35)",
            background: "transparent",
            cursor: "pointer",
            fontSize: 11,
            lineHeight: "16px",
            textAlign: "center",
            color: "inherit",
            opacity: 0.5,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          +
        </button>
      </div>
      {modalOpen && (
        <AnnotationModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onSave={(ann) => {
            addAnnotation(ann);
            setModalOpen(false);
          }}
          defaultTimestampMs={fromMs + rangeMs / 2}
          context={context}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// AnnotationModal — create / edit a single annotation
// ---------------------------------------------------------------------------
interface AnnotationModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (ann: Omit<Annotation, "id">) => void;
  defaultTimestampMs?: number;
  context?: string;
}

function toLocalDatetimeValue(ms: number): string {
  // datetime-local input expects "YYYY-MM-DDTHH:mm"
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AnnotationModal({
  open,
  onClose,
  onSave,
  defaultTimestampMs,
  context,
}: AnnotationModalProps) {
  const [type, setType] = useState<AnnotationType>("note");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [tsInput, setTsInput] = useState(() =>
    toLocalDatetimeValue(defaultTimestampMs ?? Date.now()),
  );
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setLabel("");
      setNote("");
      setTsInput(toLocalDatetimeValue(defaultTimestampMs ?? Date.now()));
      setType("note");
      setTimeout(() => labelRef.current?.focus(), 60);
    }
  }, [open, defaultTimestampMs]);

  const handleSave = () => {
    if (!label.trim()) return;
    const timestampMs = new Date(tsInput).getTime();
    if (isNaN(timestampMs)) return;
    onSave({ timestampMs, type, label: label.trim(), note: note.trim() || undefined });
  };

  if (!open) return null;

  return (
    <Modal title={context ? `Add Annotation — ${context}` : "Add Annotation"} onDismiss={onClose} show={open}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 0", minWidth: 340 }}>
        {/* Type picker */}
        <div>
          <Text style={{ fontSize: 12, opacity: 0.65, display: "block", marginBottom: 6 }}>Type</Text>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["incident", "maintenance", "deployment", "note"] as AnnotationType[]).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 12,
                  fontSize: 11,
                  cursor: "pointer",
                  border: `1px solid ${type === t ? TYPE_COLORS[t] : "rgba(128,128,128,0.3)"}`,
                  background: type === t ? `${TYPE_COLORS[t]}22` : "transparent",
                  color: type === t ? TYPE_COLORS[t] : "inherit",
                  fontWeight: type === t ? 700 : 400,
                }}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
        {/* Label */}
        <div>
          <Text style={{ fontSize: 12, opacity: 0.65, display: "block", marginBottom: 4 }}>
            Label <span style={{ color: "#C21930" }}>*</span>
          </Text>
          <input
            ref={labelRef}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Short description, e.g. 'Payment gateway outage'"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") onClose();
            }}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 4,
              border: "1px solid rgba(128,128,128,0.35)",
              background: "transparent",
              color: "inherit",
              fontSize: 13,
              boxSizing: "border-box",
            }}
          />
        </div>
        {/* Timestamp */}
        <div>
          <Text style={{ fontSize: 12, opacity: 0.65, display: "block", marginBottom: 4 }}>
            Timestamp
          </Text>
          <input
            type="datetime-local"
            value={tsInput}
            onChange={(e) => setTsInput(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 4,
              border: "1px solid rgba(128,128,128,0.35)",
              background: "transparent",
              color: "inherit",
              fontSize: 13,
              boxSizing: "border-box",
            }}
          />
        </div>
        {/* Note */}
        <div>
          <Text style={{ fontSize: 12, opacity: 0.65, display: "block", marginBottom: 4 }}>
            Note <span style={{ opacity: 0.5 }}>(optional)</span>
          </Text>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Additional context, runbook link, owner..."
            rows={2}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 4,
              border: "1px solid rgba(128,128,128,0.35)",
              background: "transparent",
              color: "inherit",
              fontSize: 12,
              resize: "vertical",
              boxSizing: "border-box",
              fontFamily: "inherit",
            }}
          />
        </div>
        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" onClick={handleSave} disabled={!label.trim()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// AnnotationList — compact list of all annotations (for a settings panel)
// ---------------------------------------------------------------------------
export function AnnotationList() {
  const { annotations, removeAnnotation } = useAnnotations();

  if (annotations.length === 0) {
    return (
      <Text style={{ opacity: 0.5, fontSize: 12 }}>
        No annotations yet. Use the + button on any chart to add one.
      </Text>
    );
  }

  const sorted = [...annotations].sort((a, b) => b.timestampMs - a.timestampMs);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {sorted.map((ann) => (
        <div
          key={ann.id}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 6,
            border: `1px solid ${TYPE_COLORS[ann.type]}44`,
            background: `${TYPE_COLORS[ann.type]}0a`,
          }}
        >
          <div
            style={{
              width: 3,
              height: 36,
              borderRadius: 2,
              background: TYPE_COLORS[ann.type],
              flexShrink: 0,
              marginTop: 2,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <strong style={{ fontSize: 12 }}>{ann.label}</strong>
              <span style={{ fontSize: 11, opacity: 0.55, whiteSpace: "nowrap", marginLeft: 8 }}>
                {new Date(ann.timestampMs).toLocaleString()}
              </span>
            </div>
            <div style={{ fontSize: 11, opacity: 0.65 }}>
              {TYPE_LABELS[ann.type]}
              {ann.note && <span style={{ marginLeft: 8 }}>{ann.note}</span>}
            </div>
          </div>
          <button
            onClick={() => removeAnnotation(ann.id)}
            title="Remove annotation"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              opacity: 0.45,
              fontSize: 14,
              padding: 2,
              color: "inherit",
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
