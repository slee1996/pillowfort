import type { SecureRoomStateSnapshotV4 } from "../../../src/applicationEventsV4";
import type { SecureReducerEffectV4 } from "../../../src/secureGameReducer";
import { playDoorClose, playDoorOpen, playMsgSound } from "../hooks/useSound";
import { requestWakeLock } from "../hooks/useWakeLock";
import { useGameStore, type RpsState, type TttState } from "../stores/gameStore";
import type { GameQueueItem, RoomGameQueue, RoomLeaderboards } from "./protocol";

const VOTE_DURATION_MS = 30_000;
const SABOTEUR_VOTE_DURATION_MS = 30_000;
const RPS_EMOJI: Record<string, string> = { rock: "✊", paper: "🖐️", scissors: "✌️" };
const MAX_DISPLAYED_EVENT_IDS = 1_024;

let currentRoomInstance: string | null = null;
let knownDeviceIds = new Set<string>();
let displayedMessageIds = new Set<string>();
let displayedDrawingIds = new Set<string>();

function rememberDisplayedId(ledger: Set<string>, eventId: string): boolean {
  if (ledger.has(eventId)) return false;
  ledger.add(eventId);
  if (ledger.size > MAX_DISPLAYED_EVENT_IDS) {
    const oldest = ledger.values().next().value;
    if (typeof oldest === "string") ledger.delete(oldest);
  }
  return true;
}

function nameFor(state: SecureRoomStateSnapshotV4, deviceId: string | null): string {
  if (!deviceId) return "unknown";
  return state.members.find((member) => member.deviceId === deviceId)?.displayName ?? "unknown";
}

export function secureDeviceIdForNameV4(state: SecureRoomStateSnapshotV4, displayName: string): string | null {
  const folded = displayName.toLowerCase();
  return state.members.find((member) => member.displayName.toLowerCase() === folded)?.deviceId ?? null;
}

function leaderboards(state: SecureRoomStateSnapshotV4): RoomLeaderboards {
  const output: RoomLeaderboards = {
    pillowFight: Object.create(null) as Record<string, number>,
    rps: Object.create(null) as Record<string, number>,
    ttt: Object.create(null) as Record<string, number>,
    saboteur: Object.create(null) as Record<string, number>,
    koth: Object.create(null) as Record<string, number>,
  };
  for (const entry of state.leaderboards) {
    const name = nameFor(state, entry.deviceId);
    if (name === "unknown") continue;
    output.pillowFight[name] = entry.pillowFight;
    output.rps[name] = entry.rps;
    output.ttt[name] = entry.ttt;
    output.saboteur[name] = entry.saboteur;
    output.koth[name] = entry.koth;
  }
  return output;
}

function queueItem(
  state: SecureRoomStateSnapshotV4,
  item: SecureRoomStateSnapshotV4["queue"][number],
): GameQueueItem {
  return {
    kind: item.game,
    by: nameFor(state, item.byDeviceId),
    ...(item.targetDeviceId && { target: nameFor(state, item.targetDeviceId) }),
  };
}

function currentGame(state: SecureRoomStateSnapshotV4): GameQueueItem | null {
  if (state.vote) return { kind: "vote", by: nameFor(state, state.vote.starterDeviceId), target: nameFor(state, state.vote.targetDeviceId) };
  if (state.rps) return {
    kind: state.rps.koth ? "koth" : "rps",
    by: nameFor(state, state.rps.p1DeviceId),
    target: nameFor(state, state.rps.p2DeviceId),
  };
  if (state.ttt) return { kind: "ttt", by: nameFor(state, state.ttt.p1DeviceId), target: nameFor(state, state.ttt.p2DeviceId) };
  if (state.saboteur) return { kind: "saboteur", by: nameFor(state, state.saboteur.starterDeviceId) };
  return null;
}

function gameQueue(state: SecureRoomStateSnapshotV4): RoomGameQueue {
  return { current: currentGame(state), queue: state.queue.map((item) => queueItem(state, item)) };
}

function syncGames(state: SecureRoomStateSnapshotV4, ownDeviceId: string): void {
  const store = useGameStore.getState();
  if (state.vote) {
    const target = nameFor(state, state.vote.targetDeviceId);
    const starter = nameFor(state, state.vote.starterDeviceId);
    const current = store.activeVote;
    const existing = current?.target === target && current.starter === starter ? current : null;
    store.setActiveVote(existing ?? {
      target,
      starter,
      duration: VOTE_DURATION_MS,
      timerStart: Date.now(),
      endsAt: Date.now() + VOTE_DURATION_MS,
      ...(state.vote.votes.find((vote) => vote.deviceId === ownDeviceId)?.choice
        ? { myVote: state.vote.votes.find((vote) => vote.deviceId === ownDeviceId)!.choice }
        : {}),
    });
  } else {
    store.setActiveVote(null);
  }

  if (state.rps && (state.rps.p1DeviceId === ownDeviceId || state.rps.p2DeviceId === ownDeviceId)) {
    const p1 = nameFor(state, state.rps.p1DeviceId);
    const p2 = nameFor(state, state.rps.p2DeviceId);
    const current = store.rpsState;
    if (state.rps.phase === "pending") {
      store.setRpsState(state.rps.p2DeviceId === ownDeviceId
        ? { p1, p2, phase: "challenged", challengedBy: p1, koth: state.rps.koth }
        : { p1, p2, phase: "waiting", koth: state.rps.koth });
    } else {
      store.setRpsState({
        p1, p2, phase: "picking", koth: state.rps.koth,
        ...(current?.p1 === p1 && current.p2 === p2 && current.myPick ? { myPick: current.myPick } : {}),
      });
    }
  } else {
    store.setRpsState(null);
  }

  if (state.ttt && (state.ttt.p1DeviceId === ownDeviceId || state.ttt.p2DeviceId === ownDeviceId)) {
    const p1 = nameFor(state, state.ttt.p1DeviceId);
    const p2 = nameFor(state, state.ttt.p2DeviceId);
    store.setTttState({
      p1,
      p2,
      myMark: state.ttt.p1DeviceId === ownDeviceId ? "X" : "O",
      board: [...state.ttt.board],
      turn: state.ttt.turn,
      winner: null,
      draw: false,
      phase: state.ttt.phase === "pending"
        ? state.ttt.p2DeviceId === ownDeviceId ? "challenged" : "waiting"
        : "playing",
      ...(state.ttt.phase === "pending" ? { challengedBy: p1 } : {}),
    });
  } else {
    store.setTttState(null);
  }

  if (state.saboteur?.phase === "playing" && state.saboteur.saboteurDeviceId) {
    const isSaboteur = state.saboteur.saboteurDeviceId === ownDeviceId;
    store.setSabRole(isSaboteur ? "saboteur" : "defender");
    store.setSabCanStrike(isSaboteur && state.saboteur.canStrike);
    store.setSabStrikes(state.saboteur.strikes);
    const accusation = state.saboteur.accusation;
    if (accusation) {
      const existing = store.sabVote;
      const accuser = nameFor(state, accusation.accuserDeviceId);
      const suspect = nameFor(state, accusation.suspectDeviceId);
      store.setSabVote(existing?.accuser === accuser && existing.suspect === suspect ? existing : {
        accuser,
        suspect,
        duration: SABOTEUR_VOTE_DURATION_MS,
        timerStart: Date.now(),
        endsAt: Date.now() + SABOTEUR_VOTE_DURATION_MS,
        ...(accusation.votes.find((vote) => vote.deviceId === ownDeviceId)?.choice
          ? { myVote: accusation.votes.find((vote) => vote.deviceId === ownDeviceId)!.choice }
          : {}),
      });
    } else {
      store.setSabVote(null);
    }
  } else {
    store.setSabRole(null);
    store.setSabCanStrike(false);
    store.setSabVote(null);
    if (!state.saboteur) store.setSabStrikes(0);
  }
}

function syncPersistent(state: SecureRoomStateSnapshotV4, ownDeviceId: string): void {
  const store = useGameStore.getState();
  const host = state.hostDeviceId;
  const ordered = [...state.members].sort((left, right) =>
    left.deviceId === host ? -1 : right.deviceId === host ? 1 : left.displayName < right.displayName ? -1 : left.displayName > right.displayName ? 1 : 0
  );
  store.setMembers(ordered.map((member) => member.displayName));
  const presence = Object.create(null) as Record<string, { status: "available" | "away"; awayText?: string }>;
  for (const member of ordered) {
    presence[member.displayName] = {
      status: member.status,
      ...(member.awayText ? { awayText: member.awayText } : {}),
    };
  }
  store.setMemberPresenceMap(presence);
  store.setIsHost(host === ownDeviceId);
  store.setRoomTheme(state.theme);
  store.setLeaderboards(leaderboards(state));
  store.setGameQueue(gameQueue(state));
  syncGames(state, ownDeviceId);
}

export function initializeSecureRoomUiV4(options: {
  roomId: string;
  ownDeviceId: string;
  state: SecureRoomStateSnapshotV4;
  resumed?: boolean;
}): void {
  const { roomId, ownDeviceId, state } = options;
  currentRoomInstance = state.roomInstance;
  knownDeviceIds = new Set(state.members.map((member) => member.deviceId));
  displayedMessageIds = new Set();
  displayedDrawingIds = new Set();
  const store = useGameStore.getState();
  store.setRoomId(roomId);
  store.clearMessages();
  syncPersistent(state, ownDeviceId);
  store.setScreen("chat");
  store.addSystemMessage(options.resumed ? "Reconnected securely." : "Welcome to the secure fort.");
  store.addSystemMessage(`Fort flag: ${roomId}`);
  if (!options.resumed) store.addSystemMessage("Share the fort flag and room secret privately to let your friends in.");
  playDoorOpen();
  void requestWakeLock();
}

export function applySecureRoomUiV4(
  state: SecureRoomStateSnapshotV4,
  effects: readonly SecureReducerEffectV4[],
  ownDeviceId: string,
): void {
  if (currentRoomInstance !== state.roomInstance) return;
  const storeBefore = useGameStore.getState();
  const previousRps = storeBefore.rpsState;
  const previousTtt = storeBefore.tttState;
  const previousKnown = knownDeviceIds;
  syncPersistent(state, ownDeviceId);
  const store = useGameStore.getState();

  for (const effect of effects) {
    switch (effect.type) {
      case "profile":
        if (effect.deviceId !== ownDeviceId && !previousKnown.has(effect.deviceId)) {
          store.addSystemMessage(`${effect.displayName} entered the fort.`);
          playDoorOpen();
        }
        break;
      case "presence": {
        const name = nameFor(state, effect.deviceId);
        if (name !== "unknown") store.addSystemMessage(effect.status === "away"
          ? `${name} is away${effect.awayText ? `: ${effect.awayText}` : "."}`
          : `${name} is back.`);
        break;
      }
      case "chat":
        if (rememberDisplayedId(displayedMessageIds, effect.eventId) && !store.mutedNames.has(effect.displayName)) {
          store.addChatMessage(effect.displayName, effect.text, effect.style ?? undefined);
          if (store.minimized) store.incrementUnread();
          playMsgSound();
        }
        break;
      case "typing":
        window.dispatchEvent(new CustomEvent("pf-typing", { detail: effect.displayName }));
        break;
      case "drawing": {
        if (rememberDisplayedId(displayedDrawingIds, effect.eventId)) {
          window.dispatchEvent(new CustomEvent("pf-draw", { detail: {
            from: effect.displayName, color: effect.color, pts: effect.points,
            ...(effect.strokeStart ? { s: 1 } : {}),
          } }));
        }
        break;
      }
      case "member-removed": {
        const oldName = storeBefore.members.find((candidate) =>
          !state.members.some((member) => member.displayName === candidate)
        );
        if (oldName) store.addSystemMessage(`${oldName} left the fort.`);
        playDoorClose();
        break;
      }
      case "host-offered":
        if (effect.deviceId === ownDeviceId) store.setHostOffer({ oldHost: nameFor(state, state.hostDeviceId) });
        break;
      case "pillow-tossed":
        store.addSystemMessage(`${nameFor(state, effect.fromDeviceId)} tossed the pillow to ${nameFor(state, effect.targetDeviceId)}.`);
        break;
      case "host-changed":
        store.setHostOffer(null);
        store.addSystemMessage(`${nameFor(state, effect.deviceId)} caught the pillow. they're the new host.`);
        break;
      case "host-rejected":
        store.setHostOffer(null);
        store.addSystemMessage(`${nameFor(state, effect.deviceId)} ducked.`);
        break;
      case "room-closed":
        store.addSystemMessage(`${effect.reason} Secure shutdown is finishing…`);
        break;
      case "game-cancelled":
        store.addSystemMessage(`${effect.game.toUpperCase()} ${effect.forfeited ? "ended by forfeit" : "was cancelled"}.`);
        break;
      case "vote-started":
        store.addSystemMessage(`⚔ PILLOW FIGHT! ${nameFor(state, effect.starterDeviceId)} wants to kick ${nameFor(state, effect.targetDeviceId)}!`);
        break;
      case "vote-result":
        store.addSystemMessage(effect.ejected
          ? `💥 ${nameFor(state, effect.targetDeviceId)} was voted out! (${effect.yes}-${effect.no})`
          : `${nameFor(state, effect.targetDeviceId)} survives the pillow fight! (${effect.yes}-${effect.no})`);
        break;
      case "rps-challenged":
        break;
      case "rps-started":
        store.addSystemMessage(`✊ ${nameFor(state, effect.p1DeviceId)} vs ${nameFor(state, effect.p2DeviceId)} — Rock Paper Scissors!${effect.koth ? " (King of the Hill!)" : ""}`);
        break;
      case "rps-declined":
        store.addSystemMessage(`${nameFor(state, effect.byDeviceId)} declined the RPS challenge.`);
        break;
      case "rps-result": {
        const p1 = nameFor(state, effect.p1DeviceId);
        const p2 = nameFor(state, effect.p2DeviceId);
        const winner = effect.winnerDeviceId ? nameFor(state, effect.winnerDeviceId) : null;
        const line = `${p1} ${RPS_EMOJI[effect.pick1]} vs ${RPS_EMOJI[effect.pick2]} ${p2}`;
        store.addSystemMessage(winner ? `${line} — ${winner} wins!${effect.koth ? " 👑" : ""}` : `${line} — Draw!`);
        if (previousRps && (effect.p1DeviceId === ownDeviceId || effect.p2DeviceId === ownDeviceId)) {
          store.setRpsState({ ...previousRps, phase: "result", result: { pick1: effect.pick1, pick2: effect.pick2, winner } });
        }
        break;
      }
      case "ttt-challenged":
        break;
      case "ttt-started":
        store.addSystemMessage(`⬜ ${nameFor(state, effect.p1DeviceId)} (X) vs ${nameFor(state, effect.p2DeviceId)} (O) — Tic-Tac-Toe!`);
        break;
      case "ttt-declined":
        store.addSystemMessage(`${nameFor(state, effect.byDeviceId)} declined the Tic-Tac-Toe challenge.`);
        break;
      case "ttt-updated":
        break;
      case "ttt-result": {
        const winner = effect.winnerDeviceId ? nameFor(state, effect.winnerDeviceId) : null;
        store.addSystemMessage(winner ? `⬜ ${winner} wins Tic-Tac-Toe!` : "⬜ Tic-Tac-Toe ended in a draw!");
        if (previousTtt) {
          // The reducer emits the terminal move immediately before the result
          // and then clears the durable active-game slot. `syncPersistent`
          // therefore cannot supply the final board. Fold that exact,
          // same-game move into the retained overlay state so the winning mark
          // and win-line highlight are not lost on the result screen.
          const terminalMove = effects.find((candidate) =>
            candidate.type === "ttt-updated" && candidate.gameId === effect.gameId);
          const board = [...previousTtt.board];
          if (terminalMove?.type === "ttt-updated") board[terminalMove.cell] = terminalMove.mark;
          store.setTttState({
            ...previousTtt,
            board,
            turn: terminalMove?.type === "ttt-updated" ? terminalMove.turn : previousTtt.turn,
            winner,
            draw: effect.draw,
            phase: "result",
          });
        }
        break;
      }
      case "saboteur-started":
        store.addSystemMessage(`🕵 ${nameFor(state, effect.starterDeviceId)} started Secret Saboteur mode!`);
        break;
      case "saboteur-ready":
        store.addSystemMessage(effect.saboteurDeviceId === ownDeviceId
          ? "👿 YOU are the saboteur! Your first strike is ready now."
          : "🛡 You are a defender. Find the saboteur before they strike!");
        break;
      case "saboteur-accusation":
        store.addSystemMessage(`🕵 ACCUSATION! ${nameFor(state, effect.accuserDeviceId)} accused ${nameFor(state, effect.suspectDeviceId)}. Vote yes/no.`);
        break;
      case "saboteur-vote-result":
        store.addSystemMessage(effect.wasSaboteur
          ? `🎉 ${nameFor(state, effect.suspectDeviceId)} was the saboteur! (${effect.yes}-${effect.no})`
          : `${effect.passed ? "❌ accusation passed" : "⚖ accusation failed"} (${effect.yes}-${effect.no}). The hunt continues...`);
        break;
      case "saboteur-strike":
        store.addSystemMessage(`💥 STRIKE ${effect.strikes}/3!${effect.strikes >= 3 ? ` ${nameFor(state, effect.saboteurDeviceId)} planted a bomb!` : ""}`);
        break;
      case "koth-started":
        store.addSystemMessage(`👑 ${nameFor(state, effect.challengerDeviceId)} challenges ${nameFor(state, effect.hostDeviceId)} for the crown!`);
        break;
      case "queue-changed":
      case "theme-changed":
      case "member-removal-request":
      case "snapshot-restored":
        break;
    }
  }
  knownDeviceIds = new Set(state.members.map((member) => member.deviceId));
}

export function resetSecureRoomUiV4(): void {
  currentRoomInstance = null;
  knownDeviceIds.clear();
  displayedMessageIds.clear();
  displayedDrawingIds.clear();
}
