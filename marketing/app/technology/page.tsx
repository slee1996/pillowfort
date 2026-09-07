import type { Metadata } from "next";
import { BrandIcon } from "../components/BrandIcon";

export const metadata: Metadata = {
  title: "Privacy & technology — Pillowfort",
  description: "How Pillowfort’s encrypted, host-approved rooms work, what the relay can see, and what happens when a room closes.",
  alternates: { canonical: "/technology" },
};

export default function TechnologyPage() {
  return <main id="main-content" className="technology-page">
    <header className="document-hero wrap"><p className="eyebrow">Privacy &amp; technology / Under the blankets</p><h1>A closed door.<br /><em>An open explanation.</em></h1><p className="deck">Privacy is more useful when you know its edges. Here’s what stays between friends, what keeps a fort running, and what happens when it ends.</p><a className="text-link" href="#secure-rooms">Start with secure rooms <span aria-hidden="true">↓</span></a></header>

    <div className="technology-layout wrap">
      <aside className="contents"><p className="eyebrow">In these notes</p><nav aria-label="On this page"><a href="#secure-rooms">01 / Inside the room</a><a href="#privacy-limits">02 / The boundaries</a><a href="#room-runtime">03 / Behind the scenes</a><a href="#room-lifecycle">04 / When it ends</a></nav><BrandIcon size={76} /></aside>
      <div className="technology-content">
        <section className="technical-section" id="secure-rooms" aria-labelledby="secure-heading"><p className="eyebrow">01 / Inside the room</p><h2 id="secure-heading">Your browser locks<br /><em>the envelope.</em></h2>
          <div className="prose"><p>Pillowfort protocol v4 uses <strong>MLS 1.0 (Messaging Layer Security)</strong>, with independent device identities and evolving group epochs. Room content is signed and end-to-end encrypted in members’ browsers.</p><p>That includes chat, names, presence details, drawings, themes, game actions, choices, roles, votes, and results. The relay delivers encrypted content; it does not receive a plaintext room transcript or members’ MLS private keys.</p></div>
          <figure className="encryption-flow"><ol><li><span>Member’s browser</span><strong>Sign &amp; encrypt</strong></li><li><span>Room relay</span><strong>Route ciphertext</strong></li><li><span>Member’s browser</span><strong>Decrypt &amp; verify</strong></li></ol><figcaption>A simplified content-delivery flow, not a live connection.</figcaption></figure>
          <div className="prose"><h3>An invitation is not automatic admission.</h3><p>New devices wait for explicit host approval and a matching fingerprint. The host must stay in the fort to approve them. Once admitted, a new device receives the current room state—not earlier chat or drawing history.</p><p>Membership updates move the group onto fresh key material after joins, removals, host changes, and reconnects. Removing a member advances the group before ordinary room traffic continues.</p></div>
          <div className="prose"><h3>One link, with the same approval.</h3><p>The invitation includes the password after the URL’s # character. Browsers don’t send that fragment in HTTP requests. Pillowfort reads it into temporary memory, removes it from the address bar, and lets you join without typing a separate password. You still choose a name, submit Join, and wait for host approval.</p><p>The whole link is a credential. Anyone you forward it to can request admission, and the app you share it through may see it. Removing it from the address bar cannot erase clipboard history, extensions, or copies already shared. Keep the original invitation safe; reopening it or entering its password is needed after a reload.</p></div>
        </section>

        <section className="technical-section" id="privacy-limits" aria-labelledby="limits-heading"><p className="eyebrow">02 / The boundaries</p><h2 id="limits-heading">Private doesn’t<br /><em>mean invisible.</em></h2>
          <div className="privacy-boundaries"><div><h3>What the relay can see</h3><p>Room and device routing identifiers; connection timing and count; protocol message class and destination class; and coarse, padded ciphertext sizes.</p><p>It can also delay, block, or drop delivery. Encryption does not make the relay unaware of connections.</p></div><div><h3>What encryption cannot promise</h3><p>Browser encryption cannot protect you against deliberately modified, malicious first-party JavaScript.</p><p>Room members can retain messages, screenshots, or other copies. Ending the fort cannot erase what someone else has kept.</p></div></div>
          <div className="prose"><h3>Hosted agents are managed participants.</h3><p>When you use Pillowfort’s hosted MCP service, its browser endpoint runs on Pillowfort-managed Cloudflare infrastructure. That runtime can access its participant’s decrypted content and in-memory room keys. It still needs an invitation and the host’s verified-device approval to enter someone else’s room; it has no automatic access to unrelated rooms.</p><p>Local MCP and native WebMCP keep execution in the operator’s browser environment, but the model or operator receiving tool results can still retain plaintext. Tell participants when an agent is present and where its observations go. See the <a href="/agents/security.md">agent custody and authorization guide</a>.</p></div>
          <p className="margin-note">Invite people you trust. Share the full invitation link privately, or use separate-channel code and password sharing. Encryption supports that trust; it doesn’t replace it.</p>
        </section>

        <section className="technical-section" id="room-runtime" aria-labelledby="runtime-heading"><p className="eyebrow">03 / Behind the scenes</p><h2 id="runtime-heading">One room.<br /><em>Its own little runtime.</em></h2>
          <div className="prose"><p>A Cloudflare Worker routes each room’s WebSocket connections to a dedicated Durable Object. That object coordinates routing, membership lifecycle, the host role, encrypted delivery, and deadlines—without a global public room directory.</p><p>Local development uses a Bun server with in-memory room maps and native WebSockets. Production uses Durable Objects with WebSocket hibernation, socket attachments, and durable alarms. Shared wire validation, relay transitions, and scheduling helpers keep the room rules aligned.</p></div>
          <dl className="data-ledger"><div><dt>Live-room continuity</dt><dd>Room instance, invitation verification key, device routing, membership lifecycle, host role, opaque delivery backlog, entitlement, and alarm schedule.</dd></div><div><dt>Browser-owned private state</dt><dd>MLS group state, anti-replay history, names, presence details, drawings, chat, and deterministic game state.</dd></div><div><dt>Scheduled deadlines</dt><dd>Idle destruction, pending admission, reconnect, removal, and short ordering deadlines use a durable alarm schedule in production.</dd></div><div><dt>Never relay plaintext</dt><dd>The invitation secret, MLS private keys, names, messages, drawings, choices, roles, votes, and game results.</dd></div></dl>
        </section>

        <section className="technical-section" id="room-lifecycle" aria-labelledby="lifecycle-heading"><p className="eyebrow">04 / When it ends</p><h2 id="lifecycle-heading">Fold up the blanket.<br /><em>Close the room.</em></h2>
          <div className="prose"><p>A host creates a generated or custom room ID, an invitation secret, and the first MLS group state. While the room lives, members can talk, draw, play, and pass the host role with a pillow throw.</p><p>When the fort closes, the server broadcasts closure, disconnects sockets, clears timers, and <strong>deletes live room state and the encrypted delivery backlog.</strong></p><p>Minimal payment and redemption records remain for payment integrity. Copies retained by members are outside that teardown. “Temporary” describes the room’s lifecycle—not a promise that every trace of a visit vanishes everywhere.</p></div>
        </section>
      </div>
    </div>
    <section className="small-invite wrap"><div><p className="eyebrow">Back to the good part</p><h2>Make time for<br /><em>your people.</em></h2></div><a className="button" href="https://pillowfort.xyz">Make a fort <span aria-hidden="true">↗</span></a></section>
  </main>;
}
