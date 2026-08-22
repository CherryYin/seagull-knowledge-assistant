import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";
const TOKEN_KEY = "auth_token";

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
  email?: string | null;
  approval_status: string;
  is_active: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  token: string | null;
  isAdmin: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  setUser: (user: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setTokenState] = useState<string | null>(getAuthToken());
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    void fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    clearAuthToken();
    setTokenState(null);
    setUser(null);
  }, []);

  useEffect(() => {
    const currentToken = getAuthToken();
    if (!currentToken) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${currentToken}` },
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error("Unauthorized");
        return res.json();
      })
      .then((data: AuthUser) => {
        if (!cancelled) {
          setUser(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          logout();
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "Login failed");
      throw new Error(text);
    }
    const data = await res.json();
    setAuthToken(data.access_token);
    setTokenState(data.access_token);
  }, []);

  const isAdmin = user?.role === "admin";

  return (
    <AuthContext.Provider value={{ user, loading, token, isAdmin, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
