/**
 * AnalysisModal — fetches a bot's trade analysis markdown from the orchestrator
 * and renders it in a styled modal. Content is generated automatically when
 * trades close and appended to bots_analysis/{slug}.md at the repo root.
 */

import React from "react";

// ── Inline markdown renderer ──────────────────────────────────────────────────

function inlineRender(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={idx}
          style={{
            background: "rgba(255,255,255,0.08)",
            padding: "1px 5px",
            borderRadius: 4,
            fontSize: "0.88em",
            fontFamily: "monospace",
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

function renderMarkdown(md: string): React.ReactNode[] {
  const lines = md.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  let inList = false;
  let listItems: React.ReactNode[] = [];

  function flushList() {
    if (inList && listItems.length > 0) {
      nodes.push(
        <ul
          key={key++}
          style={{ margin: "0 0 12px 16px", padding: 0, listStyle: "disc" }}
        >
          {listItems}
        </ul>,
      );
      listItems = [];
      inList = false;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // ── Code block ────────────────────────────────────────────────────────────
    if (line.startsWith("```")) {
      flushList();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      nodes.push(
        <pre
          key={key++}
          style={{
            background: "rgba(0,0,0,0.5)",
            border: "1px solid var(--border)",
            padding: "12px 16px",
            borderRadius: 8,
            overflow: "auto",
            fontSize: 12,
            lineHeight: 1.7,
            margin: "0 0 14px",
            fontFamily: "monospace",
          }}
        >
          {codeLines.join("\n")}
        </pre>,
      );
      continue;
    }

    // ── Table ─────────────────────────────────────────────────────────────────
    if (line.startsWith("|")) {
      flushList();
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const rows = tableLines.filter((l) => !/^\|[\s|:-]+\|$/.test(l.trim()));
      nodes.push(
        <table
          key={key++}
          style={{
            width: "100%",
            borderCollapse: "collapse",
            margin: "0 0 14px",
            fontSize: 13,
          }}
        >
          <tbody>
            {rows.map((row, ri) => {
              const cells = row
                .split("|")
                .filter((_, ci, arr) => ci > 0 && ci < arr.length - 1);
              const isHeader = ri === 0;
              return (
                <tr
                  key={ri}
                  style={{
                    background: isHeader
                      ? "rgba(255,255,255,0.04)"
                      : "transparent",
                  }}
                >
                  {cells.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{
                        padding: "7px 12px",
                        borderBottom: "1px solid var(--border)",
                        verticalAlign: "top",
                        fontWeight: isHeader ? 700 : 400,
                        fontSize: isHeader ? 11 : 13,
                        textTransform: isHeader ? "uppercase" : "none",
                        letterSpacing: isHeader ? "0.04em" : 0,
                        color: isHeader
                          ? "var(--text-secondary)"
                          : "var(--text)",
                      }}
                    >
                      {inlineRender(cell.trim())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>,
      );
      continue;
    }

    // ── Headings ──────────────────────────────────────────────────────────────
    if (line.startsWith("# ")) {
      flushList();
      nodes.push(
        <h1
          key={key++}
          style={{
            fontSize: 20,
            fontWeight: 800,
            margin: "0 0 16px",
            color: "var(--text)",
            letterSpacing: "-0.02em",
          }}
        >
          {inlineRender(line.slice(2))}
        </h1>,
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      nodes.push(
        <h2
          key={key++}
          style={{
            fontSize: 17,
            fontWeight: 700,
            margin: "20px 0 10px",
            color: "var(--text)",
          }}
        >
          {inlineRender(line.slice(3))}
        </h2>,
      );
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      nodes.push(
        <h3
          key={key++}
          style={{
            fontSize: 14,
            fontWeight: 700,
            margin: "14px 0 6px",
            color: "var(--text)",
          }}
        >
          {inlineRender(line.slice(4))}
        </h3>,
      );
      i++;
      continue;
    }

    // ── HR ────────────────────────────────────────────────────────────────────
    if (line.trim() === "---") {
      flushList();
      nodes.push(
        <hr
          key={key++}
          style={{
            border: "none",
            borderTop: "1px solid var(--border)",
            margin: "16px 0",
          }}
        />,
      );
      i++;
      continue;
    }

    // ── List item ─────────────────────────────────────────────────────────────
    if (line.startsWith("- ")) {
      inList = true;
      listItems.push(
        <li key={key++} style={{ marginBottom: 4, lineHeight: 1.6 }}>
          {inlineRender(line.slice(2))}
        </li>,
      );
      i++;
      continue;
    }

    // ── Empty line ────────────────────────────────────────────────────────────
    if (line.trim() === "") {
      flushList();
      i++;
      continue;
    }

    // ── Regular paragraph ─────────────────────────────────────────────────────
    flushList();
    nodes.push(
      <p key={key++} style={{ margin: "0 0 8px", lineHeight: 1.65 }}>
        {inlineRender(line)}
      </p>,
    );
    i++;
  }

  flushList();
  return nodes;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  botId: number;
  botName: string;
  onClose: () => void;
}

export function AnalysisModal({ botId, botName, onClose }: Props) {
  const [content, setContent] = React.useState<string | null>(null);

  // Fetch bot analysis from orchestrator on open
  React.useEffect(() => {
    fetch(`/api/orchestrator/analysis/${botId}`)
      .then((r) => r.text())
      .then(setContent)
      .catch(() =>
        setContent(
          "# No analysis yet\nNo trades have been recorded for this bot.",
        ),
      );
  }, [botId]);

  // Close on Escape
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.82)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--surface)",
          borderRadius: 12,
          width: "min(860px, 100%)",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 24px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
            background: "var(--surface)",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 16 }}>
            📊 {botName} — Analysis
          </span>
          <button className="btn-secondary" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {/* Scrollable content */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "20px 28px 28px",
            fontSize: 13,
            color: "var(--text)",
            lineHeight: 1.6,
          }}
        >
          {content === null ? (
            <p style={{ color: "var(--text-secondary)" }}>Loading…</p>
          ) : (
            renderMarkdown(content)
          )}
        </div>
      </div>
    </div>
  );
}
