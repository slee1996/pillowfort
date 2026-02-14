import { useGameStore } from "../stores/gameStore";
import { playDoorOpen, playDoorClose, playMsgSound } from "../hooks/useSound";
import { requestWakeLock, releaseWakeLock } from "../hooks/useWakeLock";
import type { IncomingMessage } from "./protocol";

const SABOTEUR_EXPLOSION_MS = 1200;
let sabBombInterval: ReturnType<typeof setInterval> | null = null;
let sabBombEndsAt = 0;

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

export function handleMessage(msg: IncomingMessage) {
  const s = useGameStore.getState();

  switch (msg.type) {
    case "room-created": {
      s.setRoomId(msg.room);
      s.setIsHost(true);
      s.setMembers([s.name]);
      s.setMemberPresenceMap({ [s.name]: { status: "available" } });
      s.setScreen("chat");
      s.clearMessages();
      s.addSystemMessage("Welcome to the fort.");
      s.addSystemMessage(`Fort: ${msg.room} — Password: ${s.password}`);
      s.addSystemMessage("Share the fort flag and password to let your friends in.");
      playDoorOpen();
      requestWakeLock();
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
      s.setScreen("chat");
      s.clearMessages();
      if (renamed) s.addSystemMessage(`That name's taken — you're ${msg.name} now`);
      s.addSystemMessage(`You're inside. ${msg.members.length} people in the fort.`);
      playDoorOpen();
      requestWakeLock();
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
      s.addSystemMessage("Reconnected!");
      requestWakeLock();
      break;
    }

    case "message": {
      if (!s.mutedNames.has(msg.from)) {
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
      s.addSystemMessage(`⚔ PILLOW FIGHT! ${msg.starter} wants to kick ${msg.target}!`);
      s.setActiveVote({
        target: msg.target,
        starter: msg.starter,
        auto: msg.auto,
        timerStart: Date.now(),
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
      stopSabBombCountdown();
      s.setSabBombCountdown(0);
      s.addSystemMessage(`🕵 ${msg.starter} started Secret Saboteur mode! A saboteur lurks among you...`);
      s.addSystemMessage("The saboteur can strike at any time. Every 60s, you vote on who you think it is.");
      break;
    }

    case "sab-role": {
      s.setSabRole(msg.role);
      if (msg.role === "saboteur") {
        s.addSystemMessage("👿 YOU are the saboteur! Strike when the time is right, or stay hidden.");
      } else {
        s.addSystemMessage("🛡 You are a defender. Find the saboteur before they strike!");
      }
      break;
    }

    case "sab-vote-start": {
      s.addSystemMessage("🕵 VOTE TIME! Who is the saboteur?");
      s.setSabVoteActive(true);
      break;
    }

    case "sab-vote-result": {
      s.setSabVoteActive(false);
      if (msg.wasSaboteur) {
        stopSabBombCountdown();
        s.setSabBombCountdown(0);
        s.addSystemMessage(`🎉 ${msg.accused} was the saboteur! Pillow fight incoming...`);
        s.setSabRole(null);
      } else {
        s.addSystemMessage(`❌ ${msg.accused} was NOT the saboteur. The hunt continues...`);
      }
      break;
    }

    case "sab-strike": {
      s.setSabStrikes(msg.strikes);
      if (msg.strikes >= 3) {
        s.addSystemMessage(`💥💥💥 STRIKE ${msg.strikes}/3! ${msg.saboteur} planted a bomb!`);
        s.setSabRole(null);
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
      s.addSystemMessage(`👑 ${msg.challenger} challenges ${msg.host} for the crown! RPS duel!`);
      break;
    }

    case "koth-result": {
      s.addSystemMessage(`👑 ${msg.winner} holds the crown! ${msg.loser} is defeated.`);
      break;
    }
  }
}
