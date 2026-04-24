// --- Outgoing messages (client → server) ---

export type OutgoingMessage =
  | { type: "set-up"; name: string; auth: RoomAuthPayload }
  | { type: "join"; name: string; auth: RoomAuthPayload; room: string }
  | { type: "rejoin"; name: string; auth: RoomAuthPayload; room: string }
  | { type: "chat"; text?: string; enc?: EncryptedChatPayload; style?: ChatStyle }
  | { type: "knock-down" }
  | { type: "typing" }
  | { type: "leave" }
  | { type: "accept-host" }
  | { type: "reject-host" }
  | { type: "toss-pillow"; target: string }
  | { type: "draw"; color: string; pts: [number, number][]; s?: 1 }
  | { type: "start-vote"; target: string }
  | { type: "cast-vote"; vote: "yes" | "no" }
  | { type: "rps-challenge"; target: string }
  | { type: "rps-accept" }
  | { type: "rps-decline" }
  | { type: "rps-pick"; pick: RpsPick }
  | { type: "ttt-challenge"; target: string }
  | { type: "ttt-accept" }
  | { type: "ttt-decline" }
  | { type: "ttt-move"; cell: number }
  | { type: "sab-start" }
  | { type: "sab-accuse"; suspect: string }
  | { type: "sab-strike" }
  | { type: "sab-vote"; vote: "yes" | "no" }
  | { type: "set-status"; status: PresenceStatus; awayText?: string }
  | { type: "koth-challenge" };

// --- Incoming messages (server → client) ---

export type IncomingMessage =
  | { type: "room-created"; room: string; leaderboards?: RoomLeaderboards; gameQueue?: RoomGameQueue }
  | { type: "joined"; room: string; members: string[]; name: string; presence?: Record<string, MemberPresence>; leaderboards?: RoomLeaderboards; gameQueue?: RoomGameQueue }
  | { type: "rejoined"; room: string; members: string[]; name: string; isHost: boolean; presence?: Record<string, MemberPresence>; leaderboards?: RoomLeaderboards; gameQueue?: RoomGameQueue }
  | { type: "leaderboards"; leaderboards: RoomLeaderboards }
  | { type: "game-queue"; gameQueue: RoomGameQueue }
  | { type: "game-queued"; kind: QueueGameKind; by: string; target?: string; position: number }
  | { type: "message"; from: string; text?: string; enc?: EncryptedChatPayload; style?: ChatStyle }
  | { type: "member-joined"; name: string; presence?: MemberPresence }
  | { type: "member-left"; name: string }
  | { type: "member-away"; name: string }
  | { type: "member-back"; name: string }
  | { type: "member-status"; name: string; status: PresenceStatus; awayText?: string | null }
  | { type: "new-host"; name: string }
  | { type: "host-offer"; oldHost: string }
  | { type: "host-offered"; name: string }
  | { type: "host-ducked"; name: string }
  | { type: "knocked-down"; reason: string }
  | { type: "typing"; name: string }
  | { type: "draw"; from: string; color: string; pts: [number, number][]; s?: 1 }
  | { type: "error"; message: string }
  | { type: "ejected"; reason: string }
  // Vote
  | { type: "vote-started"; target: string; starter: string; auto?: boolean }
  | { type: "vote-cast"; voter: string; vote: "yes" | "no" }
  | { type: "vote-result"; target: string; yes: number; no: number; ejected: boolean }
  // RPS
  | { type: "rps-challenged"; from: string }
  | { type: "rps-pending"; p1: string; p2: string }
  | { type: "rps-started"; p1: string; p2: string; koth?: boolean }
  | { type: "rps-declined"; from: string }
  | { type: "rps-picked" }
  | { type: "rps-result"; p1: string; p2: string; pick1: RpsPick; pick2: RpsPick; winner: string | null; koth?: boolean }
  // TTT
  | { type: "ttt-challenged"; from: string }
  | { type: "ttt-pending"; p1: string; p2: string }
  | { type: "ttt-started"; p1: string; p2: string; board: string[]; turn: number }
  | { type: "ttt-declined"; from: string }
  | { type: "ttt-update"; board: string[]; turn: number; lastMove: number; winner: string | null; draw: boolean }
  // Saboteur
  | { type: "sab-started"; starter: string }
  | { type: "sab-role"; role: "saboteur" | "defender"; canStrike?: boolean }
  | { type: "sab-vote-start"; accuser: string; suspect: string; duration: number }
  | { type: "sab-vote-result"; accuser: string; accused: string; yes: number; no: number; passed: boolean; wasSaboteur: boolean; saboteur: string | null }
  | { type: "sab-strike-ready"; reason: "wrong-accusation" }
  | { type: "sab-strike"; saboteur: string; strikes: number }
  | { type: "sab-bomb-start"; saboteur: string; seconds: number; durationMs?: number }
  // KOTH
  | { type: "koth-started"; challenger: string; host: string }
  | { type: "koth-result"; winner: string; loser: string };

// --- Shared types ---

export interface ChatStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
}

export interface EncryptedChatPayload {
  v: 1 | 2 | 3;
  kdf?: "pbkdf2-sha256-600k-v1";
  sid?: string;
  seq?: number;
  iv: string;
  ct: string;
}

export interface RoomAuthPayload {
  v: 1;
  kdf: "pbkdf2-sha256-600k-v1";
  verifier: string;
}

export type RpsPick = "rock" | "paper" | "scissors";
export type PresenceStatus = "available" | "away";

export interface MemberPresence {
  status: PresenceStatus;
  awayText?: string;
}

export interface RoomLeaderboards {
  pillowFight: Record<string, number>;
  rps: Record<string, number>;
  ttt: Record<string, number>;
  saboteur: Record<string, number>;
  koth: Record<string, number>;
}

export type QueueGameKind = "vote" | "rps" | "ttt" | "saboteur" | "koth";

export interface GameQueueItem {
  kind: QueueGameKind;
  by: string;
  target?: string;
}

export interface RoomGameQueue {
  current: GameQueueItem | null;
  queue: GameQueueItem[];
}

export type Screen = "home" | "setup" | "join" | "chat" | "knocked";

export interface ChatMessage {
  id: number;
  kind: "chat" | "system";
  from?: string;
  text: string;
  style?: ChatStyle;
  timestamp: string;
}
