import React, { useEffect, useRef, useState } from "react";
import { processAgentMessage } from "../utils/openclaw-agent";
import { useBotConfig, type QuotingParams } from "../hooks/use-bot-config";

const ORCHESTRATOR_URL = "http://localhost:3002";

interface Message {
  id: number;
  from: "user" | "agent";
  text: string;
  ts: Date;
}

let msgId = 0;

// Minimal markdown-ish renderer: bold + line breaks only
function renderMarkdown(text: string) {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const parts = line.split(/\*\*(.+?)\*\*/g);
    return (
      <span key={i}>
        {parts.map((part, j) =>
          j % 2 === 1 ? <strong key={j}>{part}</strong> : part,
        )}
        {i < lines.length - 1 && <br />}
      </span>
    );
  });
}

/** Returns true if the message looks like a config command (handled locally). */
function isConfigCommand(msg: string): boolean {
  const m = msg.toLowerCase().trim();
  return (
    /\breset\b/.test(m) ||
    /\b(help|what can you|how do i|commands?)\b/.test(m) ||
    (/\b(show|current|list|display|get|status)\b/.test(m) &&
      /\b(setting|config|param|spread|market|volume|interval|skew|equity)\b/.test(
        m,
      )) ||
    /\b(aggressive|conservative|balanced|default)\b/.test(m) ||
    /\b(spread|half.?width|quote width|width)\b/.test(m) ||
    /\b(market|num market|number of market|how many market)\b/.test(m) ||
    /\b(volume|vol|min vol|minimum vol)\b/.test(m) ||
    /\b(poll|cycle|interval|frequency|every|requote every|quote every)\b/.test(
      m,
    ) ||
    /\b(skew|inventory|imbalance|one.?side)\b/.test(m) ||
    /\b(re.?quote threshold|drift threshold|move threshold)\b/.test(m) ||
    /\b(equity|paper equity|capital|budget)\b/.test(m)
  );
}

/** Stream a Claude response from the orchestrator /chat endpoint. */
async function streamClaudeResponse(
  botId: number,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  onDelta: (chunk: string) => void,
): Promise<void> {
  const res = await fetch(`${ORCHESTRATOR_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId, messages: history }),
  });

  if (!res.ok || !res.body) {
    onDelta("⚠ Could not reach OpenClaw Agent — is the orchestrator running?");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;
      try {
        const parsed = JSON.parse(payload) as {
          delta?: string;
          error?: string;
        };
        if (parsed.error) {
          onDelta(`⚠ ${parsed.error}`);
          return;
        }
        if (parsed.delta) onDelta(parsed.delta);
      } catch {
        // ignore malformed SSE lines
      }
    }
  }
}

export function OpenClawChat({
  botId,
  onConfigChange,
}: {
  botId?: number;
  onConfigChange?: (params: QuotingParams) => void;
}) {
  const orchestratorMode = botId === undefined;
  const { params, save, reset } = useBotConfig(orchestratorMode ? -1 : botId!);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: msgId++,
      from: "agent",
      ts: new Date(),
      text: orchestratorMode
        ? `Hi! I'm the **OpenClaw Orchestrator**. I have live access to all bots, your full portfolio, and market data.\n\nAsk me anything: **"how are all bots doing?"**, **"which bot is most profitable?"**, **"summarize positions"**, **"what's the market outlook?"**, or **"help"**.`
        : `Hi! I'm the **OpenClaw Agent** for Bot ${botId}. I have live access to your portfolio and positions.\n\nAsk me anything: **"how am I doing?"**, **"which bot is losing money?"**, **"show positions"**, **"set spread to 4 cents"**, or **"help"**.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [minimized, setMinimized] = useState(false);
  const [typing, setTyping] = useState(false);
  // Track conversation history for Claude (user+assistant turns only)
  const claudeHistory = useRef<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!minimized) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, minimized]);

  function pushMessage(from: Message["from"], text: string) {
    setMessages((prev) => [
      ...prev,
      { id: msgId++, from, text, ts: new Date() },
    ]);
  }

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    // In orchestrator mode we don't need params; in bot mode we do
    if (!orchestratorMode && !params) return;
    setInput("");
    pushMessage("user", text);

    // ── Config command: handle locally with pattern matching (bot mode only) ──
    if (!orchestratorMode && isConfigCommand(text)) {
      setTyping(true);
      await new Promise((r) => setTimeout(r, 300));
      setTyping(false);

      const response = processAgentMessage(text, params!);

      if (response.action === "reset") {
        const updated = await reset();
        if (updated) {
          onConfigChange?.(updated);
          pushMessage(
            "agent",
            response.reply +
              "\n\n**Done.** All parameters restored to startup defaults.",
          );
        } else {
          pushMessage("agent", "⚠ Reset failed — is the bot running?");
        }
        return;
      }

      if (response.patch) {
        const updated = await save(response.patch);
        if (updated) {
          onConfigChange?.(updated);
          pushMessage(
            "agent",
            response.reply +
              "\n\n✓ **Saved.** Change takes effect immediately.",
          );
        } else {
          pushMessage(
            "agent",
            "⚠ Could not apply change — is the bot running?",
          );
        }
        return;
      }

      pushMessage("agent", response.reply);
      return;
    }

    // ── Everything else: stream from Claude with live portfolio context ────────
    claudeHistory.current.push({ role: "user", content: text });

    // Create a streaming placeholder message
    const streamId = msgId++;
    setMessages((prev) => [
      ...prev,
      { id: streamId, from: "agent", text: "", ts: new Date() },
    ]);
    setTyping(true);

    let accumulated = "";
    await streamClaudeResponse(botId ?? 0, claudeHistory.current, (chunk) => {
      accumulated += chunk;
      setTyping(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === streamId ? { ...m, text: accumulated } : m)),
      );
    });

    // If nothing came back, show a fallback
    if (!accumulated) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? {
                ...m,
                text: "⚠ No response — check that the orchestrator is running.",
              }
            : m,
        ),
      );
    } else {
      // Save assistant turn to history for follow-up context
      claudeHistory.current.push({ role: "assistant", content: accumulated });
      // Keep history bounded to last 20 turns to avoid token bloat
      if (claudeHistory.current.length > 40) {
        claudeHistory.current = claudeHistory.current.slice(-40);
      }
    }
    setTyping(false);
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div
      style={{
        marginBottom: 24,
        border: "1px solid var(--border)",
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--card)",
      }}
    >
      {/* Header */}
      <div
        onClick={() => setMinimized((m) => !m)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          cursor: "pointer",
          background: "var(--background)",
          borderBottom: minimized ? "none" : "1px solid var(--border)",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
            }}
          >
            🦞
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>OpenClaw Agent</div>
            <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
              AI · live portfolio access
            </div>
          </div>
        </div>
        <span style={{ fontSize: 16, color: "var(--text-secondary)" }}>
          {minimized ? "▲" : "▼"}
        </span>
      </div>

      {!minimized && (
        <>
          {/* Message log */}
          <div
            style={{
              height: 280,
              overflowY: "auto",
              padding: "12px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {messages.map((m) => (
              <div
                key={m.id}
                style={{
                  display: "flex",
                  flexDirection: m.from === "user" ? "row-reverse" : "row",
                  alignItems: "flex-end",
                  gap: 8,
                }}
              >
                {/* avatar */}
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background:
                      m.from === "agent"
                        ? "linear-gradient(135deg, #6366f1, #8b5cf6)"
                        : "var(--border)",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                  }}
                >
                  {m.from === "agent" ? "🦞" : "👤"}
                </div>
                <div
                  style={{
                    maxWidth: "78%",
                    padding: "8px 12px",
                    borderRadius:
                      m.from === "user"
                        ? "12px 12px 2px 12px"
                        : "12px 12px 12px 2px",
                    background:
                      m.from === "user"
                        ? "var(--primary)"
                        : "var(--background)",
                    color: m.from === "user" ? "#fff" : "var(--text)",
                    fontSize: 13,
                    lineHeight: 1.55,
                    border:
                      m.from === "agent" ? "1px solid var(--border)" : "none",
                  }}
                >
                  {renderMarkdown(m.text)}
                </div>
              </div>
            ))}

            {typing && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                  }}
                >
                  🦞
                </div>
                <div
                  style={{
                    padding: "8px 14px",
                    borderRadius: "12px 12px 12px 2px",
                    background: "var(--background)",
                    border: "1px solid var(--border)",
                    fontSize: 18,
                    letterSpacing: 3,
                  }}
                >
                  <span className="typing-dots">···</span>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Suggested prompts */}
          <div
            style={{
              padding: "8px 16px 0",
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            {[
              "show settings",
              "make it aggressive",
              "make it conservative",
              "set spread to 4 cents",
              "quote 3 markets",
              "reset",
            ].map((prompt) => (
              <button
                key={prompt}
                onClick={() => {
                  setInput(prompt);
                  inputRef.current?.focus();
                }}
                style={{
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: 20,
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 11,
                  padding: "3px 10px",
                  transition: "border-color 0.15s, color 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.target as HTMLButtonElement).style.borderColor =
                    "var(--primary)";
                  (e.target as HTMLButtonElement).style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  (e.target as HTMLButtonElement).style.borderColor =
                    "var(--border)";
                  (e.target as HTMLButtonElement).style.color =
                    "var(--text-secondary)";
                }}
              >
                {prompt}
              </button>
            ))}
          </div>

          {/* Input */}
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: "10px 16px 14px",
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder='e.g. "set spread to 5 cents" or "quote 3 markets"'
              disabled={!params}
              style={{
                flex: 1,
                background: "var(--background)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--text)",
                fontSize: 13,
                outline: "none",
                padding: "8px 12px",
              }}
            />
            <button
              className="btn-primary"
              onClick={handleSend}
              disabled={!input.trim() || !params}
              style={{ padding: "8px 16px", minWidth: 70 }}
            >
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}
