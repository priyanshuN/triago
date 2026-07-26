import type {
  CardSummary,
  DecisionsInput,
  DecisionsRecord,
  StoredCard,
} from "../../src/schema";

/** Types come straight from the server's zod schemas — see src/schema.ts. */
export type { CardSummary, DecisionsRecord, StoredCard };

const TOKEN_KEY = "triago.token";

/**
 * `triago open` hands the token over once in the URL fragment (never sent to a
 * server); from then on it lives in localStorage for this origin.
 */
export function bootstrapToken(): string | null {
  const fromHash = /[#&]t=([^&]+)/.exec(location.hash);
  if (fromHash?.[1]) {
    localStorage.setItem(TOKEN_KEY, decodeURIComponent(fromHash[1]));
    history.replaceState(null, "", location.pathname + location.search);
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function headers(): HeadersInit {
  return { authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ""}` };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function req<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(route, {
    ...init,
    headers: { ...headers(), ...(init?.body ? { "content-type": "application/json" } : {}) },
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(typeof data.error === "string" ? data.error : res.statusText, res.status);
  }
  return data as T;
}

export const api = {
  cards: (session?: string) =>
    req<{ cards: CardSummary[] }>(
      `/api/cards${session ? `?session=${encodeURIComponent(session)}` : ""}`,
    ),
  card: (id: string) => req<{ card: StoredCard; decisions: DecisionsRecord | null }>(`/api/cards/${id}`),
  submit: (id: string, body: DecisionsInput) =>
    req<{ decisions: DecisionsRecord; tmux_injected: boolean }>(`/api/cards/${id}/decisions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  openInEditor: (body: { repo?: string; file: string; line?: number }) =>
    req<{ opened: boolean; reason?: string; resolved?: string }>("/api/open", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export type ServerEvent = { type: "card.created" | "card.decided"; id: string };

/**
 * SSE over fetch rather than EventSource: EventSource cannot send an
 * Authorization header, and we do not want the token in a URL.
 */
export function subscribe(
  onEvent: (e: ServerEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  const controller = new AbortController();
  let stopped = false;

  const run = async (): Promise<void> => {
    let backoff = 400;
    while (!stopped) {
      try {
        const res = await fetch("/api/events", { headers: headers(), signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        onStatus(true);
        backoff = 400;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split: number;
          while ((split = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const event = /(?:^|\n)event:\s*(.+)/.exec(frame)?.[1]?.trim();
            const data = /(?:^|\n)data:\s*(.+)/.exec(frame)?.[1]?.trim();
            if (event === "change" && data) onEvent(JSON.parse(data) as ServerEvent);
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      if (stopped) return;
      onStatus(false);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 5000);
    }
  };
  void run();

  return () => {
    stopped = true;
    controller.abort();
  };
}
