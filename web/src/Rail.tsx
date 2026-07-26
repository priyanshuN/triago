import { useState } from "react";
import type { CardSummary } from "./api";
import { setTheme, storedTheme, type Theme } from "./theme";

const timeOf = (iso: string): string => iso.slice(11, 16);

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "system", label: "auto" },
  { value: "light", label: "light" },
  { value: "dark", label: "dark" },
];

export function Rail({
  cards,
  currentId,
  connected,
  onPick,
}: {
  cards: CardSummary[];
  currentId: string | null;
  connected: boolean;
  onPick: (id: string) => void;
}) {
  const current = cards.find((c) => c.id === currentId);
  const session = current?.session ?? cards.at(-1)?.session ?? "";
  const waiting = cards.filter((c) => c.status === "open");
  const [theme, pickTheme] = useState<Theme>(storedTheme);

  return (
    <nav className="rail">
      <div className="brand">
        <span className="name">triago</span>
        <span className="sess">{session}</span>
      </div>
      <div className="rail-label">Session cards</div>
      <div className="stream">
        {cards.length === 0 && (
          <div className="stream-meta" style={{ padding: "8px 10px" }}>
            no cards yet
          </div>
        )}
        {cards.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`stream-item${c.id === currentId ? " active" : ""}${
              c.status === "decided" ? " done" : ""
            }`}
            onClick={() => onPick(c.id)}
          >
            <span className="stream-dot" />
            <div>
              <div className="stream-title">{c.title}</div>
              <div className="stream-meta">
                {c.type} ·{" "}
                {c.status === "decided" ? (
                  <>
                    decided <span className="mono">{timeOf(c.decided_at ?? c.created_at)}</span>
                  </>
                ) : (
                  <span className="mono">
                    {c.open_items} open · {timeOf(c.created_at)}
                  </span>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="rail-foot">
        {waiting.length > 0 ? (
          <>
            agent waiting on <span className="mono">triago wait {waiting[0]!.id}</span>
            <br />
          </>
        ) : (
          <>
            nothing waiting
            <br />
          </>
        )}
        {connected ? (
          <span className="mono">live · :5599</span>
        ) : (
          <span className="off mono">server offline — retrying</span>
        )}
        <div className="theme-seg" role="group" aria-label="Colour theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`seg${theme === t.value ? " on" : ""}`}
              aria-pressed={theme === t.value}
              onClick={() => {
                setTheme(t.value);
                pickTheme(t.value);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
