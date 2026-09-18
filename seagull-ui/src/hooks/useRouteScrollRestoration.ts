import { useCallback, useLayoutEffect, useRef, type UIEvent } from "react";
import { useLocation } from "react-router-dom";

const STORAGE_PREFIX = "seagull.route-scroll.v1";

function readScrollTop(storageKey: string) {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { scrollTop?: unknown };
    return typeof parsed.scrollTop === "number" && parsed.scrollTop >= 0 ? parsed.scrollTop : 0;
  } catch {
    return 0;
  }
}

function hasStoredScrollPosition(storageKey: string) {
  try {
    return window.sessionStorage.getItem(storageKey) !== null;
  } catch {
    return false;
  }
}

function writeScrollTop(storageKey: string, scrollTop: number) {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify({ scrollTop }));
  } catch {
  }
}

export function useRouteScrollRestoration<T extends HTMLElement>(namespace: string, ready = true) {
  const location = useLocation();
  const scrollRef = useRef<T>(null);
  const restoredKeyRef = useRef<string | null>(null);
  const storageKey = `${STORAGE_PREFIX}:${namespace}:${location.key}`;
  const hasStoredScroll = hasStoredScrollPosition(storageKey);

  useLayoutEffect(() => {
    if (!ready || restoredKeyRef.current === storageKey) return;
    const scrollTop = readScrollTop(storageKey);
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollTop;
        restoredKeyRef.current = storageKey;
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [ready, storageKey]);

  const onScroll = useCallback((event: UIEvent<T>) => {
    writeScrollTop(storageKey, event.currentTarget.scrollTop);
  }, [storageKey]);

  return { scrollRef, onScroll, hasStoredScroll };
}
