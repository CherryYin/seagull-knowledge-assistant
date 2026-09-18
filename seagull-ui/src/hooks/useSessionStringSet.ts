import { useEffect, useState } from "react";

export function useSessionStringSet(storageKey: string) {
  const [values, setValues] = useState<Set<string>>(() => {
    try {
      const stored = window.sessionStorage.getItem(storageKey);
      const parsed = stored ? JSON.parse(stored) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify([...values]));
    } catch {
    }
  }, [storageKey, values]);

  return [values, setValues] as const;
}
