// Login (shown when the API returns 401): "Callback" · "Enter your passcode" · Open (§9).
import { html, useState } from "/vendor/preact-htm.js";
import * as api from "../api.js";
import { ERROR_COPY } from "../ui/constants.js";

export function LoginScreen({ onLoggedIn }) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!passcode) return;
    setBusy(true);
    setError("");
    try {
      await api.login(passcode);
      await onLoggedIn();
    } catch (err) {
      setError(err.status === 401 ? "That passcode didn't work. Try again." : ERROR_COPY);
      setBusy(false);
    }
  }

  return html`<main class="login">
    <form class="login-card" onSubmit=${submit}>
      <img class="login-icon" src="/icons/icon-192.png" alt="" width="72" height="72" />
      <h1 class="login-title">Callback</h1>
      <label class="field-label" for="passcode">Enter your passcode</label>
      <input id="passcode" class="input" type="password" autocomplete="current-password" value=${passcode}
        onInput=${(e) => setPasscode(e.currentTarget.value)} autofocus />
      ${error && html`<p class="inline-error" role="alert">${error}</p>`}
      <button type="submit" class="btn btn-primary btn-block" disabled=${busy || !passcode}>Open</button>
    </form>
  </main>`;
}
