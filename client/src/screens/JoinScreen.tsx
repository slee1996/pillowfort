import { useRef, useEffect } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { connect, send } from "../services/ws";
import { createRoomAuthPayload } from "../services/chatCrypto";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";

export function JoinScreen() {
  const name = useGameStore((s) => s.name);
  const setName = useGameStore((s) => s.setName);
  const setScreen = useGameStore((s) => s.setScreen);
  const setPassword = useGameStore((s) => s.setPassword);
  const pendingRoom = useGameStore((s) => s.pendingRoom);
  const nameRef = useRef<HTMLInputElement>(null);
  const roomRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pendingRoom && roomRef.current) {
      roomRef.current.value = pendingRoom;
      useGameStore.getState().setPendingRoom(null);
      if (!name) nameRef.current?.focus();
      else passwordRef.current?.focus();
    } else {
      if (!name) nameRef.current?.focus();
      else roomRef.current?.focus();
    }
  }, []);

  const handleJoin = async () => {
    const enteredName = nameRef.current?.value.trim() || name.trim();
    const room = roomRef.current?.value.trim();
    const pw = passwordRef.current?.value.trim();
    if (!enteredName) {
      nameRef.current?.focus();
      return;
    }
    if (!room) {
      roomRef.current?.focus();
      return;
    }
    if (!pw) {
      passwordRef.current?.focus();
      return;
    }
    setName(enteredName);
    setPassword(pw);
    const auth = await createRoomAuthPayload(room, pw);
    connect(room, () => send("join", { name: enteredName, auth, room }));
  };

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="Join a Fort"
        className="auth-window"
        buttons={[{ label: "✕", close: true, onClick: () => setScreen("home") }]}
      >
        <div className="xp-window-body">
          <p className="auth-note">
            Enter the fort flag and secret password you were given.
          </p>
          <Input
            id="join-name"
            label="Screen Name"
            placeholder="Enter a screen name"
            maxLength={24}
            autoComplete="off"
            autoCapitalize="off"
            defaultValue={name}
            ref={nameRef}
          />
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
          <div className="auth-actions">
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
