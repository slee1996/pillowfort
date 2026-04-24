import { useRef, useEffect, useCallback } from "react";
import { send } from "../../services/ws";
import { beep } from "../../hooks/useSound";
import { useGameStore } from "../../stores/gameStore";
import { encryptChatPayload } from "../../services/chatCrypto";

const BRICK_COLORS = ["#FF6B6B", "#FFA94D", "#FFD43B", "#69DB7C", "#4DABF7", "#9775FA", "#F06595", "#20C997"];
const ROWS = 5, COLS = 8, BRICK_PAD = 4, BRICK_H = 18;
const PADDLE_H = 12, BALL_R = 6;
const MOBILE_PADDLE_LIFT_PX = 50;

interface Brick { x: number; y: number; w: number; h: number; color: string; alive: boolean }

export function BreakoutCanvas({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bootFrameRef = useRef<number>(0);
  const stateRef = useRef<{
    bricks: Brick[]; paddle: { x: number; y: number; w: number; h: number };
    ball: { x: number; y: number; dx: number; dy: number };
    lives: number; score: number; won: boolean; lost: boolean; running: boolean;
  } | null>(null);
  const animRef = useRef<number>(0);
  const keysRef = useRef<Record<string, boolean>>({});

  const sendBreakoutMessage = useCallback(async (text: string) => {
    const { roomId, password, name } = useGameStore.getState();
    if (!roomId || !password) return;
    try {
      const enc = await encryptChatPayload(roomId, password, name, text);
      if (enc) send("chat", { enc });
    } catch {}
  }, []);

  const reset = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const parent = cv.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    cv.width = rect.width;
    cv.height = rect.height;
    const w = cv.width, h = cv.height;
    const isMobile = window.matchMedia("(max-width: 600px)").matches;
    const paddleLift = isMobile ? MOBILE_PADDLE_LIFT_PX : 0;
    const brickW = (w - BRICK_PAD * (COLS + 1)) / COLS;
    const bricks: Brick[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        bricks.push({
          x: BRICK_PAD + c * (brickW + BRICK_PAD),
          y: 40 + r * (BRICK_H + BRICK_PAD),
          w: brickW, h: BRICK_H,
          color: BRICK_COLORS[r % BRICK_COLORS.length],
          alive: true,
        });
      }
    }
    const barH = 50 + paddleLift;
    stateRef.current = {
      bricks,
      paddle: { x: w / 2 - 40, y: h - barH, w: 80, h: PADDLE_H },
      ball: { x: w / 2, y: h - barH - 20, dx: 3, dy: -3 },
      lives: 3, score: 0, won: false, lost: false, running: true,
    };
  }, []);

  const stopGameLoop = useCallback(() => {
    if (bootFrameRef.current) {
      cancelAnimationFrame(bootFrameRef.current);
      bootFrameRef.current = 0;
    }
    if (animRef.current) {
      cancelAnimationFrame(animRef.current);
      animRef.current = 0;
    }
    if (stateRef.current) stateRef.current.running = false;
  }, []);

  useEffect(() => {
    if (!active) {
      stopGameLoop();
      return;
    }

    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    let disposed = false;

    bootFrameRef.current = requestAnimationFrame(() => {
      bootFrameRef.current = 0;
      if (disposed) return;
      if (!stateRef.current || stateRef.current.won || stateRef.current.lost) reset();
      if (!stateRef.current) return;
      stateRef.current.running = true;

      function loop() {
        const s = stateRef.current;
        if (disposed || !s || !s.running) return;
        const w = cv!.width, h = cv!.height;

        // Update
        if (!s.won && !s.lost) {
          s.ball.x += s.ball.dx;
          s.ball.y += s.ball.dy;
          if (s.ball.x - BALL_R <= 0 || s.ball.x + BALL_R >= w) s.ball.dx *= -1;
          if (s.ball.y - BALL_R <= 0) s.ball.dy *= -1;

          if (s.ball.dy > 0 && s.ball.y + BALL_R >= s.paddle.y && s.ball.y + BALL_R <= s.paddle.y + s.paddle.h + 4 &&
              s.ball.x >= s.paddle.x && s.ball.x <= s.paddle.x + s.paddle.w) {
            s.ball.dy *= -1;
            s.ball.dx = ((s.ball.x - s.paddle.x) / s.paddle.w - 0.5) * 6;
            beep(520, 0.05, 0, 0.04);
          }

          s.bricks.forEach((b) => {
            if (!b.alive) return;
            if (s.ball.x + BALL_R > b.x && s.ball.x - BALL_R < b.x + b.w &&
                s.ball.y + BALL_R > b.y && s.ball.y - BALL_R < b.y + b.h) {
              b.alive = false;
              s.score++;
              s.ball.dy *= -1;
              beep(880, 0.03, 0, 0.03);
            }
          });

          if (s.bricks.every((b) => !b.alive)) {
            s.won = true;
            beep(523, 0.1, 0, 0.06);
            beep(659, 0.1, 0.1, 0.06);
            beep(784, 0.1, 0.2, 0.06);
            beep(1047, 0.3, 0.3, 0.08);
            void sendBreakoutMessage(`🎮 cleared all 40 bricks in Breakout with ${s.lives} lives remaining! 🏆`);
          }

          if (s.ball.y - BALL_R > h) {
            s.lives--;
            if (s.lives <= 0) {
              s.lost = true;
              beep(220, 0.3, 0, 0.08);
              beep(165, 0.4, 0.2, 0.08);
              void sendBreakoutMessage(`🎮 destroyed ${s.score}/40 bricks in Breakout before running out of lives`);
            } else {
              s.ball.x = w / 2;
              s.ball.y = s.paddle.y - 20;
              s.ball.dx = 3 * (Math.random() > 0.5 ? 1 : -1);
              s.ball.dy = -3;
            }
          }
        }

        // Draw
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = "#fff";
        for (let i = 0; i < 40; i++) {
          const sx = (i * 137.5) % w, sy = (i * 97.3) % h;
          ctx.globalAlpha = 0.3 + (i % 5) * 0.1;
          ctx.fillRect(sx, sy, 1.5, 1.5);
        }
        ctx.globalAlpha = 1;

        s.bricks.forEach((b) => {
          if (!b.alive) return;
          ctx.fillStyle = b.color;
          ctx.beginPath();
          ctx.roundRect(b.x, b.y, b.w, b.h, 3);
          ctx.fill();
        });

        ctx.fillStyle = "#ECE9D8";
        ctx.beginPath();
        ctx.roundRect(s.paddle.x, s.paddle.y, s.paddle.w, s.paddle.h, 4);
        ctx.fill();
        ctx.strokeStyle = "#ACA899";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = "#FFD700";
        ctx.beginPath();
        ctx.arc(s.ball.x, s.ball.y, BALL_R, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#fff";
        ctx.font = "11px Tahoma, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("❤".repeat(s.lives), 8, 20);
        ctx.textAlign = "right";
        ctx.fillText("Score: " + s.score, w - 8, 20);

        if (s.won) {
          ctx.fillStyle = "#FFD700";
          ctx.font = "bold 24px Tahoma, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("You win! Score: " + s.score, w / 2, h / 2);
          ctx.font = "12px Tahoma, sans-serif";
          ctx.fillStyle = "#fff";
          ctx.fillText("Click to play again", w / 2, h / 2 + 24);
        }

        if (s.lost) {
          ctx.fillStyle = "#FF6B6B";
          ctx.font = "bold 24px Tahoma, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("Game Over — Score: " + s.score, w / 2, h / 2);
          ctx.font = "12px Tahoma, sans-serif";
          ctx.fillStyle = "#fff";
          ctx.fillText("Click to try again", w / 2, h / 2 + 24);
        }

        animRef.current = requestAnimationFrame(loop);
      }

      loop();
    });

    // Input handlers
    const cv2 = cv;
    const setPaddleFromClientX = (clientX: number) => {
      if (!stateRef.current?.running) return;
      const rect = cv2.getBoundingClientRect();
      stateRef.current.paddle.x = Math.max(
        0,
        Math.min(cv2.width - stateRef.current.paddle.w, clientX - rect.left - stateRef.current.paddle.w / 2)
      );
    };
    const onMouse = (e: MouseEvent) => {
      setPaddleFromClientX(e.clientX);
    };
    const onTouchStart = (e: TouchEvent) => {
      if (!stateRef.current) return;
      e.preventDefault();
      if (stateRef.current.won || stateRef.current.lost) {
        reset();
      }
      if (e.touches.length > 0) setPaddleFromClientX(e.touches[0].clientX);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!stateRef.current?.running) return;
      e.preventDefault();
      if (e.touches.length > 0) setPaddleFromClientX(e.touches[0].clientX);
    };
    const onClick = () => {
      if (stateRef.current?.won || stateRef.current?.lost) reset();
    };
    const onKeyDown = (e: KeyboardEvent) => { keysRef.current[e.key] = true; };
    const onKeyUp = (e: KeyboardEvent) => { keysRef.current[e.key] = false; };

    cv.addEventListener("mousemove", onMouse);
    cv.addEventListener("touchstart", onTouchStart, { passive: false });
    cv.addEventListener("touchmove", onTouchMove, { passive: false });
    cv.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);

    const keyInterval = setInterval(() => {
      if (!stateRef.current?.running) return;
      if (keysRef.current.ArrowLeft) stateRef.current.paddle.x = Math.max(0, stateRef.current.paddle.x - 6);
      if (keysRef.current.ArrowRight) stateRef.current.paddle.x = Math.min(cv.width - stateRef.current.paddle.w, stateRef.current.paddle.x + 6);
    }, 16);

    return () => {
      disposed = true;
      stopGameLoop();
      clearInterval(keyInterval);
      cv.removeEventListener("mousemove", onMouse);
      cv.removeEventListener("touchstart", onTouchStart);
      cv.removeEventListener("touchmove", onTouchMove);
      cv.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [active, reset, sendBreakoutMessage, stopGameLoop]);

  if (!active) return null;

  return <canvas ref={canvasRef} className="breakout-canvas" />;
}
