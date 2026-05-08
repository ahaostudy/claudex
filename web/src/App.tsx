import { useEffect } from "react";
import { Navigate, Routes, Route, useLocation } from "react-router-dom";
import { useAuth } from "@/state/auth";
import { LoginScreen } from "@/screens/Login";
import { HomeScreen } from "@/screens/Home";
import { ChatScreen } from "@/screens/Chat";
import { DiffReviewScreen } from "@/screens/DiffReview";
import { SettingsScreen } from "@/screens/Settings";
import { RoutinesScreen } from "@/screens/Routines";
import { QueueScreen } from "@/screens/Queue";
import { AgentsScreen } from "@/screens/Agents";
import { AlertsScreen } from "@/screens/Alerts";
import { UsagePage } from "@/screens/UsagePage";
import { KeyboardHelp } from "@/components/KeyboardHelp";

function Guard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[13px] text-ink-muted mono">
        loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: loc }} />;
  return <>{children}</>;
}

export default function App() {
  const { checkSession } = useAuth();
  useEffect(() => {
    checkSession();
  }, [checkSession]);
  return (
    <>
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/" element={<Navigate to="/sessions" replace />} />
      <Route
        path="/sessions"
        element={
          <Guard>
            <HomeScreen />
          </Guard>
        }
      />
      <Route
        path="/routines"
        element={
          <Guard>
            <RoutinesScreen />
          </Guard>
        }
      />
      <Route
        path="/queue"
        element={
          <Guard>
            <QueueScreen />
          </Guard>
        }
      />
      <Route
        path="/agents"
        element={
          <Guard>
            <AgentsScreen />
          </Guard>
        }
      />
      <Route
        path="/alerts"
        element={
          <Guard>
            <AlertsScreen />
          </Guard>
        }
      />
      <Route
        path="/usage"
        element={
          <Guard>
            <UsagePage />
          </Guard>
        }
      />
      <Route
        path="/session/:id"
        element={
          <Guard>
            <ChatScreen />
          </Guard>
        }
      />
      <Route
        path="/session/:id/diff"
        element={
          <Guard>
            <DiffReviewScreen />
          </Guard>
        }
      />
      <Route
        path="/settings"
        element={
          <Guard>
            <SettingsScreen />
          </Guard>
        }
      />
      <Route path="*" element={<Navigate to="/sessions" replace />} />
    </Routes>
    <KeyboardHelp />
    </>
  );
}
