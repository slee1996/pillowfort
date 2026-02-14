import { useRef, useEffect } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { connect, send } from "../services/ws";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";

export function JoinScreen() {
  const name = useGameStore((s) => s.name);
  const setScreen = useGameStore((s) => s.setScreen);
  const setPassword = useGameStore((s) => s.setPassword);
  const pendingRoom = useGameStore((s) => s.pendingRoom);
  const roomRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pendingRoom && roomRef.current) {
      roomRef.current.value = pendingRoom;
      useGameStore.getState().setPendingRoom(null);
      passwordRef.current?.focus();
    } else {
      roomRef.current?.focus();
    }
  }, []);

  const handleJoin = () => {
    const room = roomRef.current?.value.trim();
    const pw = passwordRef.current?.value.trim();
    if (!room) {
      roomRef.current?.focus();
      return;
    }
    if (!pw) {
      passwordRef.current?.focus();
      return;
    }
    setPassword(pw);
    connect(room, () => send("join", { name, password: pw, room }));
  };

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="Join a Fort"
        className="w-[340px] max-w-full relative z-[1]"
        buttons={[{ label: "✕", close: true, onClick: () => setScreen("home") }]}
      >
        <div className="xp-window-body">
          <p className="text-xs text-[#333] mb-3.5">
            Enter the fort flag and secret password you were given.
          </p>
          <Input
            id="join-room"
            label="Fort Flag"
            placeholder="8-character flag"
            maxLength={8}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            ref={roomRef}
          />
          <Input
            id="join-password"
            label="Secret Password"
            placeholder="The secret password"
            maxLength={64}
            autoComplete="off"
            autoCorrect="off"
            ref={passwordRef}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          />
          <div className="flex gap-2 mt-3 justify-center">
            <Button id="btn-enter" primary onClick={handleJoin}>
              Join Fort
            </Button>
            <Button onClick={() => setScreen("home")}>Cancel</Button>
          </div>
        </div>
      </Window>
    </div>
  );
}
