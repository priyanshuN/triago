import { useState } from "react";
import type { CardSummary } from "./api";
import { setTheme, storedTheme, type Theme } from "./theme";

const timeOf = (iso: string): string => iso.slice(11, 16);

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "system", label: "auto" },
  { value: "light", label: "light" },
  { value: "dark", label: "dark" },
];

/** Decided cards shown before the list folds into a "N older" toggle. */
const RECENT_DONE = 5;

export function Rail({
  cards,
  currentId,
  connected,
  onPick,
  onDelete,
}: {
  cards: CardSummary[];
  currentId: string | null;
  connected: boolean;
  onPick: (id: string) => void;
  onDelete: (card: CardSummary) => void;
}) {
  const current = cards.find((c) => c.id === currentId);
  const session = current?.session ?? cards.at(-1)?.session ?? "";
  const [theme, pickTheme] = useState<Theme>(storedTheme);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Newest first, and open cards above decided ones: the rail is a queue of
  // what still wants an answer, not a chronological archive. Everything a card
  // needs from you happens while it is open, so an hours-old decided card has
  // no business sitting above one that is waiting.
  const newestFirst = [...cards].reverse();
  const waiting = newestFirst.filter((c) => c.status === "open");
  const done = newestFirst.filter((c) => c.status !== "open");
  const doneShown = showAll ? done : done.slice(0, RECENT_DONE);
  const hidden = done.length - doneShown.length;

  const waitingOn = waiting.find((c) => c.id === currentId) ?? waiting[0];

  const item = (c: CardSummary) => (
    <div
      key={c.id}
      className={`stream-item${c.id === currentId ? " active" : ""}${
        c.status === "decided" ? " done" : ""
      }`}
    >
      <button type="button" className="stream-pick" onClick={() => onPick(c.id)}>
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

      {confirming === c.id ? (
        <div className="stream-confirm">
          <span>{c.status === "open" ? "still open — delete?" : "delete?"}</span>
          <button
            type="button"
            className="yes"
            onClick={() => {
              setConfirming(null);
              onDelete(c);
            }}
          >
            yes
          </button>
          <button type="button" onClick={() => setConfirming(null)}>
            no
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="stream-x"
          title="delete this card"
          aria-label={`delete ${c.title}`}
          onClick={() => setConfirming(c.id)}
        >
          ×
        </button>
      )}
    </div>
  );

  return (
    <nav className="rail">
      <div className="brand">
        <span className="name">triago</span>
        <span className="sess">{session}</span>
      </div>

      <div className="stream">
        {cards.length === 0 && (
          <div className="stream-meta" style={{ padding: "8px 10px" }}>
            no cards yet
          </div>
        )}

        {waiting.length > 0 && (
          <>
            <div className="rail-label">Waiting</div>
            {waiting.map(item)}
          </>
        )}

        {done.length > 0 && (
          <>
            <div className="rail-label">Done</div>
            {doneShown.map(item)}
            {(hidden > 0 || showAll) && (
              <button type="button" className="stream-more" onClick={() => setShowAll(!showAll)}>
                {showAll ? "show fewer" : `${hidden} older`}
              </button>
            )}
          </>
        )}
      </div>

      <div className="rail-foot">
        {waitingOn ? (
          <>
            agent waiting on <span className="mono">triago wait {waitingOn.id}</span>
            {waiting.length > 1 && ` · ${waiting.length - 1} more`}
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
