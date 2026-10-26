export interface BreakoutSnapshot {
  width: number; height: number;
  ball: { x: number; y: number; dx: number; dy: number };
  paddle: { x: number; y: number; w: number; h: number };
  bricks: { x: number; y: number; w: number; h: number; alive: boolean; color: string }[];
  lives: number; score: number; won: boolean; lost: boolean; running: boolean;
}
export const BALL_R = 6;
export const PADDLE_H = 12;
const BRICK_COLORS = ["#FF6B6B", "#FFA94D", "#FFD43B", "#69DB7C", "#4DABF7"];
export type BreakoutEffect = "paddle" | "brick" | "won" | "lost";

export function createBreakout(width: number, height: number, barHeight = 50): BreakoutSnapshot {
  const brickWidth = (width - 4 * 9) / 8;
  const bricks: BreakoutSnapshot["bricks"] = [];
  for (let row = 0; row < 5; row++) for (let column = 0; column < 8; column++) {
    bricks.push({ x: 4 + column * (brickWidth + 4), y: 40 + row * 22, w: brickWidth, h: 18, color: BRICK_COLORS[row], alive: true });
  }
  return { width, height, bricks,
    paddle: { x: width / 2 - 40, y: height - barHeight, w: 80, h: PADDLE_H },
    ball: { x: width / 2, y: height - barHeight - 20, dx: 3, dy: -3 },
    lives: 3, score: 0, won: false, lost: false, running: true };
}

export function moveBreakoutPaddle(state: BreakoutSnapshot, x: number): void {
  state.paddle.x = Math.max(0, Math.min(state.width - state.paddle.w, x * state.width - state.paddle.w / 2));
}

/** One original 60 Hz simulation step, shared by canvas and hosted participants. */
export function stepBreakout(s: BreakoutSnapshot, effect: (event: BreakoutEffect) => void): void {
  if (!s.running || s.won || s.lost) return;
  s.ball.x += s.ball.dx;
  s.ball.y += s.ball.dy;
  if (s.ball.x - BALL_R <= 0 || s.ball.x + BALL_R >= s.width) s.ball.dx *= -1;
  if (s.ball.y - BALL_R <= 0) s.ball.dy *= -1;
  if (s.ball.dy > 0 && s.ball.y + BALL_R >= s.paddle.y && s.ball.y + BALL_R <= s.paddle.y + s.paddle.h + 4 &&
      s.ball.x >= s.paddle.x && s.ball.x <= s.paddle.x + s.paddle.w) {
    s.ball.dy *= -1;
    s.ball.dx = ((s.ball.x - s.paddle.x) / s.paddle.w - 0.5) * 6;
    effect("paddle");
  }
  for (const brick of s.bricks) {
    if (!brick.alive) continue;
    if (s.ball.x + BALL_R > brick.x && s.ball.x - BALL_R < brick.x + brick.w &&
        s.ball.y + BALL_R > brick.y && s.ball.y - BALL_R < brick.y + brick.h) {
      brick.alive = false;
      s.score++;
      s.ball.dy *= -1;
      effect("brick");
    }
  }
  if (s.bricks.every(brick => !brick.alive)) { s.won = true; effect("won"); }
  if (s.ball.y - BALL_R > s.height) {
    s.lives--;
    if (s.lives <= 0) { s.lost = true; effect("lost"); }
    else { s.ball.x = s.width / 2; s.ball.y = s.paddle.y - 20; s.ball.dx = 3 * (Math.random() > 0.5 ? 1 : -1); s.ball.dy = -3; }
  }
}

export function breakoutResultMessage(state: BreakoutSnapshot): string {
  return state.won
    ? `\u{1F3AE} cleared all 40 bricks in Breakout with ${state.lives} lives remaining! \u{1F3C6}`
    : `\u{1F3AE} destroyed ${state.score}/40 bricks in Breakout before running out of lives`;
}
