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
        className="w-[340px] max-w-full relative z-[1]"
        buttons={[{ label: "✕", close: true, onClick: () => setScreen("home") }]}
      >
        <div className="xp-window-body">
          <div className="flex items-start gap-3.5 mb-4">
            <div className="w-8 h-8 shrink-0 flex items-center justify-center">
              <LogoIcon size={32} />
            </div>
            <div className="text-xs leading-relaxed text-[#333]">
              <strong>Fort has been knocked down.</strong>
              <p className="text-[#666] text-[11px] mt-1.5">{reason}</p>
            </div>
          </div>
          <div className="flex gap-2 mt-3 justify-center">
            <Button id="btn-home" primary onClick={() => setScreen("home")}>
              OK
            </Button>
          </div>
        </div>
      </Window>
    </div>
  );
}
