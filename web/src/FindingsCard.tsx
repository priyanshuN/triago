import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Decision, DecisionsRecord, StoredFinding, StoredFindingsCard } from "../../src/schema";
import { api } from "./api";

const SEV_ORDER = ["critical", "high", "medium", "low", "info"] as const;
const SEV_META: Record<string, { label: string; cls: string; color: string }> = {
  critical: { label: "Critical", cls: "g-crit", color: "var(--sev-crit)" },
  high: { label: "High", cls: "g-high", color: "var(--sev-high)" },
  medium: { label: "Medium", cls: "g-med", color: "var(--sev-med)" },
  low: { label: "Low", cls: "g-low", color: "var(--sev-low)" },
  info: { label: "Info", cls: "g-info", color: "var(--sev-low)" },
};

type Draft = { decision: Decision | null; comment: string };

/** Decision order in the action bar, with the key that triggers each one. */
const DECISION_KEYS: Record<Decision, string> = {
  fix: "f",
  skip: "s",
  discuss: "d",
  defer: "t",
};
const DECISION_ORDER = Object.keys(DECISION_KEYS) as Decision[];
type Group = { key: string; label: string | null; cls: string; items: StoredFinding[] };

function buildGroups(card: StoredFindingsCard): Group[] {
  if (card.group_by === "none") {
    return [{ key: "all", label: null, cls: "g-plain", items: card.findings }];
  }
  if (card.group_by === "repo") {
    const byRepo = new Map<string, StoredFinding[]>();
    for (const f of card.findings) {
      const key = f.repo ?? "unattributed";
      byRepo.set(key, [...(byRepo.get(key) ?? []), f]);
    }
    return [...byRepo.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, items]) => ({
        key,
        label: key,
        cls: "g-plain",
        items: [...items].sort(
          (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity),
        ),
      }));
  }
  return SEV_ORDER.map((sev) => ({
    key: sev,
    label: SEV_META[sev]!.label,
    cls: SEV_META[sev]!.cls,
    items: card.findings.filter((f) => f.severity === sev),
  })).filter((g) => g.items.length > 0);
}

function initialDraft(card: StoredFindingsCard, decisions: DecisionsRecord | null): Record<string, Draft> {
  const decided = new Map((decisions?.items ?? []).map((i) => [i.id, i]));
  return Object.fromEntries(
    card.findings.map((f) => [
      f.id,
      { decision: decided.get(f.id)?.decision ?? null, comment: decided.get(f.id)?.comment ?? "" },
    ]),
  );
}

function FixBlock({ text }: { text: string }) {
  const lines = text.replace(/\n+$/, "").split("\n");
  const isDiff = lines.some((l) => /^[+-]/.test(l));
  return (
    <pre className="diff">
      {lines.map((line, i) => (
        <div
          key={i}
          className={
            isDiff ? (line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx") : "ctx"
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

export function FindingsCard({
  card,
  decisions,
  onSubmitted,
  toast,
}: {
  card: StoredFindingsCard;
  decisions: DecisionsRecord | null;
  onSubmitted: (record: DecisionsRecord) => void;
  toast: (message: string) => void;
}) {
  const groups = useMemo(() => buildGroups(card), [card]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const [draft, setDraft] = useState<Record<string, Draft>>(() => initialDraft(card, decisions));
  const [focus, setFocus] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState(decisions?.global_comment ?? "");
  const [submitting, setSubmitting] = useState(false);
  const locked = card.status === "decided" || decisions !== null;
  // The keydown listener is attached once, so its captured `submitting` would be
  // stale: a fast double ctrl+Enter must not send the decisions twice.
  const submittingRef = useRef(false);

  // Handlers run from a window-level key listener, so they read live values
  // through refs instead of closing over a stale render.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const noteRef = useRef(note);
  noteRef.current = note;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  const commentRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const returnedRef = useRef<HTMLDivElement | null>(null);
  const [typing, setTyping] = useState(false);

  const counts = useMemo(() => {
    const c = { fix: 0, skip: 0, discuss: 0, defer: 0, undecided: 0 };
    for (const f of card.findings) {
      const d = draft[f.id]?.decision;
      if (d) c[d]++;
      else c.undecided++;
    }
    return c;
  }, [card.findings, draft]);

  /**
   * Keep the focused row properly in view — including after it expands, which is
   * when a row near the bottom of the list would otherwise open off-screen.
   * `block: "nearest"` alone is not enough there: it stops as soon as the row's
   * edge is visible, leaving the detail below the fold.
   */
  useEffect(() => {
    const row = rowRefs.current[focus];
    const list = row?.closest(".list");
    if (!row) return;
    if (!list) {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    const r = row.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    const fitsWhole = r.height <= l.height - 24;
    const above = r.top < l.top + 8;
    const below = r.bottom > l.bottom - 8;
    if (above || (below && !fitsWhole)) {
      row.scrollIntoView({ block: "start", behavior: "smooth" });
    } else if (below) {
      row.scrollIntoView({ block: "end", behavior: "smooth" });
    }
  }, [focus, expanded]);

  useEffect(() => {
    if (decisions) returnedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [decisions]);

  const decide = (id: string, decision: Decision): void => {
    if (lockedRef.current) return;
    const current = draftRef.current;
    const next = current[id]?.decision === decision ? null : decision;
    const updated = { ...current, [id]: { comment: current[id]?.comment ?? "", decision: next } };
    setDraft(updated);
    if (!next) return;
    // Inbox behaviour: land on the next thing that still needs a call.
    const from = flat.findIndex((f) => f.id === id);
    for (let i = from + 1; i < flat.length; i++) {
      if (!updated[flat[i]!.id]?.decision) {
        setFocus(i);
        return;
      }
    }
  };

  const clear = (id: string): void => {
    if (lockedRef.current) return;
    const current = draftRef.current;
    setDraft({ ...current, [id]: { comment: current[id]?.comment ?? "", decision: null } });
  };

  const setComment = (id: string, comment: string): void => {
    const current = draftRef.current;
    setDraft({ ...current, [id]: { decision: current[id]?.decision ?? null, comment } });
  };

  const toggle = (id: string): void => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const openComment = (id: string): void => {
    setExpanded((prev) => ({ ...prev, [id]: true }));
    window.setTimeout(() => commentRefs.current[id]?.focus(), 30);
  };

  const move = (delta: number): void => {
    setFocus((current) => Math.min(flat.length - 1, Math.max(0, current + delta)));
  };

  /**
   * Typing in a comment swallows the global keys, so the comment box carries its
   * own exits: Esc drops back to the list, Tab/Alt+j/k move on without a detour
   * through the mouse. (Ctrl+j is Chrome's Downloads shortcut, so it is not used.)
   */
  const onCommentKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Escape") {
      e.currentTarget.blur();
      return;
    }
    const arrowKey = e.altKey && (e.key === "j" || e.key === "k");
    if (e.key === "Tab" || arrowKey) {
      e.preventDefault();
      e.currentTarget.blur();
      move(e.shiftKey || e.key === "k" ? -1 : 1);
    }
  };

  const restToSkip = (): void => {
    const current = draftRef.current;
    const updated = { ...current };
    for (const f of card.findings) {
      if (!updated[f.id]?.decision) {
        updated[f.id] = { comment: updated[f.id]?.comment ?? "", decision: "skip" };
      }
    }
    setDraft(updated);
  };

  const submit = async (): Promise<void> => {
    if (lockedRef.current || submittingRef.current) return;
    const current = draftRef.current;
    const undecided = card.findings.filter((f) => !current[f.id]?.decision);
    if (undecided.length) {
      toast(`${undecided.length} finding${undecided.length === 1 ? "" : "s"} still undecided`);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const { decisions: record, tmux_injected } = await api.submit(card.id, {
        items: card.findings.map((f) => ({
          id: f.id,
          decision: current[f.id]!.decision!,
          ...(current[f.id]!.comment.trim() ? { comment: current[f.id]!.comment.trim() } : {}),
        })),
        ...(noteRef.current.trim() ? { global_comment: noteRef.current.trim() } : {}),
      });
      onSubmitted(record);
      toast(tmux_injected ? "decisions returned — agent poked in tmux" : "decisions returned — agent resumed");
    } catch (err) {
      toast(err instanceof Error ? err.message : "submit failed");
      submittingRef.current = false;
    } finally {
      setSubmitting(false);
    }
  };

  const openFile = async (finding: StoredFinding): Promise<void> => {
    if (!finding.file) return;
    try {
      const result = await api.openInEditor({
        ...(finding.repo ? { repo: finding.repo } : {}),
        file: finding.file,
        ...(finding.line !== undefined ? { line: finding.line } : {}),
      });
      toast(result.opened ? `opened ${finding.file}` : (result.reason ?? "could not open"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "could not open");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submit();
        return;
      }
      if (typing) {
        if (e.key === "Escape") target?.blur();
        return;
      }
      if (lockedRef.current) return;
      const index = focusRef.current;
      const finding = flat[index];
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          move(1);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          break;
        case "Enter":
        case "o":
          if (finding) {
            e.preventDefault();
            toggle(finding.id);
          }
          break;
        case "f":
          if (finding) decide(finding.id, "fix");
          break;
        case "s":
          if (finding) decide(finding.id, "skip");
          break;
        case "d":
          if (finding) decide(finding.id, "discuss");
          break;
        case "t":
          if (finding) decide(finding.id, "defer");
          break;
        case "u":
          if (finding) clear(finding.id);
          break;
        case "c":
          if (finding) {
            e.preventDefault();
            openComment(finding.id);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat]);

  const ready = counts.undecided === 0 && !locked;
  let rowIndex = -1;

  return (
    <div className={`card${locked ? " locked" : ""}`}>
      <header className="card-head">
        <span className="card-title" title={card.title}>
          {card.title}
        </span>
        {card.source && <span className="chip">{card.source}</span>}
        <span className="chip">{card.findings.length} findings</span>
        <span className="spacer" />
        <div className="tally">
          {!locked && <span className="t t-und">{counts.undecided} undecided</span>}
          <span className="t t-fix">{counts.fix} fix</span>
          <span className="t t-skip">{counts.skip} skip</span>
          <span className="t t-disc">{counts.discuss} discuss</span>
          <span className="t t-defer">{counts.defer} defer</span>
        </div>
        {!locked && counts.undecided > 0 && counts.undecided < card.findings.length && (
          <button type="button" className="mark-rest" onClick={restToSkip}>
            rest → skip
          </button>
        )}
        <button
          type="button"
          className={`submit-btn${ready ? " ready" : ""}`}
          onClick={() => void submit()}
          disabled={!ready || submitting}
        >
          {locked
            ? "Submitted ✓"
            : counts.undecided === 0
              ? submitting
                ? "Submitting…"
                : "Submit decisions"
              : `Submit — ${counts.undecided} undecided`}
        </button>
      </header>

      <div className="list">
        {groups.map((group) => (
          <div key={group.key}>
            {group.label && (
              <div className={`group-head ${group.cls}`}>
                <span>{group.label}</span>
                <span className="rule" />
                <span className="cnt">{group.items.length}</span>
              </div>
            )}
            {group.items.map((finding) => {
              rowIndex++;
              const index = rowIndex;
              const state = draft[finding.id];
              const decision = state?.decision ?? null;
              const isOpen = Boolean(expanded[finding.id]);
              const short = finding.file?.split("/").at(-1);
              return (
                <article
                  key={finding.id}
                  ref={(el) => {
                    rowRefs.current[index] = el;
                  }}
                  className={`row${index === focus ? " focused" : ""}${
                    decision ? ` decided-${decision}` : ""
                  }`}
                  style={{ ["--sev" as string]: SEV_META[finding.severity]?.color }}
                >
                  <div
                    className="row-line"
                    onClick={() => {
                      setFocus(index);
                      toggle(finding.id);
                    }}
                  >
                    <div className="row-summary">
                      <span className="txt" title={finding.summary}>
                        {finding.summary}
                      </span>
                      {short && (
                        <button
                          type="button"
                          className="floc"
                          title={`${finding.file}${finding.line ? `:${finding.line}` : ""} — open in editor`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void openFile(finding);
                          }}
                        >
                          {short}
                          {finding.line ? `:${finding.line}` : ""}
                        </button>
                      )}
                    </div>
                    <div className="row-right">
                      {finding.verdict && <span className="verdict">{finding.verdict}</span>}
                      <span className={`state${decision ? ` s-${decision}` : ""}`}>
                        {decision ? decision.toUpperCase() : "—"}
                      </span>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="row-detail">
                      {(finding.repo ?? finding.category ?? finding.reviewer ?? finding.pr) && (
                        <div className="meta-row">
                          {finding.repo && <span>{finding.repo}</span>}
                          {finding.category && <span>{finding.category}</span>}
                          {finding.reviewer && <span>@{finding.reviewer}</span>}
                          {finding.pr && <span>{finding.pr}</span>}
                          {finding.comment_url && (
                            <a href={finding.comment_url} target="_blank" rel="noreferrer noopener">
                              comment ↗
                            </a>
                          )}
                        </div>
                      )}
                      {finding.body && (
                        <>
                          <div className="d-label">Detail</div>
                          <p>{finding.body}</p>
                        </>
                      )}
                      {finding.failure_scenario && (
                        <>
                          <div className="d-label">Failure scenario</div>
                          <p className="scenario">{finding.failure_scenario}</p>
                        </>
                      )}
                      {finding.proposed_action && (
                        <>
                          <div className="d-label">Proposed action</div>
                          <p className="scenario">{finding.proposed_action}</p>
                        </>
                      )}
                      {finding.suggested_fix && (
                        <>
                          <div className="d-label">Suggested fix</div>
                          <FixBlock text={finding.suggested_fix} />
                        </>
                      )}
                      <div className="act-bar">
                        {DECISION_ORDER.map((d) => (
                          <button
                            key={d}
                            type="button"
                            className={`act act-${d}${decision === d ? " on" : ""}`}
                            disabled={locked}
                            onClick={(e) => {
                              e.stopPropagation();
                              decide(finding.id, d);
                            }}
                          >
                            {d[0]!.toUpperCase() + d.slice(1)}
                            <kbd>{DECISION_KEYS[d]}</kbd>
                          </button>
                        ))}
                      </div>
                      {!(locked && !state?.comment) && (
                        <div className="comment-row">
                          <textarea
                            className="comment"
                            rows={3}
                            placeholder="note to the agent — what to do instead, why this is a skip, which ticket it belongs to…"
                            value={state?.comment ?? ""}
                            disabled={locked}
                            ref={(el) => {
                              commentRefs.current[finding.id] = el;
                            }}
                            onChange={(e) => setComment(finding.id, e.target.value)}
                            onKeyDown={onCommentKey}
                            onFocus={() => setTyping(true)}
                            onBlur={() => setTyping(false)}
                          />
                          {!locked && (
                            <div className="comment-hint">
                              <span>
                                <kbd>esc</kbd>back to the list
                              </span>
                              <span>
                                <kbd>tab</kbd>next finding
                              </span>
                              <span>
                                <kbd>alt j</kbd>
                                <kbd>alt k</kbd>next / previous
                              </span>
                              <span>
                                <kbd>ctrl ⏎</kbd>submit the card
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ))}

        {!locked && (
          <div className="global-note">
            <label htmlFor="triago-note">Note to the agent (optional)</label>
            <textarea
              id="triago-note"
              value={note}
              placeholder="anything that applies to the whole review…"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}

        {decisions && (
          <div className="returned" ref={returnedRef}>
            <div className="r-title">✓ Decisions returned to agent</div>
            <div className="r-sub">
              The blocked <span className="mono">triago wait {card.id}</span> call resolved with this
              payload.
            </div>
            <pre>{JSON.stringify(decisions, null, 2)}</pre>
          </div>
        )}
      </div>

      <div className="keybar">
        {typing ? (
          <>
            <span className="k">typing a comment —</span>
            <span className="k">
              <kbd>esc</kbd> back to the list
            </span>
            <span className="k">
              <kbd>tab</kbd> next finding
            </span>
            <span className="k">
              <kbd>alt j</kbd>
              <kbd>alt k</kbd> move
            </span>
            <span className="k">
              <kbd>ctrl ⏎</kbd> submit
            </span>
          </>
        ) : (
          <>
            <span className="k">
              <kbd>j</kbd>
              <kbd>k</kbd> navigate
            </span>
            <span className="k">
              <kbd>⏎</kbd> expand
            </span>
            <span className="k">
              <kbd>f</kbd> fix
            </span>
            <span className="k">
              <kbd>s</kbd> skip
            </span>
            <span className="k">
              <kbd>d</kbd> discuss
            </span>
            <span className="k">
              <kbd>t</kbd> defer
            </span>
            <span className="k">
              <kbd>c</kbd> comment
            </span>
            <span className="k">
              <kbd>u</kbd> undo
            </span>
            <span className="k">
              <kbd>ctrl ⏎</kbd> submit
            </span>
          </>
        )}
      </div>
    </div>
  );
}
