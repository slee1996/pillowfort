/* tslint:disable */
/* eslint-disable */

export class MlsSession {
    free(): void;
    [Symbol.dispose](): void;
    add(key_package: Uint8Array): MlsTransition;
    encrypt(plaintext: Uint8Array): MlsTransition;
    is_active(): boolean;
    join(welcome: Uint8Array, ratchet_tree: Uint8Array): MlsTransition;
    key_package(): MlsTransition;
    constructor(room_binding: Uint8Array, identity: Uint8Array, founder: boolean);
    receive(message: Uint8Array): MlsTransition;
    remove(leaf_index: number): MlsTransition;
    static restore(expected_room_binding: Uint8Array, snapshot: Uint8Array): MlsSession;
    roster(): Array<any>;
    self_update(): MlsTransition;
    sign(data: Uint8Array): Uint8Array;
    snapshot(): Uint8Array;
}

export class MlsTransition {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly commit_add_count: number;
    readonly commit_has_update_path: boolean;
    readonly commit_other_count: number;
    readonly commit_remove_count: number;
    readonly commit_update_count: number;
    readonly epoch: bigint;
    readonly kind: number;
    readonly outbound: Uint8Array;
    readonly plaintext: Uint8Array;
    readonly ratchet_tree: Uint8Array;
    readonly sender_identity: Uint8Array;
    readonly sender_leaf_index: number;
    readonly snapshot: Uint8Array;
    readonly welcome: Uint8Array;
}

export class RosterEntry {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly identity: Uint8Array;
    readonly index: number;
    readonly signature_key: Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mlssession_free: (a: number, b: number) => void;
    readonly __wbg_mlstransition_free: (a: number, b: number) => void;
    readonly __wbg_rosterentry_free: (a: number, b: number) => void;
    readonly mlssession_add: (a: number, b: number, c: number) => void;
    readonly mlssession_encrypt: (a: number, b: number, c: number) => void;
    readonly mlssession_is_active: (a: number) => number;
    readonly mlssession_join: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_key_package: (a: number, b: number) => void;
    readonly mlssession_new: (a: number, b: number, c: number, d: number) => void;
    readonly mlssession_receive: (a: number, b: number, c: number) => void;
    readonly mlssession_remove: (a: number, b: number, c: number) => void;
    readonly mlssession_restore: (a: number, b: number, c: number) => void;
    readonly mlssession_roster: (a: number, b: number) => void;
    readonly mlssession_self_update: (a: number, b: number) => void;
    readonly mlssession_sign: (a: number, b: number, c: number) => void;
    readonly mlssession_snapshot: (a: number, b: number) => void;
    readonly mlstransition_commit_add_count: (a: number) => number;
    readonly mlstransition_commit_has_update_path: (a: number) => number;
    readonly mlstransition_commit_other_count: (a: number) => number;
    readonly mlstransition_commit_remove_count: (a: number) => number;
    readonly mlstransition_commit_update_count: (a: number) => number;
    readonly mlstransition_epoch: (a: number) => bigint;
    readonly mlstransition_kind: (a: number) => number;
    readonly mlstransition_outbound: (a: number) => number;
    readonly mlstransition_plaintext: (a: number) => number;
    readonly mlstransition_ratchet_tree: (a: number) => number;
    readonly mlstransition_sender_identity: (a: number) => number;
    readonly mlstransition_sender_leaf_index: (a: number) => number;
    readonly mlstransition_snapshot: (a: number) => number;
    readonly mlstransition_welcome: (a: number) => number;
    readonly rosterentry_identity: (a: number) => number;
    readonly rosterentry_index: (a: number) => number;
    readonly rosterentry_signature_key: (a: number) => number;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
