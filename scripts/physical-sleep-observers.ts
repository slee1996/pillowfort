// Operator-run hardware experiment. Only the two observers and private relay run here.
// The host's ordinary browser is neither instrumented nor remotely driven during sleep.
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import type { Page } from "playwright";

type Guest = {page: Page};
type Room = {participants: Guest[]; invitation: string};
type Configure = (p: Guest, i: number) => Promise<void>;
export async function observeLaptopSleep<R extends Room>(fault: "physical-sleep" | "sleep-awake-control", origin: string,
  setup: (observe: Configure) => Promise<R>, close: (r: R) => Promise<void>, newGuest: () => Promise<Guest>,
  policyReady: Promise<unknown>, deliver: (a: Page, b: Page, message: string) => Promise<number>) {
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const control = fault === "sleep-awake-control", duration = control ? 14000 : 90000;
  const targetName = "Sleep Study Host", devices: string[] = [];
  const offers: {id: string; policy: string; at: number}[] = [], choices: {id: string; policy: string; signer: string; at: number}[] = [];
  const changes: {device: string; at: number}[] = [];
  let recording = false;
  const room = await setup(async ({page}, i) => {
    page.on("websocket", ws => {
      ws.on("framereceived", ({payload}) => {
        const f = JSON.parse(payload.toString());
        if (f.type === "authenticated") devices[i] = f.deviceId;
        if (!recording) return;
        if (i === 0 && f.type === "host-transfer-authorized" && f.policyEventId) offers.push({id:f.authorizationId, policy:f.policyEventId, at:Date.now()});
        if (i === 1 && f.type === "host-changed") changes.push({device:f.deviceId,at:Date.now()});
      });
      ws.on("framesent", ({payload}) => {
        const e = JSON.parse(payload.toString()).authorityEvent;
        if (recording && i === 0 && e?.content.type === "host-succession" && e.content.action === "accept") {
          choices.push({id:e.content.authorizationId,policy:e.content.policyEventId,signer:e.deviceId,at:Date.now()});
        }
      });
    });
  });
  const [candidate, sender] = room.participants.map(p=>p.page);
  try {
    let third: Page | undefined;
    if (control) {
      const p = await newGuest(); room.participants.push(p); third=p.page;
      await third.goto(room.invitation); await third.locator("#join-name").fill(targetName);
      await third.getByRole("button",{name:"Join fort",exact:true}).click();
      await candidate.getByRole("button",{name:"Approve",exact:true}).click();
    } else {
      await candidate.bringToFront();
      console.log(`Private relay: ${origin}. In the awake founder tab use Invite. Open the private link on the dedicated Mac as “${targetName}”. Verify and approve its exact request in the founder tab. Dismiss the invite dialog, then click Catch on the Mac. Do not sleep until ARMED.`);
    }
    await candidate.getByText("Buddies (3)",{exact:true}).waitFor({timeout:180000});
    await candidate.locator("#btn-room-menu").click(); await candidate.locator("#aim-btn-toss").click();
    await candidate.locator("#member-picker-body .member-picker-item",{hasText:targetName}).click();
    if (third) await third.locator("#btn-catch").click(); // Real hardware: the person chooses on the laptop.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const policy = await Promise.race([policyReady, new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("No committed host policy naming the two awake guests")),90000);})]).finally(()=>clearTimeout(timer));
    assert(policy && typeof policy === "object" && "studyPolicy" in policy);
    await deliver(sender,candidate,"awake control before the sleep observation");
    const start = Date.now(), mono = performance.now(); recording=true;
    console.log(control ? "ARMED: no sleep in the awake control." : "ARMED: manually sleep and fully wake only the dedicated Mac during the next 90 s. Leave the two observers and the relay awake.");
    const samples: {submittedAt:number; receivedAt:number|null}[] = [], observed: Promise<void>[] = [];
    const input=sender.getByRole("textbox",{name:"Message",exact:true});
    let clicked=false;
    for (let i=0; performance.now()-mono<duration; i++) {
      if (!clicked && await candidate.locator("#btn-catch").isVisible()) {
        assert(offers.length && offers[0].policy === policy.studyPolicy,"unexpected offer authority");
        await candidate.locator("#btn-catch").click(); clicked=true;
      }
      if (await input.isEditable()) {
        const marker=`hardware observation ${i+1}`; await input.fill(marker);
        const sample={submittedAt:Date.now(),receivedAt:null as number|null}; samples.push(sample);
        // Independent DOM observation; a queued command or an echo at the sender is not a receipt.
        observed.push(candidate.locator(".chat-content").getByText(marker,{exact:true}).first().waitFor({timeout:Math.max(2500,duration-(performance.now()-mono)+2500)}).then(()=>{sample.receivedAt=Date.now();},(e:Error)=>{if(e.name!=="TimeoutError") throw e;}));
        await input.press("Enter");
      }
      await wait(Math.max(0, Math.min(1500, duration - (performance.now()-mono))));
    }
    const end=Date.now(); recording=false; await Promise.all(observed);
    assert(Math.abs((end-start)-duration)<3000,"awake stopwatch changed or was suspended");
    if (choices.length) assert(clicked && choices.every(c=>c.signer===devices[0] && c.policy===policy.studyPolicy && offers.some(o=>o.id===c.id && o.policy===c.policy)),"unbound acceptance");
    if (changes.length) assert(choices.length && changes.every(c=>c.device===devices[0]),"unexpected authority switch");
    // Preserve incomplete hardware outcomes; an offer without a receipt is not a successful transfer.
    if (control) assert(!offers.length && !changes.length && samples.length && samples.every(s=>s.receivedAt!==null),"healthy control lost authority or delivery");
    return {fault, controlOnly:control, windowStartUtcMs:start,windowEndUtcMs:end, samplingIntervalMs:1500,
      offers:offers.map(x=>x.at), signedAcceptances:choices.map(x=>x.at), peerObservedSwitches:changes.map(x=>x.at), samples,
      assumption:"Both observer clocks and the local Worker share the awake machine. A hardware result additionally requires independent OS sleep and full-wake evidence."};
  } finally { recording=false; await close(room); }
}
