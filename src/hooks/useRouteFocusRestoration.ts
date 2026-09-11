import { useCallback, useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

const STORAGE_PREFIX = "seagull.route-focus.v1";

export function useRouteFocusRestoration(namespace: string, ready = true) {
  const location = useLocation();
  const storageKey = `${STORAGE_PREFIX}:${namespace}:${location.key}`;

  const rememberFocus = useCallback((focusId: string) => {
    try {
      window.sessionStorage.setItem(storageKey, focusId);
    } catch {
    }
  }, [storageKey]);

  useLayoutEffect(() => {
    if (!ready) return;
    let focusId: string | null = null;
    try {
      focusId = window.sessionStorage.getItem(storageKey);
    } catch {
      focusId = null;
    }
    if (!focusId) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(`[data-route-focus-id="${CSS.escape(focusId!)}"]`);
        target?.focus({ preventScroll: true });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [ready, storageKey]);

  return { rememberFocus };
}
