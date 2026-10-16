import { useState } from "react";
import { useSignIn } from "../api/hooks";
import { ErrorNotice } from "../components/ErrorNotice";

/** Login and registration (the first registered user owns the default project). */
export function AuthPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const signIn = useSignIn(mode);
  return (
    <main className="page narrow" id="main">
      <h1>REA Web</h1>
      <div className="row" role="group" aria-label="Account action">
        <button
          type="button"
          aria-pressed={mode === "login"}
          onClick={() => {
            setMode("login");
            signIn.reset();
          }}
        >
          Log in
        </button>
        <button
          type="button"
          aria-pressed={mode === "register"}
          onClick={() => {
            setMode("register");
            signIn.reset();
          }}
        >
          Register
        </button>
      </div>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          signIn.mutate({
            email,
            password,
            ...(mode === "register" && displayName.trim() !== ""
              ? { displayName: displayName.trim() }
              : {}),
          });
        }}
      >
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={mode === "register" ? 12 : 1}
          />
        </label>
        {mode === "register" && (
          <>
            <p className="muted">Passwords need at least 12 characters.</p>
            <label>
              Display name (optional)
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={120}
              />
            </label>
          </>
        )}
        <button type="submit" disabled={signIn.isPending}>
          {mode === "login" ? "Log in" : "Create account"}
        </button>
        <ErrorNotice error={signIn.error} />
      </form>
    </main>
  );
}
