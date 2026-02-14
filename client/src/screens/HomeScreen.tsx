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
      if (useGameStore.getState().name) {
        setScreen("join");
      }
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
        className="w-[340px] max-w-full relative z-[1]"
        buttons={[
          { label: "─", onClick: () => {} },
          { label: "✕", close: true, onClick: () => {} },
        ]}
      >
        <div className="xp-window-body">
          <div className="text-center pt-4 pb-1">
            <div className="w-[72px] h-[72px] mx-auto mb-3 flex items-center justify-center">
              <LogoIcon size={72} />
            </div>
            <div className="text-[22px] font-bold text-[#003C74] tracking-[2px] font-['Arial_Black',Arial,sans-serif]">
              pillowfort
            </div>
            <div className="text-[10px] text-[#666] mt-0.5">
              set up &middot; hang out &middot; knock down
            </div>
          </div>

          <div className="h-px bg-gradient-to-r from-transparent via-[#ACA899] to-transparent my-3.5" />

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

          <div className="flex gap-2 mt-3 justify-center">
            <Button id="btn-setup" primary onClick={handleSetup}>
              Set Up Fort
            </Button>
            <Button id="btn-join" onClick={handleJoin}>
              Join Fort
            </Button>
          </div>

          <div className="text-center text-[10px] text-[#999] mt-2.5 pb-0.5">
            Version 1.0.0 &middot; 2025
          </div>
        </div>
      </Window>
    </div>
  );
}
