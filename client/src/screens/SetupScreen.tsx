import { useRef } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { connect, send } from "../services/ws";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";

function generateRoomId(): string {
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const c = "bcdfghjklmnprstvwz0123456789";
  const v = "o0ua";
  const all = "abcdefghijklmnopqrstuvwxyz0123456789";
  const soft = "rln";
  const hard = "xksz";
  const [a, b] = Math.random() < 0.5 ? [soft, hard] : [hard, soft];
  return pick(c) + pick(v) + pick(a) + pick(c) + pick(v) + pick(b) + pick(all) + pick(all);
}

export function SetupScreen() {
  const name = useGameStore((s) => s.name);
  const setScreen = useGameStore((s) => s.setScreen);
  const setPassword = useGameStore((s) => s.setPassword);
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleCreate = () => {
    const pw = passwordRef.current?.value.trim();
    if (!pw) {
      passwordRef.current?.focus();
      return;
    }
    setPassword(pw);
    const roomId = generateRoomId();
    connect(roomId, () => send("set-up", { name, password: pw }));
  };

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="Set Up a Fort"
        className="w-[340px] max-w-full relative z-[1]"
        buttons={[{ label: "✕", close: true, onClick: () => setScreen("home") }]}
      >
        <div className="xp-window-body">
          <p className="text-xs text-[#333] mb-3.5">
            Pick a secret password. Share it with people you want to let inside.
          </p>
          <Input
            id="setup-password"
            label="Secret Password"
            placeholder="Something only your friends know"
            maxLength={64}
            autoComplete="off"
            autoCorrect="off"
            ref={passwordRef}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
          />
          <div className="flex gap-2 mt-3 justify-center">
            <Button id="btn-create" primary onClick={handleCreate}>
              Build the Fort
            </Button>
            <Button onClick={() => setScreen("home")}>Cancel</Button>
          </div>
        </div>
      </Window>
    </div>
  );
}
