import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { Button } from "../xp/Button";
import { LogoIcon } from "../xp/Logo";

export function HostOfferDialog() {
  const hostOffer = useGameStore((s) => s.hostOffer);

  if (!hostOffer) return null;

  const handleCatch = () => {
    useGameStore.getState().setHostOffer(null);
    send("accept-host");
  };

  const handleDuck = () => {
    useGameStore.getState().setHostOffer(null);
    send("reject-host");
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/30 flex items-center justify-center">
      <div className="xp-window w-[340px] max-w-full">
        <div className="xp-title-bar">
          <div className="xp-title-text">
            <div className="xp-title-icon"><LogoIcon /></div>
            incoming pillow!
          </div>
        </div>
        <div className="xp-window-body">
          <div className="flex items-start gap-3.5 mb-4">
            <div className="w-8 h-8 shrink-0 flex items-center justify-center text-base font-bold text-[#333]">
              🛏
            </div>
            <div className="text-xs leading-relaxed text-[#333]">
              <strong>{hostOffer.oldHost} threw a pillow at you!</strong>
              <p className="text-[#666] text-[11px] mt-1.5">
                You'll be in charge of the fort. You can knock it down or keep it going.
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-3 justify-center">
            <Button id="btn-catch" primary onClick={handleCatch}>Catch it</Button>
            <Button id="btn-duck" onClick={handleDuck}>Duck</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
