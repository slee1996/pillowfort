import { useGameStore } from "../stores/gameStore";
import { Button } from "../components/xp/Button";
import { LogoIcon } from "../components/xp/Logo";

export function KnockedScreen() {
  const setScreen = useGameStore((s) => s.setScreen);
  const messages = useGameStore((s) => s.messages);
  const presentation = useGameStore((s) => s.terminalPresentation);
  const reason = messages.length > 0 ? messages[messages.length - 1].text : "Your secure connection ended.";
  const title = presentation === "room-destroyed"
    ? "Fort has been knocked down."
    : presentation === "admission-required"
      ? "Could not enter this fort."
      : "Your connection ended.";

  return (
    <main className="screen entry-screen">
      <section className="entry-card entry-card-ended" aria-labelledby="ended-title">
        <header className="entry-brand"><LogoIcon size={40} /><span>pillowfort</span></header>
        <h1 id="ended-title" className="entry-title">{title}</h1>
        <p className="entry-description">{reason}</p>
        {presentation === "admission-required" && (
          <p className="auth-note">
            Ask the host to watch for your new approval request, then join again. If a game is running, let it finish first.
            This does not mean the fort was knocked down.
          </p>
        )}
        <div className="entry-actions">
          <Button id="btn-home" primary onClick={() => setScreen("home")}>Back to home</Button>
        </div>
      </section>
    </main>
  );
}
