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
    <div className="dialog-overlay" id="host-offer-overlay">
      <div className="xp-window dialog-window host-offer-window">
        <div className="xp-title-bar">
          <div className="xp-title-text">
            <div className="xp-title-icon"><LogoIcon /></div>
            incoming pillow!
          </div>
        </div>
        <div className="xp-window-body">
          <div className="notice-row">
            <div className="host-offer-icon-wrap">
              🛏
            </div>
            <div className="notice-text">
              <strong>{hostOffer.oldHost} threw a pillow at you!</strong>
              <p className="notice-subtext">
                You'll be in charge of the fort. You can knock it down or keep it going.
              </p>
            </div>
          </div>
          <div className="auth-actions">
            <Button id="btn-catch" primary onClick={handleCatch}>Catch it</Button>
            <Button id="btn-duck" onClick={handleDuck}>Duck</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
