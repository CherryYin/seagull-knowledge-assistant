import { useState, type FormEvent } from "react";
import { authApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AUTH_NOTICE_KEY } from "@/lib/authEvents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

type AuthMode = "login" | "register";

function readableError(err: unknown) {
  const message = err instanceof Error ? err.message : "Request failed";
  if (message.includes("pending administrator approval")) {
    return "Your registration is pending administrator approval. Please try again after it is approved.";
  }
  if (message.includes("registration was rejected")) {
    return "Your registration was rejected. Please contact an administrator.";
  }
  if (message.includes("Incorrect username or password")) {
    return "Incorrect username or password.";
  }
  if (message.includes("Username already exists")) {
    return "Username already exists.";
  }
  return message;
}

export function LoginPage() {
  const { login } = useAuth();
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState(() => {
    const notice = sessionStorage.getItem(AUTH_NOTICE_KEY) || "";
    sessionStorage.removeItem(AUTH_NOTICE_KEY);
    return notice;
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);
    try {
      if (mode === "login") {
        await login(username, password);
      } else {
        const res = await authApi.register({
          username,
          display_name: displayName,
          email: email || undefined,
          password,
        });
        setMessage(res.detail || "Registration submitted. After administrator approval, sign in to choose your workspace mode.");
        setMode("login");
        setPassword("");
      }
    } catch (err: unknown) {
      setError(readableError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <img src="/seagull.png" alt="Seagull" className="mb-2 h-16 w-16" />
          <CardTitle className="text-xl">Seagull</CardTitle>
          <p className="text-sm text-muted-foreground">
            {mode === "login" ? "Sign in to your knowledge base" : "Register, wait for approval, then choose your workspace on first sign-in"}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="username" className="text-sm font-medium">Username</label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                autoFocus
                required
              />
            </div>
            {mode === "register" && (
              <>
                <div className="space-y-2">
                  <label htmlFor="displayName" className="text-sm font-medium">Display Name</label>
                  <Input
                    id="displayName"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your name"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="email" className="text-sm font-medium">Email</label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </div>
              </>
            )}
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">Password</label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {message && <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">{message}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (mode === "login" ? "Signing in..." : "Submitting...") : (mode === "login" ? "Sign in" : "Register")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError("");
                setMessage("");
              }}
            >
              {mode === "login" ? "Need an account? Register" : "Already approved? Sign in"}
            </Button>
            {mode === "register" ? (
              <p className="text-center text-xs leading-5 text-muted-foreground">
                Workspace modules are chosen after approval, during your first sign-in.
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
