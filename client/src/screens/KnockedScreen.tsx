import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { LogoIcon } from "../components/xp/Logo";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";

export function KnockedScreen() {
  const setScreen = useGameStore((s) => s.setScreen);
  const messages = useGameStore((s) => s.messages);
  const reason = messages.length > 0 ? messages[messages.length - 1].text : "The fort collapsed.";

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="pillowfort"
        className="auth-window"
        buttons={[{ label: "✕", close: true, onClick: () => setScreen("home") }]}
      >
        <div className="xp-window-body">
          <div className="notice-row">
            <div className="notice-icon-wrap">
              <LogoIcon size={32} />
            </div>
            <div className="notice-text">
              <strong>Fort has been knocked down.</strong>
              <p className="notice-subtext">{reason}</p>
            </div>
          </div>
          <div className="auth-actions">
            <Button id="btn-home" primary onClick={() => setScreen("home")}>
              OK
            </Button>
          </div>
        </div>
      </Window>
    </div>
  );
}
