import { useState } from "react";
import { LoginPage } from "./LoginPage";
import { Dashboard } from "./Dashboard";
import { getSession } from "./auth";

export default function App() {
  const [loggedIn, setLoggedIn] = useState(() => getSession() !== null);

  return loggedIn ? (
    <Dashboard onLoggedOut={() => setLoggedIn(false)} />
  ) : (
    <LoginPage onLoggedIn={() => setLoggedIn(true)} />
  );
}
