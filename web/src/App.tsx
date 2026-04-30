import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { ChatPage } from "./pages/ChatPage";
import { SearchPage } from "./pages/SearchPage";
import { NotesPage } from "./pages/NotesPage";
import { NoteDetailPage } from "./pages/NoteDetailPage";
import { SourcesPage } from "./pages/SourcesPage";
import { SourceDetailPage } from "./pages/SourceDetailPage";
import { SkillsPage } from "./pages/SkillsPage";
import { StatsPage } from "./pages/StatsPage";
import { WritingPage } from "./pages/WritingPage";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { AgentProfilesPage } from "./pages/AgentProfilesPage";
import type { ReactNode } from "react";

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading...
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function LoginGuard() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  return <LoginPage />;
}

function AdminRoute({ children }: { children: ReactNode }) {
  const { user, loading, isAdmin } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading...
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginGuard />} />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<ChatPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/notes/:id" element={<NoteDetailPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/sources/:id" element={<SourceDetailPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/profiles" element={<AgentProfilesPage />} />
            <Route path="/writing" element={<WritingPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/admin/users" element={<AdminRoute><AdminUsersPage /></AdminRoute>} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
