import { marked } from "marked";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DecisionsRecord, StoredDocCard } from "../../src/schema";
import { api } from "./api";

/**
 * Cards can quote arbitrary repo content, so rendered markdown is stripped of
 * anything executable before it reaches the DOM. The page's CSP (script-src
 * 'self') is the second line of defence.
 */
function sanitize(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|link|meta|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|link|meta|style)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

export function DocCard({
  card,
  decisions,
  onSubmitted,
  toast,
}: {
  card: StoredDocCard;
  decisions: DecisionsRecord | null;
  onSubmitted: (record: DecisionsRecord) => void;
  toast: (message: string) => void;
}) {
  const [note, setNote] = useState(decisions?.global_comment ?? "");
  const [submitting, setSubmitting] = useState(false);
  const locked = card.status === "decided" || decisions !== null;
  const html = useMemo(
    () => sanitize(marked.parse(card.markdown, { async: false, gfm: true, breaks: false })),
    [card.markdown],
  );

  const noteRef = useRef(note);
  noteRef.current = note;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // ctrl+Enter fires from a listener attached once, so the guard cannot be state.
  const submittingRef = useRef(false);

  const acknowledge = async (): Promise<void> => {
    if (lockedRef.current || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const { decisions: record } = await api.submit(card.id, {
        items: [],
        acknowledged: true,
        ...(noteRef.current.trim() ? { global_comment: noteRef.current.trim() } : {}),
      });
      onSubmitted(record);
      toast("acknowledged — agent resumed");
    } catch (err) {
      toast(err instanceof Error ? err.message : "submit failed");
      submittingRef.current = false;
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void acknowledge();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`card${locked ? " locked" : ""}`}>
      <header className="card-head">
        <span className="card-title" title={card.title}>
          {card.title}
        </span>
        {card.source && <span className="chip">{card.source}</span>}
        <span className="chip">doc</span>
        <span className="spacer" />
        <button
          type="button"
          className={`submit-btn${locked ? "" : " ready"}`}
          onClick={() => void acknowledge()}
          disabled={locked || submitting}
        >
          {locked ? "Acknowledged ✓" : submitting ? "Sending…" : (card.ack_label ?? "Acknowledge")}
        </button>
      </header>

      <div className="doc">
        <div className="md" dangerouslySetInnerHTML={{ __html: html }} />

        {!locked && (
          <div className="global-note">
            <label htmlFor="triago-doc-note">Comment back to the agent (optional)</label>
            <textarea
              id="triago-doc-note"
              value={note}
              placeholder="what to change, what you disagree with…"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}

        {decisions && (
          <div className="returned">
            <div className="r-title">✓ Returned to agent</div>
            <div className="r-sub">
              The blocked <span className="mono">triago wait {card.id}</span> call resolved with this
              payload.
            </div>
            <pre>{JSON.stringify(decisions, null, 2)}</pre>
          </div>
        )}
      </div>

      <div className="keybar">
        <span className="k">
          <kbd>ctrl ⏎</kbd> acknowledge
        </span>
      </div>
    </div>
  );
}
