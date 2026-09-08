# Pilot demo capture

Source: `scripts/capture-pilot-demos.mjs`. The capture command does not commit or publish recordings. Reviewed synthetic clips are kept in `marketing/public/pilot-demos/` for the marketing deployment:

- [Human-facing clip](https://about.pillowfort.xyz/pilot-demos/your-group-chat-needs-a-room.mp4)
- [Agent-facing clip](https://about.pillowfort.xyz/pilot-demos/your-agent-can-make-a-room.mp4)

Each is 22 seconds. These are controlled demonstrations, not recordings of recruited users or evidence of traction.

## Run

Supply an **already running, current local app and relay**. The capture command never starts a server. Use a quiet local instance with no real participants; its relay must also be on the selected origin. Literal loopback only (`127.0.0.1` or `[::1]`); `localhost`, production URLs, URL credentials, queries, fragments, and non-root paths are refused.

Prerequisites:

- Project dependencies installed, including Playwright 1.59.1.
- Playwright Chromium installed (`npx playwright install chromium` if needed).
- System `ffmpeg` with `libx264`, plus `ffprobe` on PATH. On macOS these are provided by the ffmpeg package. No tool is installed automatically.
- The served client includes the real version-1 agent bridge and working OpenMLS assets. Do not serve an old client build.

From the repository root, replacing the port with the supplied local server's port:

```sh
node scripts/capture-pilot-demos.mjs --url http://127.0.0.1:3000/ --out-dir docs/pilot-demos/output
```

Optional binary paths: `--ffmpeg /path/to/ffmpeg --ffprobe /path/to/ffprobe`. Choose a **fresh output directory** for each run; existing named artifacts are never overwritten. The script does not read `.env`, saved browser profiles, credential files, operator keys, or OAuth configuration.

Outputs, written only after both clips have been captured and encoded:

- `your-group-chat-needs-a-room.mp4`
- `your-agent-can-make-a-room.mp4`
- `capture-metadata.json` — dimensions, duration, Chromium version, file hashes, synthetic/editorial labels, and pass/fail evidence expressed as booleans. No room identifiers, participant names, messages, artwork, or invitation credentials.

Both clips target **22 seconds**, 1280×800, 30 fps, H.264/yuv420p MP4 with fast-start and no audio. The command checks each final file's codec, resolution, and 21–24 second duration window using ffprobe.

## What is real, what is editorial

Each demo uses a new pair of isolated ephemeral Chromium contexts, the real local application, and the actual MLS admission and messaging flow. No browser state is injected into the app store, no relay is mocked, and no completed UI is substituted.

- **Human-facing:** the host creates the room using the existing setup UI and approves the other browser through the actual host dialog. Setup uses the real custom-password UI with a fresh high-entropy synthetic secret so it does not overwrite the operator's clipboard. Chat and drawing originate from human UI controls.
- **Agent-facing:** the host uses `room_setup`, `invitation_export`, `admission_approve`, `chat_send`, and `drawing_send` on the real browser bridge. This demonstrates the browser-custody substrate used by the agent integrations; it is **not** footage of a hosted MCP/OAuth exchange or native WebMCP.
- Both joiners consume an actual invitation through `room_join_link`, without navigating to or displaying its bearer URL. The script compares the joining browser's fingerprint against the host's pending admission before approval. This is controlled synthetic verification, not a claim that real-world approval should be automatic.
- Both directions of chat are checked in the receiving browser. Drawing is checked as a newly applied remote batch and a painted real receiving canvas, not merely a queued request.

Setup, invitation transfer, and fingerprint approval finish **before the opening card**. They are not presented as an on-screen agent terminal. The timeline is:

| Time | Content |
| --- | --- |
| 0–3 s | Clearly labeled editorial title card |
| 3–9 s | Actual received chat, typed reply, and verified remote receipt |
| 9–15 s | Actual shared drawing received from the other browser |
| 15–18 s | Return to the same conversation |
| 18–22 s | Clearly labeled editorial end card and destination |

Title/end cards reuse `/logo-mark.svg` (the existing 4B mark), app palette variables, and its Tahoma/Arial font stack. A persistent caption labels live footage as synthetic. The live UI is uniformly scaled to fit beneath the caption without clipping controls, with privacy masking; no fake room, member, message, or drawing pixels are added. Slow actions fail the shot budget rather than being accelerated or portrayed as successful.

## Privacy and cleanup

Only the joining browser is recorded. Its body is hidden from document initialization and blacked out through setup/admission. Room-code fields, system messages, credential fields, invitation dialogs, and admission panels remain masked during live footage. Raw Playwright videos contain this already-masked surface, not unredacted setup. Small black/white boundary markers identify the live sequence for ffmpeg trimming; the final frame contains a tiny white marker at the upper left of the editorial header/card.

All app requests and WebSockets outside the selected loopback origin are blocked; no analytics, hosted MCP, public publishing, or outreach is performed. Browser debug logging is disabled and raw Playwright/application error strings are suppressed because they may contain input values. Synthetic names and content exist only in the explicit local demonstration, never in a pilot tracking dataset.

The command does not read or alter the operator's clipboard. The custom-password setup happens before the visible clip and is not presented as the default onboarding path.

The command attempts to end its synthetic rooms, closes browser contexts, and removes all temporary WebM/video files in `finally`, on normal failure, and after SIGINT/SIGTERM. The overall run has a five-minute deadline, browser/action waits are bounded, and subprocesses have timeouts. An uncatchable process kill or machine crash can leave a `pillowfort-pilot-*` directory under the system temporary directory; remove that directory before distributing artifacts. No raw-video retention option is provided.

## Operator verification

Before accepting or publishing a capture, run it against the supplied local app and visually review both final timelines:

1. All title, caption, and end-card text is readable; the existing 4B icon/palette are intact.
2. The real incoming message and typed reply are visible, and the other browser's drawing visibly arrives.
3. No room code, invitation URL/password, admission identifier/fingerprint, error details, real participant data, or credentials appear in any frame.
4. No unexpected blank segment, clipped control, stale loading state, or missing end card appears.
5. Metadata reports the expected format, bounded duration, and all exercised checks.

Failures report only the fixed stage and a safe diagnostic. Verify the supplied app/relay and prerequisites; use a fresh output directory when retrying. A successful command proves the programmed checks, not visual review or hosted deployment health. No production publication is authorized by running it.
