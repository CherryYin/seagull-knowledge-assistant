import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { ModuleRouteGate } from "./components/ModuleRouteGate";

const LoginPage = lazy(() => import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })));
const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const ChatPage = lazy(() => import("./pages/ChatPage").then((m) => ({ default: m.ChatPage })));
const SearchPage = lazy(() => import("./pages/SearchPage").then((m) => ({ default: m.SearchPage })));
const NotesPage = lazy(() => import("./pages/NotesPage").then((m) => ({ default: m.NotesPage })));
const NoteDetailPage = lazy(() => import("./pages/NoteDetailPage").then((m) => ({ default: m.NoteDetailPage })));
const SourcesPage = lazy(() => import("./pages/SourcesPage").then((m) => ({ default: m.SourcesPage })));
const SourceDetailPage = lazy(() => import("./pages/SourceDetailPage").then((m) => ({ default: m.SourceDetailPage })));
const SkillsPage = lazy(() => import("./pages/SkillsPage").then((m) => ({ default: m.SkillsPage })));
const StatsPage = lazy(() => import("./pages/StatsPage").then((m) => ({ default: m.StatsPage })));
const CalendarPage = lazy(() => import("./pages/CalendarPage").then((m) => ({ default: m.CalendarPage })));
const CompletedTodosPage = lazy(() => import("./pages/CompletedTodosPage").then((m) => ({ default: m.CompletedTodosPage })));
const WritingPage = lazy(() => import("./pages/WritingPage").then((m) => ({ default: m.WritingPage })));
const AssetsPage = lazy(() => import("./pages/AssetsPage").then((m) => ({ default: m.AssetsPage })));
const AssetDetailPage = lazy(() => import("./pages/AssetDetailPage").then((m) => ({ default: m.AssetDetailPage })));
const DigestPage = lazy(() => import("./pages/DigestPage").then((m) => ({ default: m.DigestPage })));
const WikiPage = lazy(() => import("./pages/WikiPage").then((m) => ({ default: m.WikiPage })));
const WikiDetailPage = lazy(() => import("./pages/WikiDetailPage").then((m) => ({ default: m.WikiDetailPage })));
const WikiSuggestionsPage = lazy(() => import("./pages/WikiSuggestionsPage").then((m) => ({ default: m.WikiSuggestionsPage })));
const WikiDiscoveryPage = lazy(() => import("./pages/WikiDiscoveryPage").then((m) => ({ default: m.WikiDiscoveryPage })));
const WikiRulesPage = lazy(() => import("./pages/WikiRulesPage").then((m) => ({ default: m.WikiRulesPage })));
const AdminUsersPage = lazy(() => import("./pages/AdminUsersPage").then((m) => ({ default: m.AdminUsersPage })));
const AgentProfilesPage = lazy(() => import("./pages/AgentProfilesPage").then((m) => ({ default: m.AgentProfilesPage })));
const AgentWorkspacePage = lazy(() => import("./pages/AgentWorkspacePage").then((m) => ({ default: m.AgentWorkspacePage })));
const UserProfilePage = lazy(() => import("./pages/UserProfilePage").then((m) => ({ default: m.UserProfilePage })));
const ConnectorSettingsPage = lazy(() => import("./pages/ConnectorSettingsPage").then((m) => ({ default: m.ConnectorSettingsPage })));
const ApiKeysPage = lazy(() => import("./pages/ApiKeysPage").then((m) => ({ default: m.ApiKeysPage })));
const MemoryTreePage = lazy(() => import("./pages/MemoryTreePage").then((m) => ({ default: m.MemoryTreePage })));
const DiscoverPage = lazy(() => import("./pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage })));
const ReviewPage = lazy(() => import("./pages/ReviewPage").then((m) => ({ default: m.ReviewPage })));
const ReviewSuggestionsPage = lazy(() => import("./pages/ReviewSuggestionsPage").then((m) => ({ default: m.ReviewSuggestionsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const SystemJobsPage = lazy(() => import("./pages/SystemJobsPage").then((m) => ({ default: m.SystemJobsPage })));

function PageLoader() {
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>;
}

function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

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
  return <LazyPage><LoginPage /></LazyPage>;
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
                <ModuleRouteGate>
                  <Layout />
                </ModuleRouteGate>
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<LazyPage><HomePage /></LazyPage>} />
            <Route path="/chat" element={<LazyPage><ChatPage /></LazyPage>} />
            <Route path="/search" element={<LazyPage><SearchPage /></LazyPage>} />
            <Route path="/notes" element={<LazyPage><NotesPage /></LazyPage>} />
            <Route path="/notes/:id" element={<LazyPage><NoteDetailPage /></LazyPage>} />
            <Route path="/sources" element={<LazyPage><SourcesPage /></LazyPage>} />
            <Route path="/sources/:id" element={<LazyPage><SourceDetailPage /></LazyPage>} />
            <Route path="/calendar" element={<LazyPage><CalendarPage /></LazyPage>} />
            <Route path="/completed" element={<LazyPage><CompletedTodosPage /></LazyPage>} />
            <Route path="/completed-todos" element={<Navigate to="/completed" replace />} />
            <Route path="/discover" element={<LazyPage><DiscoverPage /></LazyPage>} />
            <Route path="/review" element={<LazyPage><ReviewPage /></LazyPage>} />
            <Route path="/settings" element={<LazyPage><SettingsPage /></LazyPage>} />
            <Route path="/settings/api-keys" element={<LazyPage><ApiKeysPage /></LazyPage>} />
            <Route path="/settings/connectors" element={<LazyPage><ConnectorSettingsPage /></LazyPage>} />
            <Route path="/settings/skills" element={<LazyPage><SkillsPage /></LazyPage>} />
            <Route path="/settings/agents" element={<LazyPage><AgentProfilesPage /></LazyPage>} />
            <Route path="/settings/workspace" element={<LazyPage><AgentWorkspacePage /></LazyPage>} />
            <Route path="/settings/jobs" element={<LazyPage><SystemJobsPage /></LazyPage>} />
            <Route path="/settings/profile" element={<LazyPage><UserProfilePage /></LazyPage>} />
            <Route path="/skills" element={<Navigate to="/settings/skills" replace />} />
            <Route path="/profiles" element={<Navigate to="/settings/agents" replace />} />
            <Route path="/workspace" element={<Navigate to="/settings/workspace" replace />} />
            <Route path="/profile" element={<Navigate to="/settings/profile" replace />} />
            <Route path="/wiki" element={<LazyPage><WikiPage /></LazyPage>} />
            <Route path="/memory" element={<LazyPage><MemoryTreePage /></LazyPage>} />
            <Route path="/wiki/:id" element={<LazyPage><WikiDetailPage /></LazyPage>} />
            <Route path="/review/digest" element={<LazyPage><DigestPage /></LazyPage>} />
            <Route path="/documents" element={<LazyPage><WritingPage /></LazyPage>} />
            <Route path="/assets" element={<LazyPage><AssetsPage /></LazyPage>} />
            <Route path="/assets/:id" element={<LazyPage><AssetDetailPage /></LazyPage>} />
            <Route path="/review/wiki-suggestions" element={<LazyPage><WikiSuggestionsPage /></LazyPage>} />
            <Route path="/wiki/discovery" element={<LazyPage><WikiDiscoveryPage /></LazyPage>} />
            <Route path="/review/suggestions" element={<LazyPage><ReviewSuggestionsPage /></LazyPage>} />
            <Route path="/wiki/rules" element={<LazyPage><WikiRulesPage /></LazyPage>} />
            <Route path="/wiki/digest" element={<Navigate to="/review/digest" replace />} />
            <Route path="/wiki/writing" element={<Navigate to="/documents" replace />} />
            <Route path="/wiki/suggestions" element={<Navigate to="/review/wiki-suggestions" replace />} />
            <Route path="/review/wiki-discovery" element={<Navigate to="/wiki/discovery" replace />} />
            <Route path="/writing" element={<Navigate to="/documents" replace />} />
            <Route path="/digest" element={<Navigate to="/review/digest" replace />} />
            <Route path="/stats" element={<LazyPage><StatsPage /></LazyPage>} />
            <Route path="/admin/users" element={<AdminRoute><LazyPage><AdminUsersPage /></LazyPage></AdminRoute>} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
