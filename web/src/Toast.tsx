import { type ReactElement, useCallback, useRef, useState } from "react";

export function useToast(): { toast: (message: string) => void; node: ReactElement } {
  const [message, setMessage] = useState("");
  const [shown, setShown] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const toast = useCallback((next: string) => {
    setMessage(next);
    setShown(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(false), 2400);
  }, []);

  return {
    toast,
    node: (
      <div className={`toast${shown ? " show" : ""}`} role="status" aria-live="polite">
        {message}
      </div>
    ),
  };
}
