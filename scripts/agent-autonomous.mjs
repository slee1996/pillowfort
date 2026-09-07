#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { PillowfortAgent, AgentError } from './agent-sdk.mjs';

const HELP = `Pillowfort autonomous two-agent example

  pillowfort-agent autonomous --url https://pillowfort.xyz
  node scripts/agent-autonomous.mjs --url http://localhost:3000

Options:
  --url URL          Explicit HTTPS or loopback HTTP app URL (or PILLOWFORT_URL).
  --timeout-ms MS    Per-transition deadline, 1000–60000 (default 30000).
  --help, -h         Show this help without opening a browser.

Running this example authorizes one ephemeral agent-host to create one room,
privately invite its isolated agent-guest, verify and explicitly approve only
that guest fingerprint, exchange two small messages, and end the room.
No human or UI clicks are needed. No payment, directory, or stranger approval.
Requires local Node + installed Playwright Chromium and a running agent-enabled
Pillowfort app. Only safe step outcomes are printed, never invitations, keys,
fingerprints, room identifiers, or chat transcript. Credentials stay in memory.
`;

function parseArguments(argv) {
  const options = { baseURL: process.env.PILLOWFORT_URL, timeoutMs: 30_000 };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag !== '--url' && flag !== '--timeout-ms') throw new AgentError('INVALID_INPUT', 'Unknown option. Use --help.');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new AgentError('INVALID_INPUT', 'Option requires a value. Use --help.');
    if (flag === '--url') options.baseURL = value;
    else {
      if (!/^\d+$/.test(value)) throw new AgentError('INVALID_INPUT', 'timeout-ms must be an integer.');
      options.timeoutMs = Number(value);
    }
  }
  if (!options.baseURL) throw new AgentError('INVALID_ORIGIN', 'Provide --url or PILLOWFORT_URL.');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60_000) {
    throw new AgentError('INVALID_INPUT', 'timeout-ms must be from 1000 to 60000.');
  }
  return options;
}

function safeCode(error) {
  return error instanceof AgentError && /^[A-Za-z0-9_-]{1,64}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
}

/** A real browser/MLS scenario; all credentials and observed plaintext remain local. */
export async function runAutonomous({ baseURL, timeoutMs = 30_000, signal, report = message => process.stdout.write(`${message}\n`) }) {
  const agent = new PillowfortAgent({ baseURL, timeoutMs, maxSessions: 2 });
  let stage = 'session creation';
  let roomId;
  let endRequested = false;
  let roomEnded = false;
  let failure;
  const checkSignal = () => { if (signal?.aborted) throw new AgentError('INTERRUPTED', 'The operator interrupted the scenario.'); };
  const execute = async (session, action, input) => {
    checkSignal();
    const result = await agent.execute(session, action, input);
    if (!result.ok) throw new AgentError(result.error.code, 'A room action failed.', result.error.retryable);
    return result.data;
  };
  const observeUntil = async (session, predicate, { cleanup = false } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let snapshot = await agent.observe(session);
    for (;;) {
      if (!cleanup) checkSignal();
      if (predicate(snapshot)) return snapshot;
      const failed = snapshot.operations?.find(operation => operation.status === 'failed');
      if (failed) throw new AgentError(failed.error?.code ?? 'CONNECTION_FAILED', 'The observed connection failed.');
      if (snapshot.error) throw new AgentError('ROOM_ERROR', 'The room reported an error; private state was not logged.');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AgentError('SCENARIO_TIMEOUT', 'The expected participant-visible state did not arrive before the deadline.');
      snapshot = await agent.wait(session, snapshot.revision, Math.min(1000, remaining));
    }
  };
  const active = snapshot => snapshot.connection.roomId === roomId && snapshot.legalActions.canAct;
  const ended = snapshot => snapshot.connection.roomId === null && snapshot.connection.terminalPresentation === 'room-destroyed';
  try {
    checkSignal();
    await agent.createSession('agent-host');
    await agent.createSession('agent-guest');
    report('PASS isolated host and guest browser identities created');

    stage = 'room creation';
    const creation = await execute('agent-host', 'room_setup', { displayName: 'agent-host', confirm: true });
    roomId = creation.roomId;
    if (typeof roomId !== 'string' || !roomId) throw new AgentError('INVALID_RESULT', 'Room setup did not return a room identifier.');
    await observeUntil('agent-host', snapshot => active(snapshot) && snapshot.connection.isHost);
    report('PASS agent-host created an encrypted room');

    stage = 'private invitation';
    const invitation = await execute('agent-host', 'invitation_export', { roomId, confirm: true });
    if (typeof invitation.invitationUrl !== 'string' || !invitation.invitationUrl) throw new AgentError('INVALID_RESULT', 'Invitation export did not return a private invitation.');
    await execute('agent-guest', 'room_join_link', { invitationUrl: invitation.invitationUrl, displayName: 'agent-guest', confirm: true });
    report('PASS invitation passed privately in memory and guest requested admission');

    stage = 'expected fingerprint verification';
    const guestPending = await observeUntil('agent-guest', snapshot => typeof snapshot.room.pendingJoinFingerprint === 'string' && snapshot.room.pendingJoinFingerprint.length > 0);
    // The guest context is the trusted private channel, not a room message/name.
    const expectedFingerprint = guestPending.room.pendingJoinFingerprint;
    const hostPending = await observeUntil('agent-host', snapshot => active(snapshot) && snapshot.connection.isHost && snapshot.room.pendingAdmissions.some(admission => admission.status === 'pending' && admission.deviceFingerprint === expectedFingerprint));
    const matches = hostPending.room.pendingAdmissions.filter(admission => admission.status === 'pending' && admission.deviceFingerprint === expectedFingerprint);
    if (matches.length !== 1) throw new AgentError('AMBIGUOUS_ADMISSION', 'Expected exactly one matching pending device.');
    const guestStillPending = await agent.observe('agent-guest');
    if (guestStillPending.room.pendingJoinFingerprint !== expectedFingerprint) throw new AgentError('STALE_ADMISSION', 'The expected guest fingerprint changed; no device was approved.');
    report('PASS expected guest fingerprint matched the host pending device');

    stage = 'explicit host approval';
    await execute('agent-host', 'admission_approve', { roomId, admissionId: matches[0].admissionId, deviceFingerprint: expectedFingerprint, confirm: true });
    await observeUntil('agent-guest', snapshot => active(snapshot) && !snapshot.connection.isHost && snapshot.room.members.some(member => member.name === 'agent-host'));
    await observeUntil('agent-host', snapshot => active(snapshot) && snapshot.room.members.some(member => member.name === 'agent-guest'));
    report('PASS agent-host explicitly approved the verified guest and both observed membership');

    stage = 'encrypted message exchange';
    const hostText = 'Hello from the autonomous host.';
    const guestText = 'Hello from the verified autonomous guest.';
    await execute('agent-host', 'chat_send', { roomId, text: hostText });
    await observeUntil('agent-guest', snapshot => snapshot.messages.some(message => message.from === 'agent-host' && message.text === hostText));
    await execute('agent-guest', 'chat_send', { roomId, text: guestText });
    await observeUntil('agent-host', snapshot => snapshot.messages.some(message => message.from === 'agent-guest' && message.text === guestText));
    report('PASS each agent received the other encrypted message; transcript withheld');

    stage = 'room shutdown';
    await execute('agent-host', 'room_end', { roomId, confirm: true });
    endRequested = true;
    await observeUntil('agent-host', ended);
    await observeUntil('agent-guest', ended);
    roomEnded = true;
    report('PASS both agents observed the room end');
  } catch (error) {
    failure = new AgentError(safeCode(error), `Autonomous scenario failed during ${stage}.`);
  } finally {
    try {
      if (roomId && !roomEnded && agent.listSessions().some(session => session.name === 'agent-host' && session.state === 'ready')) {
        const host = await agent.observe('agent-host');
        if (!ended(host) && host.connection.roomId === roomId && host.connection.isHost) {
          if (!endRequested && host.legalActions.canEndRoom) {
            const result = await agent.execute('agent-host', 'room_end', { roomId, confirm: true });
            if (!result.ok) throw new AgentError(result.error.code, 'Host cleanup failed.');
            endRequested = true;
          }
          if (!endRequested) throw new AgentError('CLEANUP_UNCONFIRMED', 'The room could not be ended by this host.');
          await observeUntil('agent-host', ended, { cleanup: true });
          report('PASS cleanup observed the host room end');
        } else if (!ended(host)) {
          throw new AgentError('CLEANUP_UNCONFIRMED', 'Room shutdown could not be confirmed.');
        }
      }
    } catch (error) {
      report(`FAIL room cleanup (${safeCode(error)}); browser identities will still close`);
      failure ??= new AgentError(safeCode(error), 'Autonomous scenario failed during room cleanup.');
    } finally {
      await agent.close();
      report('PASS all local browser sessions closed');
    }
  }
  if (failure) throw failure;
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  let signalCode;
  const onInterrupt = () => { signalCode = 130; controller.abort(); };
  const onTerminate = () => { signalCode = 143; controller.abort(); };
  try {
    const options = parseArguments(argv);
    if (options.help) { process.stdout.write(HELP); return; }
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    await runAutonomous({ ...options, signal: controller.signal });
  } catch (error) {
    // Never render arbitrary app errors, URLs, or observed participant content.
    const message = error instanceof AgentError && /^Autonomous scenario failed during [a-z ]+\.$/.test(error.message)
      ? error.message : 'Autonomous scenario could not complete. Use --help and check the selected app and Chromium installation.';
    process.stderr.write(`${message} Code: ${safeCode(error)}\n`);
    process.exitCode = signalCode ?? 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    if (signalCode) process.exitCode = signalCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
