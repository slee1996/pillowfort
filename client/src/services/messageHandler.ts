import { useGameStore } from "../stores/gameStore";
import { playDoorOpen, playDoorClose, playMsgSound } from "../hooks/useSound";
import { requestWakeLock, releaseWakeLock } from "../hooks/useWakeLock";
import type { IncomingMessage, RoomLeaderboards, RoomGameQueue, GameQueueItem, RoomTheme, FortPassRoomPerks } from "./protocol";
import { decryptChatPayload, roomSafetyCode } from "./chatCrypto";
import { track, trackOnce } from "./analytics";

const SABOTEUR_EXPLOSION_MS = 1200;
let sabBombInterval: ReturnType<typeof setInterval> | null = null;
let sabBombEndsAt = 0;
const viteEnv = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
const ALLOW_LEGACY_PLAINTEXT = viteEnv?.DEV === true && viteEnv?.VITE_ALLOW_LEGACY_PLAINTEXT === "1";

type IncomingChatMessage = Extract<IncomingMessage, { type: "message" }>;

function normalizeLeaderboards(src?: RoomLeaderboards): RoomLeaderboards {
  return {
    pillowFight: { ...(src?.pillowFight || {}) },
    rps: { ...(src?.rps || {}) },
    ttt: { ...(src?.ttt || {}) },
    saboteur: { ...(src?.saboteur || {}) },
    koth: { ...(src?.koth || {}) },
  };
}

function normalizeGameQueue(src?: RoomGameQueue): RoomGameQueue {
  return {
    current: src?.current ? { ...src.current } : null,
    queue: (src?.queue || []).map((q) => ({ ...q })),
  };
}

function normalizeRoomTheme(theme: unknown): RoomTheme {
  return theme === "retro-green" || theme === "midnight" ? theme : "classic";
}

function normalizeFortPass(src: unknown): FortPassRoomPerks | null {
  if (!src || typeof src !== "object") return null;
  const raw = src as Record<string, unknown>;
  return raw.themePack === "retro-plus" ? { themePack: "retro-plus" } : null;
}

function queueItemText(item: GameQueueItem): string {
  switch (item.kind) {
    case "vote":
      return `${item.by} starts Pillow Fight on ${item.target || "someone"}`;
    case "rps":
      return `${item.by} challenges ${item.target || "someone"} to RPS`;
    case "ttt":
      return `${item.by} challenges ${item.target || "someone"} to Tic-Tac-Toe`;
    case "saboteur":
      return `${item.by} starts Secret Saboteur`;
    case "koth":
      return `${item.by} challenges for the crown`;
  }
}

function stopSabBombCountdown() {
  if (sabBombInterval) {
    clearInterval(sabBombInterval);
    sabBombInterval = null;
  }
  sabBombEndsAt = 0;
}

function startSabBombCountdown(seconds: number, durationMs?: number) {
  stopSabBombCountdown();
  const effectiveMs = durationMs && durationMs > 0 ? durationMs : seconds * 1000;
  sabBombEndsAt = Date.now() + effectiveMs;
  const update = () => {
    const remaining = Math.max(0, Math.ceil((sabBombEndsAt - Date.now()) / 1000));
    const state = useGameStore.getState();
    state.setSabBombCountdown(remaining);
    if (remaining === 0) {
      stopSabBombCountdown();
      state.triggerSabDetonation();
      // Fallback: if the server-side knocked-down message is dropped,
      // still end the room locally after the explosion animation.
      window.setTimeout(() => {
        const now = useGameStore.getState();
        if (now.screen !== "chat" || now.sabStrikes < 3) return;
        now.setScreen("knocked");
        playDoorClose();
        now.cleanup();
        useGameStore.getState().addSystemMessage("the saboteur's bomb exploded!");
      }, SABOTEUR_EXPLOSION_MS + 220);
    }
  };
  update();
  sabBombInterval = setInterval(update, 250);
}

async function handleEncryptedChatMessage(
  msg: IncomingChatMessage,
  roomId: string,
  password: string
) {
  const current = useGameStore.getState();
  const muted = current.mutedNames.has(msg.from);
  if (muted) return;

  const decrypted = msg.enc
    ? await decryptChatPayload(roomId, password, msg.from, msg.enc, msg.style)
    : null;
  const text = (decrypted?.text || "[unable to decrypt message]").slice(0, 2000);

  const now = useGameStore.getState();
  if (now.roomId !== roomId) return;
  if (now.mutedNames.has(msg.from)) return;

  now.addChatMessage(msg.from, text, decrypted?.style);
  playMsgSound();
}

export function handleMessage(msg: IncomingMessage) {
  const s = useGameStore.getState();

  switch (msg.type) {
    case "room-created": {
      s.setRoomId(msg.room);
      s.setIsHost(true);
      s.setMembers([s.name]);
      s.setMemberPresenceMap({ [s.name]: { status: "available" } });
      s.setLeaderboards(normalizeLeaderboards(msg.leaderboards));
      s.setGameQueue(normalizeGameQueue(msg.gameQueue));
      s.setRoomTheme(normalizeRoomTheme(msg.theme));
      s.setFortPass(normalizeFortPass(msg.fortPass));
      s.setPendingFortPass(null);
      s.setScreen("chat");
      s.clearMessages();
      s.addSystemMessage("Welcome to the fort.");
      s.addSystemMessage(`Fort: ${msg.room} — Password: ${s.password}`);
      s.addSystemMessage("Share the fort flag and password to let your friends in.");
      if (s.password) {
        void roomSafetyCode(msg.room, s.password).then((code) => {
          if (code && useGameStore.getState().roomId === msg.room) {
            useGameStore.getState().addSystemMessage(`Room safety code: ${code}`);
          }
        });
      }
      playDoorOpen();
      requestWakeLock();
      track("room_created", { role: "host", memberCount: 1 });
      break;
    }

    case "joined": {
      const renamed = msg.name && msg.name !== s.name;
      if (renamed) s.setName(msg.name);
      s.setRoomId(msg.room);
      s.setIsHost(false);
      s.setMembers(msg.members);
      if (msg.presence) s.setMemberPresenceMap(msg.presence);
      else s.setMemberPresenceMap(Object.fromEntries(msg.members.map((m) => [m, { status: "available" as const }])));
      s.setLeaderboards(normalizeLeaderboards(msg.leaderboards));
      s.setGameQueue(normalizeGameQueue(msg.gameQueue));
      s.setRoomTheme(normalizeRoomTheme(msg.theme));
      s.setFortPass(normalizeFortPass(msg.fortPass));
      s.setScreen("chat");
      s.clearMessages();
      if (renamed) s.addSystemMessage(`That name's taken — you're ${msg.name} now`);
      s.addSystemMessage(`You're inside. ${msg.members.length} people in the fort.`);
      if (s.password) {
        void roomSafetyCode(msg.room, s.password).then((code) => {
          if (code && useGameStore.getState().roomId === msg.room) {
            useGameStore.getState().addSystemMessage(`Room safety code: ${code}`);
          }
        });
      }
      playDoorOpen();
      requestWakeLock();
      track("room_joined", { role: "guest", memberCount: msg.members.length });
      break;
    }

    case "rejoined": {
      s.setReconnecting(false);
      s.setReconnectAttempts(0);
      s.setRoomId(msg.room);
      s.setIsHost(msg.isHost);
      s.setName(msg.name);
      s.setMembers(msg.members);
      if (msg.presence) s.setMemberPresenceMap(msg.presence);
      else s.setMemberPresenceMap(Object.fromEntries(msg.members.map((m) => [m, { status: "available" as const }])));
      s.setLeaderboards(normalizeLeaderboards(msg.leaderboards));
      s.setGameQueue(normalizeGameQueue(msg.gameQueue));
      s.setRoomTheme(normalizeRoomTheme(msg.theme));
      s.setFortPass(normalizeFortPass(msg.fortPass));
      s.addSystemMessage("Reconnected!");
      requestWakeLock();
      break;
    }

    case "leaderboards": {
      s.setLeaderboards(normalizeLeaderboards(msg.leaderboards));
      break;
    }

    case "game-queue": {
      s.setGameQueue(normalizeGameQueue(msg.gameQueue));
      break;
    }

    case "room-theme": {
      s.setRoomTheme(normalizeRoomTheme(msg.theme));
      break;
    }

    case "game-queued": {
      s.addSystemMessage(`⏳ Queued (#${msg.position}): ${queueItemText(msg)}`);
      break;
    }

    case "message": {
      if (msg.enc) {
        if (s.roomId && s.password) {
          void handleEncryptedChatMessage(msg, s.roomId, s.password);
        } else if (!s.mutedNames.has(msg.from)) {
          s.addChatMessage(msg.from, "[encrypted message]", msg.style);
          playMsgSound();
        }
      } else if (ALLOW_LEGACY_PLAINTEXT && typeof msg.text === "string" && !s.mutedNames.has(msg.from)) {
        s.addChatMessage(msg.from, msg.text, msg.style);
        playMsgSound();
      }
      if (s.minimized) s.incrementUnread();
      break;
    }

    case "member-joined": {
      s.addMember(msg.name);
      s.setMemberPresence(msg.name, msg.presence?.status || "available", msg.presence?.awayText);
      s.addSystemMessage(`${msg.name} entered the fort.`);
      playDoorOpen();
      if (s.isHost) {
        track("guest_joined", {
          role: "host",
          memberCount: useGameStore.getState().members.length,
        });
      }
      break;
    }

    case "member-left": {
      s.removeMember(msg.name);
      s.addSystemMessage(`${msg.name} left the fort.`);
      playDoorClose();
      break;
    }

    case "member-away": {
      s.setMemberPresence(msg.name, "away", "reconnecting...");
      s.addSystemMessage(`${msg.name} lost connection...`);
      break;
    }

    case "member-back": {
      const current = useGameStore.getState().members;
      if (!current.includes(msg.name)) s.addMember(msg.name);
      s.setMemberPresence(msg.name, "available");
      s.addSystemMessage(`${msg.name} reconnected.`);
      break;
    }

    case "member-status": {
      s.setMemberPresence(msg.name, msg.status, msg.awayText || undefined);
      if (msg.status === "away") {
        s.addSystemMessage(msg.awayText?.trim()
          ? `${msg.name} is away: ${msg.awayText}`
          : `${msg.name} is away.`);
      } else {
        s.addSystemMessage(`${msg.name} is back.`);
      }
      break;
    }

    case "new-host": {
      s.setHostOffer(null);
      const members = useGameStore.getState().members.filter((n) => n !== msg.name);
      members.unshift(msg.name);
      s.setMembers(members);
      s.setIsHost(msg.name === s.name);
      s.addSystemMessage(`${msg.name} caught the pillow. they're the new host.`);
      break;
    }

    case "host-offer": {
      s.setHostOffer({ oldHost: msg.oldHost });
      break;
    }

    case "host-offered":
      break;

    case "host-ducked": {
      s.addSystemMessage(`${msg.name} ducked.`);
      break;
    }

    case "knocked-down": {
      const stateNow = useGameStore.getState();
      trackOnce(`room-knocked-down:${stateNow.roomId || "unknown"}`, "room_knocked_down", {
        role: stateNow.isHost ? "host" : "guest",
        memberCount: stateNow.members.length,
      });
      const isSabBombDetonation = stateNow.sabStrikes >= 3;
      if (isSabBombDetonation) {
        stateNow.triggerSabDetonation();
        stateNow.setSabBombCountdown(0);
      }
      stopSabBombCountdown();
      const finalizeKnockDown = () => {
        const state = useGameStore.getState();
        state.setScreen("knocked");
        playDoorClose();
        state.cleanup();
        // We need to set the reason after cleanup — store it on the knocked screen via a message
        useGameStore.getState().addSystemMessage(msg.reason);
      };

      if (isSabBombDetonation) {
        window.setTimeout(finalizeKnockDown, SABOTEUR_EXPLOSION_MS);
      } else {
        finalizeKnockDown();
      }
      break;
    }

    case "typing": {
      // Handled by ChatScreen via a separate mechanism
      window.dispatchEvent(new CustomEvent("pf-typing", { detail: msg.name }));
      break;
    }

    case "draw": {
      window.dispatchEvent(new CustomEvent("pf-draw", { detail: msg }));
      break;
    }

    case "error": {
      if (!s.roomId) s.cleanup();
      s.showError(msg.message);
      break;
    }

    case "ejected": {
      stopSabBombCountdown();
      s.setScreen("knocked");
      playDoorClose();
      s.cleanup();
      useGameStore.getState().addSystemMessage(msg.reason || "You were voted out!");
      break;
    }

    // --- Vote ---
    case "vote-started": {
      const duration = msg.duration || 30_000;
      const endsAt = msg.endsAt || Date.now() + duration;
      if (msg.starter === s.name) {
        track("game_started", { kind: "vote", role: s.isHost ? "host" : "guest", memberCount: s.members.length });
      }
      s.addSystemMessage(`⚔ PILLOW FIGHT! ${msg.starter} wants to kick ${msg.target}!`);
      s.setActiveVote({
        target: msg.target,
        starter: msg.starter,
        auto: msg.auto,
        duration,
        endsAt,
        timerStart: endsAt - duration,
      });
      break;
    }

    case "vote-cast": {
      // Just a notification — individual votes don't need state update
      break;
    }

    case "vote-result": {
      s.setActiveVote(null);
      if (msg.ejected) {
        s.addSystemMessage(`💥 ${msg.target} was voted out! (${msg.yes}-${msg.no})`);
      } else {
        s.addSystemMessage(`${msg.target} survives the pillow fight! (${msg.yes}-${msg.no})`);
      }
      break;
    }

    // --- RPS ---
    case "rps-challenged": {
      s.setRpsState({
        p1: msg.from,
        p2: s.name,
        phase: "challenged",
        challengedBy: msg.from,
      });
      break;
    }

    case "rps-pending":
      break;

    case "rps-started": {
      if (!msg.koth && msg.p1 === s.name) {
        track("game_started", {
          kind: "rps",
          role: s.isHost ? "host" : "guest",
          memberCount: s.members.length,
        });
      }
      s.addSystemMessage(
        `✊ ${msg.p1} vs ${msg.p2} — Rock Paper Scissors!${msg.koth ? " (King of the Hill!)" : ""}`
      );
      if (msg.p1 === s.name || msg.p2 === s.name) {
        s.setRpsState({
          p1: msg.p1,
          p2: msg.p2,
          koth: msg.koth,
          phase: "picking",
        });
      }
      break;
    }

    case "rps-declined": {
      s.setRpsState(null);
      s.addSystemMessage(`${msg.from} declined the RPS challenge.`);
      break;
    }

    case "rps-picked":
      break;

    case "rps-result": {
      const RPS_EMOJI: Record<string, string> = { rock: "✊", paper: "🖐️", scissors: "✌️" };
      const line = `${msg.p1} ${RPS_EMOJI[msg.pick1]} vs ${RPS_EMOJI[msg.pick2]} ${msg.p2}`;
      if (msg.winner) {
        s.addSystemMessage(`${line} — ${msg.winner} wins!${msg.koth ? " 👑" : ""}`);
      } else {
        s.addSystemMessage(`${line} — Draw!`);
      }
      const current = useGameStore.getState().rpsState;
      if (current && (current.p1 === s.name || current.p2 === s.name)) {
        s.setRpsState({
          ...current,
          phase: "result",
          result: { pick1: msg.pick1, pick2: msg.pick2, winner: msg.winner },
        });
      }
      break;
    }

    // --- TTT ---
    case "ttt-challenged": {
      s.setTttState({
        p1: msg.from,
        p2: s.name,
        myMark: "O",
        board: Array(9).fill(""),
        turn: 0,
        winner: null,
        draw: false,
        phase: "challenged",
        challengedBy: msg.from,
      });
      break;
    }

    case "ttt-pending":
      break;

    case "ttt-started": {
      if (msg.p1 === s.name) {
        track("game_started", { kind: "ttt", role: s.isHost ? "host" : "guest", memberCount: s.members.length });
      }
      s.addSystemMessage(`⬜ ${msg.p1} (X) vs ${msg.p2} (O) — Tic-Tac-Toe!`);
      if (msg.p1 === s.name || msg.p2 === s.name) {
        s.setTttState({
          p1: msg.p1,
          p2: msg.p2,
          myMark: msg.p1 === s.name ? "X" : "O",
          board: msg.board,
          turn: msg.turn,
          winner: null,
          draw: false,
          phase: "playing",
        });
      }
      break;
    }

    case "ttt-declined": {
      s.setTttState(null);
      s.addSystemMessage(`${msg.from} declined the Tic-Tac-Toe challenge.`);
      break;
    }

    case "ttt-update": {
      const ttt = useGameStore.getState().tttState;
      if (ttt && (ttt.p1 === s.name || ttt.p2 === s.name)) {
        s.setTttState({
          ...ttt,
          board: msg.board,
          turn: msg.turn,
          winner: msg.winner,
          draw: msg.draw,
          phase: msg.winner || msg.draw ? "result" : "playing",
        });
      }
      if (msg.winner) {
        s.addSystemMessage(`⬜ ${msg.winner} wins Tic-Tac-Toe!`);
      } else if (msg.draw) {
        s.addSystemMessage("⬜ Tic-Tac-Toe ended in a draw!");
      }
      break;
    }

    // --- Saboteur ---
    case "sab-started": {
      if (msg.starter === s.name) {
        track("game_started", { kind: "saboteur", role: s.isHost ? "host" : "guest", memberCount: s.members.length });
      }
      stopSabBombCountdown();
      s.setSabBombCountdown(0);
      s.setSabVote(null);
      s.setSabCanStrike(false);
      s.setSabStrikes(0);
      s.addSystemMessage(`🕵 ${msg.starter} started Secret Saboteur mode! A saboteur lurks among you...`);
      s.addSystemMessage("Defenders can launch accusation votes. A wrong accusation gives the saboteur a strike chance.");
      break;
    }

    case "sab-role": {
      s.setSabRole(msg.role);
      if (msg.role === "saboteur") {
        s.setSabCanStrike(!!msg.canStrike);
        s.addSystemMessage("👿 YOU are the saboteur! Your first strike is ready now.");
      } else {
        s.setSabCanStrike(false);
        s.addSystemMessage("🛡 You are a defender. Find the saboteur before they strike!");
      }
      break;
    }

    case "sab-vote-start": {
      const endsAt = msg.endsAt || Date.now() + msg.duration;
      s.setSabVote({
        accuser: msg.accuser,
        suspect: msg.suspect,
        duration: msg.duration,
        endsAt,
        timerStart: endsAt - msg.duration,
      });
      s.addSystemMessage(`🕵 ACCUSATION! ${msg.accuser} accused ${msg.suspect}. Vote yes/no.`);
      break;
    }

    case "sab-vote-result": {
      s.setSabVote(null);
      if (msg.wasSaboteur) {
        stopSabBombCountdown();
        s.setSabBombCountdown(0);
        s.setSabCanStrike(false);
        s.addSystemMessage(`🎉 ${msg.accused} was the saboteur! Pillow fight incoming...`);
        s.setSabRole(null);
      } else {
        const voteText = msg.passed
          ? `❌ accusation passed (${msg.yes}-${msg.no}), but ${msg.accused} was NOT the saboteur.`
          : `⚖ accusation failed (${msg.yes}-${msg.no}). ${msg.accused} stays in.`;
        s.addSystemMessage(`${voteText} The hunt continues...`);
      }
      break;
    }

    case "sab-strike-ready": {
      if (s.sabRole === "saboteur") {
        s.setSabCanStrike(true);
        s.addSystemMessage("💣 Wrong accusation. You can strike now.");
      }
      break;
    }

    case "sab-strike": {
      s.setSabStrikes(msg.strikes);
      if (s.sabRole === "saboteur" && msg.strikes < 3) s.setSabCanStrike(false);
      if (msg.strikes >= 3) {
        s.addSystemMessage(`💥💥💥 STRIKE ${msg.strikes}/3! ${msg.saboteur} planted a bomb!`);
        s.setSabRole(null);
        s.setSabCanStrike(false);
      } else if (msg.strikes === 2) {
        s.addSystemMessage(`💥💥 STRIKE ${msg.strikes}/3! ${msg.saboteur} struck again! The fort is crumbling!`);
      } else {
        s.addSystemMessage(`💥 STRIKE ${msg.strikes}/3! The fort trembles!`);
      }
      break;
    }

    case "sab-bomb-start": {
      startSabBombCountdown(msg.seconds, msg.durationMs);
      s.addSystemMessage(`💣 ${msg.saboteur} lit the fuse. ${msg.seconds}...`);
      break;
    }

    // --- KOTH ---
    case "koth-started": {
      if (msg.challenger === s.name) {
        track("game_started", { kind: "koth", role: "guest", memberCount: s.members.length });
      }
      s.addSystemMessage(`👑 ${msg.challenger} challenges ${msg.host} for the crown! RPS duel!`);
      break;
    }

    case "koth-result": {
      s.addSystemMessage(`👑 ${msg.winner} holds the crown! ${msg.loser} is defeated.`);
      break;
    }
  }
}
