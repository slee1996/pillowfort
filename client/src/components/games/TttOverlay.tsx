import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { Button } from "../xp/Button";

const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

export function TttOverlay() {
  const ttt = useGameStore((s) => s.tttState);
  const name = useGameStore((s) => s.name);

  if (!ttt) return null;

  const close = () => useGameStore.getState().setTttState(null);

  // Phase: challenged
  if (ttt.phase === "challenged" && ttt.challengedBy) {
    return (
      <div className="game-overlay">
        <div className="game-dialog game-dialog-wide">
          <div className="xp-title-bar"><div className="xp-title-text">⬜ Tic-Tac-Toe</div></div>
          <div className="game-dialog-body">
            <div>{ttt.challengedBy} challenges you to Tic-Tac-Toe!</div>
            <div className="auth-actions game-actions">
              <Button primary onClick={() => send("ttt-accept")}>Accept</Button>
              <Button onClick={() => { send("ttt-decline"); close(); }}>Decline</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Playing or result
  const currentMark = ttt.turn % 2 === 0 ? "X" : "O";
  const myTurn = currentMark === ttt.myMark;
  const isResult = ttt.phase === "result";

  // Find winning combo
  let winCells: number[] = [];
  if (ttt.winner) {
    const winMark = ttt.p1 === ttt.winner ? "X" : "O";
    for (const combo of TTT_WINS) {
      if (combo.every((i) => ttt.board[i] === winMark)) {
        winCells = combo;
        break;
      }
    }
  }

  let statusText = "";
  let statusColor = "";
  if (ttt.winner) {
    const won = ttt.winner === name;
    statusText = won ? "You win! 🎉" : `${ttt.winner} wins!`;
    statusColor = won ? "#060" : "#800";
  } else if (ttt.draw) {
    statusText = "It's a draw!";
    statusColor = "#666";
  } else {
    statusText = myTurn ? "Your turn!" : "Opponent's turn...";
  }

  return (
    <div className="game-overlay">
      <div className="game-dialog game-dialog-wide">
        <div className="xp-title-bar"><div className="xp-title-text">⬜ Tic-Tac-Toe</div></div>
        <div className="game-dialog-body">
          <div>{ttt.p1} (X) vs {ttt.p2} (O)</div>
          <div className="ttt-board">
            {ttt.board.map((cell, i) => (
              <div
                key={i}
                className={`ttt-cell ${cell === "X" ? "x" : cell === "O" ? "o" : ""} ${winCells.includes(i) ? "win" : ""}`}
                onClick={() => {
                  if (!cell && myTurn && !isResult) send("ttt-move", { cell: i });
                }}
                style={{ cursor: !cell && myTurn && !isResult ? "pointer" : "default" }}
              >
                {cell}
              </div>
            ))}
          </div>
          <div className="ttt-status" style={{ color: statusColor }}>{statusText}</div>
          {isResult && (
            <div className="auth-actions game-actions">
              <Button onClick={close}>OK</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
