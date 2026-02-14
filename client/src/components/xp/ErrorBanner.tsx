import { useGameStore } from "../../stores/gameStore";

export function ErrorBanner() {
  const errorMessage = useGameStore((s) => s.errorMessage);

  if (!errorMessage) return null;

  return <div className="error-banner">{errorMessage}</div>;
}
