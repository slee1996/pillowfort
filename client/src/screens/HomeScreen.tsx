import { useRef, useEffect } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { LogoIcon } from "../components/xp/Logo";
import { ensureAudio } from "../hooks/useSound";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";

export function HomeScreen() {
  const name = useGameStore((s) => s.name);
  const setName = useGameStore((s) => s.setName);
  const setScreen = useGameStore((s) => s.setScreen);
  const pendingRoom = useGameStore((s) => s.pendingRoom);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check for room link in URL on mount
  useEffect(() => {
    const match = location.pathname.match(/^\/([a-z0-9]{8})$/);
    if (match) {
      history.replaceState(null, "", "/");
      useGameStore.getState().setPendingRoom(match[1]);
      setScreen("join");
    } else if (name && inputRef.current) {
      inputRef.current.select();
    }
  }, []);

  const handleSetup = () => {
    ensureAudio();
    const n = inputRef.current?.value.trim();
    if (!n) {
      inputRef.current?.focus();
      return;
    }
    setName(n);
    useGameStore.getState().setPendingRoom(null);
    setScreen("setup");
  };

  const handleJoin = () => {
    ensureAudio();
    const n = inputRef.current?.value.trim();
    if (!n) {
      inputRef.current?.focus();
      return;
    }
    setName(n);
    setScreen("join");
  };

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="pillowfort Sign On"
        className="auth-window home-window"
        buttons={[
          { label: "─", onClick: () => {} },
          { label: "✕", close: true, onClick: () => {} },
        ]}
      >
        <div className="xp-window-body">
          <div className="home-brand">
            <div className="home-logo-wrap">
              <LogoIcon size={72} />
            </div>
            <div className="home-title">
              pillowfort
            </div>
            <div className="home-tagline">
              set up &middot; hang out &middot; knock down
            </div>
          </div>

          <div className="home-divider" />

          <Input
            id="name-input"
            label="Screen Name"
            placeholder="Enter a screen name"
            maxLength={24}
            autoComplete="off"
            autoCapitalize="off"
            defaultValue={name}
            ref={inputRef}
            onKeyDown={(e) => e.key === "Enter" && handleSetup()}
          />

          <div className="auth-actions">
            <Button id="btn-setup" primary onClick={handleSetup}>
              Set Up Fort
            </Button>
            <Button id="btn-join" onClick={handleJoin}>
              Join Fort
            </Button>
          </div>

          <div className="home-version">
            Version 1.0.0 &middot; 2025
          </div>
        </div>
      </Window>
    </div>
  );
}
