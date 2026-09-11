import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

export function useReturnNavigation(fallback: string, preferHistory: boolean) {
  const navigate = useNavigate();

  return useCallback(() => {
    const historyIndex = window.history.state?.idx;
    if (preferHistory && typeof historyIndex === "number" && historyIndex > 0) {
      navigate(-1);
      return;
    }
    navigate(fallback, { replace: true });
  }, [fallback, navigate, preferHistory]);
}
