import React, { useEffect, useState } from "react";
import { useBotConfig, type QuotingParams } from "../hooks/use-bot-config";

// ── Field metadata ────────────────────────────────────────────────────────────

interface FieldDef {
  key: keyof QuotingParams;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  parse: (v: string) => number;
  unit: string;
}

const FIELDS: FieldDef[] = [
  // ── Strategy ──────────────────────────────────────────────────────────────
  {
    key: "quoteHalfWidth",
    label: "Spread (half-width)",
    description:
      "How far each side sits from the mid price. bid = mid − X, ask = mid + X. A full round-trip earns 2× this.",
    min: 0.1,
    max: 30,
    step: 0.1,
    unit: "¢",
    format: (v) => `${(v * 100).toFixed(1)}¢`,
    parse: (s) => parseFloat(s) / 100,
  },
  {
    key: "widthMultiplier",
    label: "Width multiplier",
    description:
      "Multiplies the half-width in volatile markets. 1.0x = no change; 1.5x = 50% wider quotes.",
    min: 1,
    max: 5,
    step: 0.05,
    unit: "×",
    format: (v) => `${v.toFixed(2)}×`,
    parse: (s) => parseFloat(s),
  },
  {
    key: "numMarkets",
    label: "Active markets",
    description:
      "Number of markets to quote simultaneously. Capital is split evenly. More markets = more fill opportunities but more monitoring overhead.",
    min: 1,
    max: 20,
    step: 1,
    unit: "",
    format: (v) => String(Math.round(v)),
    parse: (s) => parseInt(s, 10),
  },
  {
    key: "minVolume24h",
    label: "Min 24h volume",
    description:
      "Markets with less than this much trading volume in the past 24 hours are skipped. Higher = only liquid markets.",
    min: 100,
    max: 100_000,
    step: 100,
    unit: "$",
    format: (v) => `$${v.toLocaleString()}`,
    parse: (s) => parseFloat(s),
  },
  // ── Timing ────────────────────────────────────────────────────────────────
  {
    key: "pollIntervalMs",
    label: "Quote cycle",
    description:
      "How often the bot checks its quotes. Shorter = faster reactions to price changes but more API calls.",
    min: 1,
    max: 120,
    step: 1,
    unit: "s",
    format: (v) => `${(v / 1_000).toFixed(0)}s`,
    parse: (s) => parseFloat(s) * 1_000,
  },
  {
    key: "metricsIntervalMs",
    label: "Metrics interval",
    description:
      "How often the bot reports metrics to the orchestrator dashboard.",
    min: 5,
    max: 300,
    step: 5,
    unit: "s",
    format: (v) => `${(v / 1_000).toFixed(0)}s`,
    parse: (s) => parseFloat(s) * 1_000,
  },
  // ── Risk controls ─────────────────────────────────────────────────────────
  {
    key: "maxInventorySkew",
    label: "Inventory skew limit",
    description:
      "When YES inventory exceeds this fraction of allocation, the bid size is reduced to avoid directional exposure. 0.6 = 60%.",
    min: 51,
    max: 99,
    step: 1,
    unit: "%",
    format: (v) => `${(v * 100).toFixed(0)}%`,
    parse: (s) => parseFloat(s) / 100,
  },
  {
    key: "reQuoteThreshold",
    label: "Re-quote threshold",
    description:
      "If the mid price moves more than this fraction, cancel and re-post quotes. Lower = more responsive but more cancels.",
    min: 0.1,
    max: 5,
    step: 0.05,
    unit: "%",
    format: (v) => `${(v * 100).toFixed(2)}%`,
    parse: (s) => parseFloat(s) / 100,
  },
  {
    key: "orderStalenessThreshold",
    label: "Stale order threshold",
    description:
      "If a posted order is this far away from where it should be (relative to current mid), cancel and re-post.",
    min: 0.1,
    max: 10,
    step: 0.1,
    unit: "%",
    format: (v) => `${(v * 100).toFixed(2)}%`,
    parse: (s) => parseFloat(s) / 100,
  },
  // ── Capital ───────────────────────────────────────────────────────────────
  {
    key: "paperEquity",
    label: "Paper equity",
    description:
      "Total simulated USD allocated to this bot in paper trading mode. Split evenly across active markets.",
    min: 1,
    max: 100_000,
    step: 1,
    unit: "$",
    format: (v) => `$${v.toFixed(2)}`,
    parse: (s) => parseFloat(s),
  },
];

// Helper: convert stored value to slider/input display value
function toDisplayValue(field: FieldDef, stored: number): number {
  if (field.unit === "¢") return stored * 100;
  if (field.unit === "%" && field.key !== "paperEquity") return stored * 100;
  if (field.unit === "s") return stored / 1_000;
  return stored;
}

// ── Sections ──────────────────────────────────────────────────────────────────

const SECTIONS: { label: string; keys: (keyof QuotingParams)[] }[] = [
  {
    label: "Strategy",
    keys: ["quoteHalfWidth", "widthMultiplier", "numMarkets", "minVolume24h"],
  },
  { label: "Timing", keys: ["pollIntervalMs", "metricsIntervalMs"] },
  {
    label: "Risk Controls",
    keys: ["maxInventorySkew", "reQuoteThreshold", "orderStalenessThreshold"],
  },
  { label: "Capital", keys: ["paperEquity"] },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function BotConfigPanel({
  botId,
  onConfigChange,
}: {
  botId: number;
  onConfigChange?: (params: QuotingParams) => void;
}) {
  const { params, defaults, paperTrading, loading, error, save, reset } =
    useBotConfig(botId);

  // Draft: the live editable local copy
  const [draft, setDraft] = useState<QuotingParams | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState(0);

  useEffect(() => {
    if (params && !draft) setDraft({ ...params });
  }, [params]);

  if (loading) {
    return (
      <div
        className="card"
        style={{ color: "var(--text-secondary)", padding: 24 }}
      >
        Loading config…
      </div>
    );
  }
  if (error || !params || !defaults || !draft) {
    return (
      <div className="card" style={{ color: "var(--danger)", padding: 24 }}>
        ⚠ Could not load bot configuration. Is the bot running?
      </div>
    );
  }

  function setField(field: FieldDef, displayVal: number) {
    setDraft((prev) => ({
      ...prev!,
      [field.key]: field.parse(String(displayVal)),
    }));
  }

  const isDirty =
    draft &&
    params &&
    (Object.keys(draft) as (keyof QuotingParams)[]).some(
      (k) => draft[k] !== params[k],
    );

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    const updated = await save(draft);
    setSaving(false);
    if (updated) {
      onConfigChange?.(updated);
      setSavedKey("all");
      setTimeout(() => setSavedKey(null), 2_000);
    }
  }

  async function handleReset() {
    const updated = await reset();
    if (updated) {
      setDraft({ ...updated });
      onConfigChange?.(updated);
    }
  }

  const currentSection = SECTIONS[activeSection];
  const sectionFields = FIELDS.filter((f) =>
    currentSection.keys.includes(f.key),
  );

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div>
          <div className="section-label" style={{ marginBottom: 2 }}>
            Strategy Configuration
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {paperTrading
              ? "Paper trading mode — changes take effect immediately"
              : "Live trading mode — changes take effect on next cycle"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn-secondary"
            onClick={handleReset}
            title="Reset all parameters to their startup defaults"
          >
            ↩ Reset to Defaults
          </button>
          <button
            className="btn-primary"
            disabled={!isDirty || saving}
            onClick={handleSave}
            style={{ minWidth: 100 }}
          >
            {saving ? "Saving…" : savedKey ? "✓ Saved" : "Save Changes"}
          </button>
        </div>
      </div>

      {/* Section tabs */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 20,
          borderBottom: "1px solid var(--border)",
          paddingBottom: 0,
        }}
      >
        {SECTIONS.map((s, i) => (
          <button
            key={s.label}
            onClick={() => setActiveSection(i)}
            style={{
              background: "transparent",
              border: "none",
              borderBottom:
                i === activeSection
                  ? "2px solid var(--primary)"
                  : "2px solid transparent",
              color:
                i === activeSection ? "var(--text)" : "var(--text-secondary)",
              cursor: "pointer",
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: i === activeSection ? 600 : 400,
              marginBottom: -1,
              transition: "color 0.15s",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Fields */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {sectionFields.map((field) => {
          const stored = draft[field.key];
          const displayVal = toDisplayValue(field, stored);
          const defDisplayVal = toDisplayValue(field, defaults[field.key]);
          const isDiff = stored !== params[field.key];
          const isDefault = stored === defaults[field.key];

          return (
            <div
              key={String(field.key)}
              onMouseEnter={() => setHoveredKey(String(field.key))}
              onMouseLeave={() => setHoveredKey(null)}
              style={{
                background: isDiff ? "rgba(99,102,241,0.06)" : "transparent",
                borderRadius: 8,
                padding: "12px 14px",
                border: isDiff
                  ? "1px solid rgba(99,102,241,0.25)"
                  : "1px solid transparent",
                transition: "all 0.15s",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <label
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text)",
                  }}
                >
                  {field.label}
                  {!isDefault && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 10,
                        color: "var(--primary)",
                        fontWeight: 400,
                      }}
                    >
                      (default: {field.format(defaults[field.key])})
                    </span>
                  )}
                </label>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: isDiff ? "var(--primary)" : "var(--text)",
                    minWidth: 60,
                    textAlign: "right",
                  }}
                >
                  {field.format(stored)}
                </div>
              </div>

              {/* Slider */}
              <input
                type="range"
                min={field.min}
                max={field.max}
                step={field.step}
                value={displayVal}
                onChange={(e) => setField(field, parseFloat(e.target.value))}
                style={{
                  width: "100%",
                  accentColor: "var(--primary)",
                  cursor: "pointer",
                }}
              />

              {/* Min/max labels + description */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 10,
                  color: "var(--text-secondary)",
                  marginTop: 2,
                }}
              >
                <span>
                  {field.min}
                  {field.unit}
                </span>
                <span>
                  {field.max}
                  {field.unit}
                </span>
              </div>

              {(hoveredKey === String(field.key) || isDiff) && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    marginTop: 6,
                    lineHeight: 1.5,
                  }}
                >
                  {field.description}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {isDirty && (
        <div
          style={{
            marginTop: 16,
            padding: "8px 12px",
            background: "rgba(99,102,241,0.08)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--text-secondary)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>You have unsaved changes.</span>
          <button
            onClick={() => setDraft({ ...params })}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 12,
              textDecoration: "underline",
            }}
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
