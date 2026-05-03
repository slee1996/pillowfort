import { create } from "zustand";
import type { Screen, ChatMessage, ChatStyle, RpsPick, MemberPresence, PresenceStatus, RoomLeaderboards, RoomGameQueue, RoomTheme, FortPassRoomPerks } from "../services/protocol";
import { clearChatCryptoState } from "../services/chatCrypto";

let msgId = 0;

function emptyLeaderboards(): RoomLeaderboards {
  return {
    pillowFight: {},
    rps: {},
    ttt: {},
    saboteur: {},
    koth: {},
  };
}

function emptyGameQueue(): RoomGameQueue {
  return {
    current: null,
    queue: [],
  };
}

export interface VoteState {
  target: string;
  starter: string;
  auto?: boolean;
  myVote?: "yes" | "no";
  duration: number;
  timerStart: number;
  endsAt: number;
}

export interface RpsState {
  p1: string;
  p2: string;
  koth?: boolean;
  myPick?: RpsPick;
  result?: { pick1: RpsPick; pick2: RpsPick; winner: string | null };
  phase: "challenged" | "picking" | "result";
  challengedBy?: string;
}

export interface TttState {
  p1: string;
  p2: string;
  myMark: "X" | "O";
  board: string[];
  turn: number;
  winner: string | null;
  draw: boolean;
  phase: "challenged" | "playing" | "result";
  challengedBy?: string;
}

export interface SabVoteState {
  accuser: string;
  suspect: string;
  duration: number;
  timerStart: number;
  endsAt: number;
  myVote?: "yes" | "no";
}

export interface GameStore {
  // Connection
  screen: Screen;
  name: string;
  roomId: string | null;
  password: string | null;
  roomSafetyCode: string | null;
  isHost: boolean;
  roomTheme: RoomTheme;
  fortPass: FortPassRoomPerks | null;

  // Room
  members: string[];
  memberPresence: Record<string, MemberPresence>;
  mutedNames: Set<string>;
  buddyListCollapsed: boolean;
  unreadCount: number;

  // Reconnect
  reconnecting: boolean;
  reconnectAttempts: number;
  intentionalLeave: boolean;

  // Messages
  messages: ChatMessage[];

  // Games
  activeVote: VoteState | null;
  rpsState: RpsState | null;
  tttState: TttState | null;
  sabRole: "saboteur" | "defender" | null;
  sabVote: SabVoteState | null;
  sabCanStrike: boolean;
  sabStrikes: number;
  sabBombCountdown: number;
  sabDetonateSignal: number;
  leaderboards: RoomLeaderboards;
  gameQueue: RoomGameQueue;

  // Host offer
  hostOffer: { oldHost: string } | null;

  // Minimized
  minimized: boolean;

  // Pending room from URL
  pendingRoom: string | null;
  pendingFortPass: { code: string; sessionId: string } | null;
  activityRoomId: string | null;
  activitySource: string | null;

  // Error
  errorMessage: string | null;
  errorTimer: ReturnType<typeof setTimeout> | null;

  // Actions
  setScreen: (screen: Screen) => void;
  setName: (name: string) => void;
  setRoomId: (roomId: string | null) => void;
  setPassword: (password: string | null) => void;
  setRoomSafetyCode: (code: string | null) => void;
  setIsHost: (isHost: boolean) => void;
  setRoomTheme: (theme: RoomTheme) => void;
  setFortPass: (fortPass: FortPassRoomPerks | null) => void;
  setMembers: (members: string[]) => void;
  setMemberPresenceMap: (presence: Record<string, MemberPresence>) => void;
  setMemberPresence: (name: string, status: PresenceStatus, awayText?: string) => void;
  clearMemberPresence: (name: string) => void;
  addMember: (name: string) => void;
  removeMember: (name: string) => void;
  toggleMute: (name: string) => boolean;
  addMessage: (msg: Omit<ChatMessage, "id">) => void;
  addSystemMessage: (text: string) => void;
  addChatMessage: (from: string, text: string, style?: ChatStyle) => void;
  clearMessages: () => void;
  setActiveVote: (vote: VoteState | null) => void;
  setRpsState: (rps: RpsState | null) => void;
  setTttState: (ttt: TttState | null) => void;
  setSabRole: (role: "saboteur" | "defender" | null) => void;
  setSabVote: (vote: SabVoteState | null) => void;
  setSabVoteChoice: (vote: "yes" | "no") => void;
  setSabCanStrike: (canStrike: boolean) => void;
  setSabStrikes: (strikes: number) => void;
  setSabBombCountdown: (seconds: number) => void;
  triggerSabDetonation: () => void;
  setLeaderboards: (leaderboards: RoomLeaderboards) => void;
  setGameQueue: (gameQueue: RoomGameQueue) => void;
  setHostOffer: (offer: { oldHost: string } | null) => void;
  setMinimized: (minimized: boolean) => void;
  incrementUnread: () => void;
  resetUnread: () => void;
  setReconnecting: (reconnecting: boolean) => void;
  setReconnectAttempts: (attempts: number) => void;
  setIntentionalLeave: (intentional: boolean) => void;
  setPendingRoom: (room: string | null) => void;
  setPendingFortPass: (fortPass: { code: string; sessionId: string } | null) => void;
  setActivityContext: (roomId: string | null, source?: string | null) => void;
  showError: (message: string) => void;
  cleanup: () => void;
}

function timeStr(): string {
  const d = new Date();
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s} ${ap}`;
}

export const useGameStore = create<GameStore>((set, get) => ({
  // Connection
  screen: "home",
  name: localStorage.getItem("pillowfort-name") || "",
  roomId: null,
  password: null,
  roomSafetyCode: null,
  isHost: false,
  roomTheme: "classic",
  fortPass: null,

  // Room
  members: [],
  memberPresence: {},
  mutedNames: new Set(),
  buddyListCollapsed: false,
  unreadCount: 0,

  // Reconnect
  reconnecting: false,
  reconnectAttempts: 0,
  intentionalLeave: false,

  // Messages
  messages: [],

  // Games
  activeVote: null,
  rpsState: null,
  tttState: null,
  sabRole: null,
  sabVote: null,
  sabCanStrike: false,
  sabStrikes: 0,
  sabBombCountdown: 0,
  sabDetonateSignal: 0,
  leaderboards: emptyLeaderboards(),
  gameQueue: emptyGameQueue(),

  // Host offer
  hostOffer: null,

  // Minimized
  minimized: false,

  // Pending room
  pendingRoom: null,
  pendingFortPass: null,
  activityRoomId: null,
  activitySource: null,

  // Error
  errorMessage: null,
  errorTimer: null,

  // Actions
  setScreen: (screen) => set({ screen }),
  setName: (name) => {
    localStorage.setItem("pillowfort-name", name);
    set({ name });
  },
  setRoomId: (roomId) => set({ roomId }),
  setPassword: (password) => set({ password }),
  setRoomSafetyCode: (roomSafetyCode) => set({ roomSafetyCode }),
  setIsHost: (isHost) => set({ isHost }),
  setRoomTheme: (roomTheme) => set({ roomTheme }),
  setFortPass: (fortPass) => set({ fortPass }),
  setMembers: (members) => set({ members }),
  setMemberPresenceMap: (presence) => set({ memberPresence: presence }),
  setMemberPresence: (name, status, awayText) =>
    set((s) => ({
      memberPresence: {
        ...s.memberPresence,
        [name]: {
          status,
          ...(awayText?.trim() ? { awayText: awayText.trim().slice(0, 120) } : {}),
        },
      },
    })),
  clearMemberPresence: (name) =>
    set((s) => {
      const next = { ...s.memberPresence };
      delete next[name];
      return { memberPresence: next };
    }),
  addMember: (name) => set((s) => ({ members: [...s.members, name] })),
  removeMember: (name) =>
    set((s) => ({
      members: s.members.filter((n) => n !== name),
      memberPresence: (() => {
        const next = { ...s.memberPresence };
        delete next[name];
        return next;
      })(),
      mutedNames: (() => {
        const next = new Set(s.mutedNames);
        next.delete(name);
        return next;
      })(),
    })),
  toggleMute: (name) => {
    const s = get();
    const next = new Set(s.mutedNames);
    const wasMuted = next.has(name);
    if (wasMuted) next.delete(name);
    else next.add(name);
    set({ mutedNames: next });
    return !wasMuted;
  },

  addMessage: (msg) =>
    set((s) => ({
      messages: [...s.messages, { ...msg, id: ++msgId }],
    })),

  addSystemMessage: (text) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { id: ++msgId, kind: "system", text, timestamp: timeStr() },
      ],
    })),

  addChatMessage: (from, text, style) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { id: ++msgId, kind: "chat", from, text, style, timestamp: timeStr() },
      ],
    })),

  clearMessages: () => set({ messages: [] }),

  setActiveVote: (vote) => set({ activeVote: vote }),
  setRpsState: (rps) => set({ rpsState: rps }),
  setTttState: (ttt) => set({ tttState: ttt }),
  setSabRole: (role) => set({ sabRole: role }),
  setSabVote: (vote) => set({ sabVote: vote }),
  setSabVoteChoice: (vote) =>
    set((s) => (s.sabVote ? { sabVote: { ...s.sabVote, myVote: vote } } : {})),
  setSabCanStrike: (canStrike) => set({ sabCanStrike: canStrike }),
  setSabStrikes: (strikes) => set({ sabStrikes: strikes }),
  setSabBombCountdown: (seconds) => set({ sabBombCountdown: Math.max(0, seconds) }),
  triggerSabDetonation: () => set((s) => ({ sabDetonateSignal: s.sabDetonateSignal + 1 })),
  setLeaderboards: (leaderboards) => set({ leaderboards }),
  setGameQueue: (gameQueue) => set({ gameQueue }),
  setHostOffer: (offer) => set({ hostOffer: offer }),
  setMinimized: (minimized) => set({ minimized }),
  incrementUnread: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
  resetUnread: () => set({ unreadCount: 0 }),
  setReconnecting: (reconnecting) => set({ reconnecting }),
  setReconnectAttempts: (attempts) => set({ reconnectAttempts: attempts }),
  setIntentionalLeave: (intentional) => set({ intentionalLeave: intentional }),
  setPendingRoom: (room) => set({ pendingRoom: room }),
  setPendingFortPass: (fortPass) => set({ pendingFortPass: fortPass }),
  setActivityContext: (roomId, source = null) => set({ activityRoomId: roomId, activitySource: source }),

  showError: (message) => {
    const prev = get().errorTimer;
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => set({ errorMessage: null, errorTimer: null }), 3000);
    set({ errorMessage: message, errorTimer: timer });
  },

  cleanup: () => {
    clearChatCryptoState();
    set({
      roomId: null,
      password: null,
      roomSafetyCode: null,
      isHost: false,
      roomTheme: "classic",
      fortPass: null,
      members: [],
      memberPresence: {},
      mutedNames: new Set(),
      reconnecting: false,
      reconnectAttempts: 0,
      intentionalLeave: false,
      hostOffer: null,
      activeVote: null,
      rpsState: null,
      tttState: null,
      sabRole: null,
      sabVote: null,
      sabCanStrike: false,
      sabStrikes: 0,
      sabBombCountdown: 0,
      sabDetonateSignal: 0,
      leaderboards: emptyLeaderboards(),
      gameQueue: emptyGameQueue(),
      unreadCount: 0,
      minimized: false,
    });
  },
}));
