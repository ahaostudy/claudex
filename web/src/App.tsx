import { useEffect } from "react";
import { Navigate, Routes, Route, useLocation } from "react-router-dom";
import { useAuth } from "@/state/auth";
import { LoginScreen } from "@/screens/Login";
import { HomeScreen } from "@/screens/Home";
import { ChatScreen } from "@/screens/Chat";

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
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route
        path="/"
        element={
          <Guard>
            <HomeScreen />
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
