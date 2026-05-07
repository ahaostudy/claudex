import { Routes, Route } from "react-router-dom";
import { PlaceholderScreen } from "@/screens/Placeholder";

export default function App() {
  return (
    <Routes>
      <Route path="*" element={<PlaceholderScreen />} />
    </Routes>
  );
}
