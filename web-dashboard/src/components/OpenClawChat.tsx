import React, { useEffect, useRef, useState } from "react";
import { processAgentMessage } from "../utils/openclaw-agent";
import { useBotConfig, type QuotingParams } from "../hooks/use-bot-config";

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

export function OpenClawChat({
  botId,
  onConfigChange,
}: {
  botId: number;
  onConfigChange?: (params: QuotingParams) => void;
}) {
  const { params, save, reset } = useBotConfig(botId);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: msgId++,
      from: "agent",
      ts: new Date(),
      text: `Hi! I'm the **OpenClaw Agent** for Bot ${botId}. I can read and update the market maker's parameters in plain English.\n\nTry: **"show settings"**, **"set spread to 4 cents"**, **"make it aggressive"**, or **"help"**.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [minimized, setMinimized] = useState(false);
  const [typing, setTyping] = useState(false);
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
    if (!text || !params) return;
    setInput("");
    pushMessage("user", text);

    // Simulate a short "thinking" delay so the response feels natural
    setTyping(true);
    await new Promise((r) => setTimeout(r, 400));
    setTyping(false);

    const response = processAgentMessage(text, params);

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
          response.reply + "\n\n✓ **Saved.** Change takes effect immediately.",
        );
      } else {
        pushMessage("agent", "⚠ Could not apply change — is the bot running?");
      }
      return;
    }

    pushMessage("agent", response.reply);
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
              Chat to configure the bot
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
