import { useCallback, useEffect, useRef, useState } from "react";
import type { DecisionsRecord, StoredCard } from "../../src/schema";
import { ApiError, api, bootstrapToken, clearToken, subscribe, type CardSummary } from "./api";
import { DocCard } from "./DocCard";
import { FindingsCard } from "./FindingsCard";
import { Rail } from "./Rail";
import { useToast } from "./Toast";

const idFromPath = (): string | null => /^\/c\/([A-Za-z0-9]+)/.exec(location.pathname)?.[1] ?? null;

type Detail = { card: StoredCard; decisions: DecisionsRecord | null };

export default function App() {
  const [hasToken, setHasToken] = useState<boolean>(() => Boolean(bootstrapToken()));
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(idFromPath);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [connected, setConnected] = useState(false);
  const { toast, node: toastNode } = useToast();

  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const detailRef = useRef(detail);
  detailRef.current = detail;

  const onAuthError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      setHasToken(false);
      return true;
    }
    return false;
  }, []);

  const navigate = useCallback((id: string) => {
    if (location.pathname !== `/c/${id}`) history.pushState(null, "", `/c/${id}`);
    setCurrentId(id);
  }, []);

  const loadCards = useCallback(async () => {
    try {
      const { cards: next } = await api.cards();
      setCards(next);
      if (!currentIdRef.current && next.length) {
        // newest first: an agent that just posted wants that card on screen
        const open = [...next].reverse().find((c) => c.status === "open");
        navigate((open ?? next.at(-1)!).id);
      }
    } catch (err) {
      if (!onAuthError(err)) setConnected(false);
    }
  }, [navigate, onAuthError]);

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        setDetail(await api.card(id));
      } catch (err) {
        if (onAuthError(err)) return;
        // Old tabs outlive their cards. Rather than sit on an error, fall back to
        // whatever is current — a stale tab becomes a useful one.
        if (err instanceof ApiError && err.status === 404) {
          setDetail(null);
          setCurrentId(null);
          history.replaceState(null, "", "/");
          void loadCards();
          return;
        }
        toast(err instanceof Error ? err.message : "could not load card");
      }
    },
    [loadCards, onAuthError, toast],
  );

  const deleteCard = useCallback(
    async (card: CardSummary) => {
      try {
        // The rail already asked, and said so when the card was still open, so
        // reaching here on an open card is a deliberate answer to that question.
        await api.remove(card.id, card.status === "open");
        if (card.id === currentIdRef.current) {
          setDetail(null);
          setCurrentId(null);
          history.replaceState(null, "", "/");
        }
        await loadCards();
        toast(`deleted ${card.id}`);
      } catch (err) {
        if (onAuthError(err)) return;
        toast(err instanceof Error ? err.message : "could not delete card");
      }
    },
    [loadCards, onAuthError, toast],
  );

  useEffect(() => {
    if (!hasToken) return;
    void loadCards();
  }, [hasToken, loadCards]);

  useEffect(() => {
    if (!hasToken || !currentId) return;
    void loadDetail(currentId);
  }, [hasToken, currentId, loadDetail]);

  useEffect(() => {
    const onPop = (): void => setCurrentId(idFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!hasToken) return;
    return subscribe((event) => {
      void loadCards();
      const current = currentIdRef.current;
      if (event.id === current) {
        void loadDetail(event.id);
        return;
      }
      // Pull a new card into view only when the human is not mid-triage.
      const busy = detailRef.current?.card.status === "open";
      if (event.type === "card.created" && (!current || !busy)) navigate(event.id);
    }, setConnected);
  }, [hasToken, loadCards, loadDetail, navigate]);

  useEffect(() => {
    document.title = detail ? `triago · ${detail.card.title}` : "triago";
  }, [detail]);

  if (!hasToken) {
    return (
      <div className="center">
        <h2>triago needs its token</h2>
        <p>
          Cards can contain source code, so the browser has to prove it belongs to you. Run this in
          the terminal and it opens a tab with the token attached:
        </p>
        <pre>triago open</pre>
      </div>
    );
  }

  const onSubmitted = (record: DecisionsRecord): void => {
    setDetail((prev) =>
      prev ? { card: { ...prev.card, status: "decided" }, decisions: record } : prev,
    );
    void loadCards();
  };

  return (
    <div className="app">
      <Rail
        cards={cards}
        currentId={currentId}
        connected={connected}
        onPick={navigate}
        onDelete={deleteCard}
      />
      <main className="main">
        {!connected && <div className="banner">triago server unreachable — reconnecting…</div>}
        {!detail && (
          <div className="center">
            <h2>{cards.length ? "Pick a card" : "No cards yet"}</h2>
            <p>Cards show up here the moment an agent posts one.</p>
            <pre>triago findings review.json --wait</pre>
          </div>
        )}
        {detail?.card.type === "findings" && (
          <FindingsCard
            key={detail.card.id}
            card={detail.card}
            decisions={detail.decisions}
            onSubmitted={onSubmitted}
            toast={toast}
          />
        )}
        {detail?.card.type === "doc" && (
          <DocCard
            key={detail.card.id}
            card={detail.card}
            decisions={detail.decisions}
            onSubmitted={onSubmitted}
            toast={toast}
          />
        )}
      </main>
      {toastNode}
    </div>
  );
}
