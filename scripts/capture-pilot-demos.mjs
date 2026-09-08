#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// No storage state, production navigation, application mocks, or captured console output.
const exec = promisify(execFile);
const VIEWPORT = { width: 1280, height: 800 };
const WAIT = 30_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class CaptureError extends Error {}
let stage = 'checking prerequisites';

function options(argv) {
  const result = { outDir: 'docs/pilot-demos/output', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  const flags = { '--url': 'url', '--out-dir': 'outDir', '--ffmpeg': 'ffmpeg', '--ffprobe': 'ffprobe' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new CaptureError('Use --url http://127.0.0.1:PORT/ [--out-dir PATH] [--ffmpeg PATH] [--ffprobe PATH].');
    result[key] = argv[++i];
  }
  let url;
  try { url = new URL(result.url); } catch { throw new CaptureError('An explicit loopback --url is required.'); }
  // Deliberately exclude localhost/DNS aliases: literal loopback only, with no credentials.
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new CaptureError('Use a literal loopback app root (127.0.0.1 or [::1]), without credentials, query, or fragment. Production URLs are refused.');
  }
  result.url = url;
  result.outDir = resolve(result.outDir);
  return result;
}

async function command(binary, args, signal) {
  return exec(binary, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, signal });
}

async function bridge(page, action, input = {}) {
  let timer;
  try {
    const result = await Promise.race([
      page.evaluate(({ action, input }) => window.pillowfortAgent.execute(action, input), { action, input }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new CaptureError('The browser bridge did not respond within 30 seconds.')), WAIT); }),
    ]);
    if (!result?.ok) throw new CaptureError(`The ${action} action failed; no action payload or application error was logged.`);
    return result.data;
  } finally {
    clearTimeout(timer);
  }
}

async function ready(page, members = 1) {
  await page.waitForFunction(count => {
    const state = window.pillowfortAgent.observe();
    return state.legalActions.canAct && state.room.members.length === count;
  }, members, { timeout: WAIT });
}

// This is a recording matte, not replacement application UI. Sensitive startup is
// black from document initialization. Only the already-admitted room is exposed.
function installMatte() {
  const install = () => {
    if (!document.documentElement || document.getElementById('pilot-capture-style')) return;
    const style = document.createElement('style');
    style.id = 'pilot-capture-style';
    style.textContent = `
      html { background: #000 !important; }
      body { visibility: hidden !important; }
      html[data-pilot-live] body { visibility: visible !important; }
      #room-code, .chat-message-system, .invite-dialog, #admission-approval-overlay,
      .auth-note, .entry-screen, [id*="password"], #join-room, #invite-link,
      #invite-room-id { visibility: hidden !important; }
      #pilot-matte, #pilot-caption, #pilot-marker { visibility: visible !important; }
      #pilot-matte { position: fixed; inset: 0; z-index: 2147483646; display: grid;
        place-content: center; padding: 90px; background: #000; color: var(--ink, #1d2c42);
        font-family: var(--display, Tahoma, Arial, sans-serif); text-align: center; pointer-events: none; }
      #pilot-matte[data-card] { background: var(--chrome-light, #fffef7); }
      #pilot-matte img { width: 76px; height: 76px; margin: 0 auto 24px; }
      #pilot-matte h1 { font-size: 54px; line-height: 1.12; max-width: 1050px; margin: 0 auto 25px; }
      #pilot-matte p { font-size: 25px; line-height: 1.5; max-width: 980px; margin: 0 auto; }
      #pilot-matte small { display: block; margin: 30px auto 0; font-size: 17px; color: var(--muted, #536078); }
      #pilot-caption { position: fixed; top: 0; left: 0; right: 0; height: 55px;
        z-index: 2147483645; box-sizing: border-box; padding: 15px 24px;
        background: var(--chrome-light, #fffef7); border-bottom: 1px solid var(--line, #8c9db5);
        color: var(--ink, #1d2c42); font: 19px var(--display, Tahoma, Arial, sans-serif);
        pointer-events: none; }
      #pilot-caption small { float: right; font-size: 13px; padding-top: 4px; }
      html[data-pilot-live] #root { position: fixed; inset: 0; transform: translateY(55px) scale(0.93125); transform-origin: top center; }
      #pilot-marker { position: fixed; top: 0; left: 0; width: 8px; height: 8px;
        z-index: 2147483647; background: #000; pointer-events: none; }
    `;
    document.documentElement.append(style);
  };
  install();
  const observer = new MutationObserver(install);
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { install(); observer.disconnect(); }, { once: true });
}

async function matte(page, mode, title = '', detail = '') {
  await page.evaluate(({ mode, title, detail }) => {
    let cover = document.getElementById('pilot-matte');
    if (!cover) {
      cover = document.createElement('section');
      cover.id = 'pilot-matte';
      document.body.append(cover);
      const caption = document.createElement('aside');
      caption.id = 'pilot-caption';
      document.body.append(caption);
      const marker = document.createElement('div');
      marker.id = 'pilot-marker';
      document.body.append(marker);
    }
    document.documentElement.toggleAttribute('data-pilot-live', mode === 'live');
    cover.hidden = mode === 'live';
    cover.style.display = mode === 'live' ? 'none' : 'grid';
    cover.toggleAttribute('data-card', mode === 'card');
    cover.replaceChildren();
    if (mode === 'card') {
      const icon = document.createElement('img');
      icon.src = '/logo-mark.svg';
      const heading = document.createElement('h1');
      heading.textContent = title;
      const text = document.createElement('p');
      text.textContent = detail;
      const label = document.createElement('small');
      label.textContent = 'EDITORIAL CARD · SYNTHETIC LOCAL DEMO · NO REAL PARTICIPANTS';
      cover.append(icon, heading, text, label);
    }
    const caption = document.getElementById('pilot-caption');
    caption.textContent = title;
    const label = document.createElement('small');
    label.textContent = 'EDITORIAL CAPTION · REAL UI · SYNTHETIC DEMO';
    caption.append(label);
    document.getElementById('pilot-marker').style.background = mode === 'black' ? '#000' : '#fff';
  }, { mode, title, detail });
}

async function shot(page, seconds, mode, title, detail = '', action) {
  const start = performance.now();
  await matte(page, mode, title, detail);
  if (action) await action();
  const remaining = seconds * 1000 - (performance.now() - start);
  if (remaining < 600) throw new CaptureError('An interaction exceeded its shot budget. No sped-up or fabricated success video was produced. Retry on an idle local server.');
  await sleep(remaining);
}

async function makePage(browser, cfg, rawDir, recorded) {
  const context = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false,
    ...(recorded ? { recordVideo: { dir: rawDir, size: VIEWPORT } } : {}),
  });
  context.setDefaultTimeout(WAIT);
  context.setDefaultNavigationTimeout(WAIT);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === cfg.url.origin ? route.continue() : route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    const expected = new URL(cfg.url);
    expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
    if (url.origin === expected.origin) socket.connectToServer();
    else socket.close();
  });
  if (recorded) await context.addInitScript(installMatte);
  const page = await context.newPage();
  context.on('page', extra => { if (extra !== page) void extra.close().catch(() => {}); });
  page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
  const url = new URL(cfg.url);
  url.searchParams.set('agent', '1');
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new CaptureError('The loopback app did not return a successful response.');
  await page.waitForFunction(() => window.pillowfortAgent?.version === 1, null, { timeout: WAIT });
  if (recorded) { await matte(page, 'black'); await sleep(700); }
  return { context, page };
}

async function messageReceived(page, from, text) {
  await page.waitForFunction(({ from, text }) => window.pillowfortAgent.observe().messages.some(message => message.from === from && message.text === text), { from, text }, { timeout: 5000 });
  await page.getByText(text, { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
}

const STROKES = [
  [[0.27, 0.57], [0.27, 0.37], [0.50, 0.20], [0.73, 0.37], [0.73, 0.57], [0.27, 0.57]],
  [[0.45, 0.57], [0.45, 0.42], [0.55, 0.42], [0.55, 0.57]],
];

async function capture(browser, cfg, workDir, kind, signal) {
  stage = `${kind}: creating synthetic room`;
  const rawDir = join(workDir, kind);
  await mkdir(rawDir);
  const host = await makePage(browser, cfg, rawDir, false);
  let viewer;
  let roomId;
  let video;
  const agent = kind === 'agent';
  const hostName = agent ? 'demo-agent' : 'demo-luna';
  const viewerName = 'demo-river';
  try {
    if (agent) {
      ({ roomId } = await bridge(host.page, 'room_setup', { displayName: hostName, confirm: true }));
    } else {
      await host.page.fill('#name-input', hostName);
      await host.page.click('#btn-setup');
      await host.page.click('#password-options summary');
      await host.page.click('#btn-custom-secret');
      await host.page.fill('#setup-password', `demo-${randomBytes(24).toString('base64url')}`);
      await host.page.click('#btn-create');
    }
    await ready(host.page);
    roomId = await host.page.evaluate(() => window.pillowfortAgent.observe().connection.roomId);
    // Invitation exists only in memory, never a navigation URL or printed payload.
    let invitation = await bridge(host.page, 'invitation_export', { roomId, confirm: true });
    stage = `${kind}: admitting isolated browser`;
    viewer = await makePage(browser, cfg, rawDir, true);
    video = viewer.page.video();
    await bridge(viewer.page, 'room_join_link', { invitationUrl: invitation.invitationUrl, displayName: viewerName, confirm: true });
    invitation = null;
    await viewer.page.waitForFunction(() => !!window.pillowfortAgent.observe().room.pendingJoinFingerprint, null, { timeout: WAIT });
    const fingerprint = await viewer.page.evaluate(() => window.pillowfortAgent.observe().room.pendingJoinFingerprint);
    await host.page.waitForFunction(fingerprint => window.pillowfortAgent.observe().room.pendingAdmissions.some(item => item.deviceFingerprint === fingerprint && item.status === 'pending'), fingerprint, { timeout: WAIT });
    const admission = await host.page.evaluate(fingerprint => window.pillowfortAgent.observe().room.pendingAdmissions.find(item => item.deviceFingerprint === fingerprint), fingerprint);
    if (!admission || admission.deviceFingerprint !== fingerprint) throw new CaptureError('Host/joiner fingerprints did not match.');
    if (agent) await bridge(host.page, 'admission_approve', { roomId, admissionId: admission.admissionId, deviceFingerprint: fingerprint, confirm: true });
    else await host.page.click('#btn-approve-admission');
    await Promise.all([ready(host.page, 2), ready(viewer.page, 2)]);
    await viewer.page.locator('#messages').waitFor({ state: 'attached' });
    await viewer.page.evaluate(() => document.fonts.ready);
    // Warm the existing icon while still black; no alternate icon asset is generated.
    await viewer.page.evaluate(() => new Promise((resolve, reject) => { const image = new Image(); image.onload = resolve; image.onerror = reject; image.src = '/logo-mark.svg'; }));
    stage = `${kind}: recording actual received chat and drawing`;
    await shot(viewer.page, 3, 'card', agent ? 'Your agent can make a room and invite you' : 'Your group chat needs a room', agent ? 'Real agent-created room. Private invitation. Host-approved device.' : 'One private invitation. Your people, in the same room.');
    const greeting = agent ? 'Room is ready. Want to sketch the plan?' : 'Made us a room. Come doodle!';
    await shot(viewer.page, 6, 'live', agent ? 'The agent sends. You receive, in your browser.' : 'Your friends are here. Say hello.', '', async () => {
      if (agent) await bridge(host.page, 'chat_send', { roomId, text: greeting });
      else { await host.page.fill('#msg-input', greeting); await host.page.click('#btn-send'); }
      await messageReceived(viewer.page, hostName, greeting);
      await viewer.page.locator('#msg-input').pressSequentially('Yes! Let\'s draw our fort.', { delay: 35 });
      await viewer.page.click('#btn-send');
      await messageReceived(host.page, viewerName, 'Yes! Let\'s draw our fort.');
    });
    await shot(viewer.page, 6, 'live', 'A shared sketchpad. These strokes arrive from the other browser.', '', async () => {
      await viewer.page.click('#btn-open-games');
      await viewer.page.click('#btn-start-drawing');
      await host.page.click('#btn-open-games');
      await host.page.click('#btn-start-drawing');
      for (const [index, pts] of STROKES.entries()) {
        const before = await viewer.page.evaluate(() => window.pillowfortAgent.observe().retention.latestDrawingId ?? 0);
        if (agent) {
          await bridge(host.page, 'drawing_send', { roomId, color: '#0000FF', pts, s: 1 });
        } else {
          const canvas = await host.page.locator('#game-canvas').boundingBox();
          if (!canvas) throw new CaptureError('The real drawing canvas was not visible.');
          await host.page.mouse.move(canvas.x + pts[0][0] * canvas.width, canvas.y + pts[0][1] * canvas.height);
          await host.page.mouse.down();
          for (const [x, y] of pts.slice(1)) await host.page.mouse.move(canvas.x + x * canvas.width, canvas.y + y * canvas.height, { steps: 3 });
          await host.page.mouse.up();
        }
        await viewer.page.waitForFunction(({ before, hostName }) => window.pillowfortAgent.observe().drawings.some(batch => batch.id > before && batch.from === hostName), { before, hostName }, { timeout: 5000 });
        // The actual remote canvas must contain painted pixels, not just a queued action.
        await viewer.page.waitForFunction(() => {
          const canvas = document.getElementById('game-canvas');
          const ctx = canvas?.getContext('2d');
          if (!ctx) return false;
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 0 && (pixels[i] < 180 || pixels[i + 1] < 180 || pixels[i + 2] < 180)) return true;
          return false;
        }, null, { timeout: 5000 });
        if (index === 0) await sleep(400);
      }
    });
    await shot(viewer.page, 3, 'live', 'Back to the conversation. Same people. Same room.', '', async () => {
      await viewer.page.click('#btn-return-room');
      await viewer.page.locator('#messages').waitFor({ state: 'visible' });
    });
    await shot(viewer.page, 4, 'card', agent ? 'Make room for your human.' : 'Give the group chat a place to hang out.', agent ? 'Read the agent guide: about.pillowfort.xyz/agents\nHosted MCP: keyed beta. Local MCP supported.' : 'Start a fort at pillowfort.xyz\nInvite privately. Approve the device. Settle in.');
    await matte(viewer.page, 'black');
    await sleep(800);
    await viewer.context.close();
    const raw = await video.path();
    stage = `${kind}: encoding final MP4`;
    const detection = await command(cfg.ffmpeg, ['-hide_banner', '-i', raw, '-vf', 'crop=8:8:0:0,blackdetect=d=0.3:pix_th=0.10', '-an', '-f', 'null', '-'], signal);
    const intervals = [...detection.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map(match => ({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) }));
    const preamble = intervals.find(item => item.duration >= 0.5);
    const ending = preamble && intervals.find(item => item.start > preamble.end + 15);
    if (!preamble || !ending) throw new CaptureError('Recording boundary markers were not found. Raw video was not published.');
    const duration = ending.start - preamble.end;
    if (duration < 21 || duration > 24) throw new CaptureError('The recorded live sequence was outside its 21–24 second timing boundary.');
    const filename = agent ? 'your-agent-can-make-a-room.mp4' : 'your-group-chat-needs-a-room.mp4';
    const encoded = join(workDir, filename);
    await command(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', raw, '-ss', String(preamble.end), '-t', String(duration), '-vf', 'fps=30,format=yuv420p', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', '-map_metadata', '-1', encoded], signal);
    const probe = JSON.parse((await command(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', encoded], signal)).stdout);
    if (!probe.streams.some(stream => stream.codec_name === 'h264' && stream.width === VIEWPORT.width && stream.height === VIEWPORT.height) || Number(probe.format.duration) < 21 || Number(probe.format.duration) > 24) throw new CaptureError('Final MP4 format or duration verification failed.');
    return { filename, encoded, seconds: Number(probe.format.duration), sha256: createHash('sha256').update(await readFile(encoded)).digest('hex'), proof: { isolatedBrowsers: 2, realMLSAdmission: true, hostFingerprintMatched: true, chatReceivedBothDirections: true, remoteDrawingReceivedAndCanvasPainted: true } };
  } finally {
    if (roomId && !host.page.isClosed()) {
      await bridge(host.page, 'room_end', { roomId, confirm: true })
        .then(() => host.page.waitForFunction(() => !window.pillowfortAgent.observe().connection.roomId, null, { timeout: 5000 }))
        .catch(() => {});
    }
    await viewer?.context.close().catch(() => {});
    await host.context.close().catch(() => {});
  }
}

async function main() {
  const cfg = options(process.argv.slice(2));
  if (cfg.help) { console.log('node scripts/capture-pilot-demos.mjs --url http://127.0.0.1:PORT/ [--out-dir PATH] [--ffmpeg PATH] [--ffprobe PATH]\nRequires a separately running local app, Playwright Chromium, ffmpeg/libx264, and ffprobe. No server is launched.'); return; }
  // Never let Playwright debug logging print action arguments or navigation details.
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  const controller = new AbortController();
  let browser;
  let workDir;
  const stop = () => { controller.abort(); void browser?.close().catch(() => {}); };
  const deadline = setTimeout(stop, 300_000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (const [binary, label] of [[cfg.ffmpeg, 'ffmpeg'], [cfg.ffprobe, 'ffprobe']]) {
      try { await command(binary, ['-version'], controller.signal); }
      catch { throw new CaptureError(`${label} is missing or cannot run. Install the system ffmpeg package, or supply its explicit binary path.`); }
    }
    const encoders = await command(cfg.ffmpeg, ['-hide_banner', '-encoders'], controller.signal);
    if (!encoders.stdout.includes('libx264')) throw new CaptureError('ffmpeg must include the libx264 H.264 encoder.');
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
      await access(chromium.executablePath(), constants.X_OK);
    } catch { throw new CaptureError('Playwright Chromium is missing. Install project dependencies and run npx playwright install chromium before capturing.'); }
    for (const name of ['your-group-chat-needs-a-room.mp4', 'your-agent-can-make-a-room.mp4', 'capture-metadata.json']) {
      try { await access(join(cfg.outDir, name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new CaptureError('Output artifacts already exist. Choose a fresh --out-dir; captures are never overwritten.');
    }
    workDir = await mkdtemp(join(tmpdir(), 'pillowfort-pilot-'));
    browser = await chromium.launch({ headless: true, timeout: WAIT, args: ['--no-proxy-server', '--disable-background-networking'] });
    const results = [];
    for (const kind of ['human', 'agent']) results.push(await capture(browser, cfg, workDir, kind, controller.signal));
    stage = 'writing verified output artifacts';
    await mkdir(cfg.outDir, { recursive: true });
    for (const result of results) await copyFile(result.encoded, join(cfg.outDir, result.filename), constants.COPYFILE_EXCL);
    await writeFile(join(cfg.outDir, 'capture-metadata.json'), JSON.stringify({
      schema: 1, generatedAt: new Date().toISOString(), synthetic: true, published: false,
      source: 'scripts/capture-pilot-demos.mjs', chromium: browser.version(), viewport: VIEWPORT,
      audio: false, transport: 'real local app/browser bridge and MLS; not hosted MCP or native WebMCP',
      privacy: 'No credentials, room identifiers, participant names, messages, or artwork in metadata. Setup/admission blacked out. Room code and system messages hidden. Raw files removed.',
      editorial: 'Title/end cards and top captions are editorial. Live room pixels and canvas are the real app. Setup and fingerprint comparison occur before the opening title. No action is accelerated.',
      videos: results.map(({ encoded, ...result }) => result),
    }, null, 2) + '\n', { flag: 'wx' });
    console.log('Created two verified 21–24 second MP4s and capture-metadata.json in the selected output directory. Review both clips before any publication.');
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await browser?.close().catch(() => {});
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  // Playwright errors can contain DOM text and input arguments. Never emit them.
  console.error(`Pilot capture failed during ${stage}. ${error instanceof CaptureError ? error.message : 'The local operation failed; raw error details are suppressed to protect invitation credentials. Check prerequisites and the local server, then use a fresh output directory.'}`);
  process.exitCode = 1;
});
