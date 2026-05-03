#!/usr/bin/env node
import { readFileSync } from "node:fs";

const FUNNEL = [
  "room_created",
  "invite_copied",
  "guest_joined",
  "first_message_sent",
  "game_started",
  "room_knocked_down",
];

const FORT_PASS = [
  "fort_pass_status_checked",
  "fort_pass_code_checked",
  "fort_pass_checkout_started",
  "fort_pass_checkout_failed",
  "fort_pass_checkout_returned",
];

function readInput() {
  const files = process.argv.slice(2);
  if (files.length) {
    return files.map((file) => readFileSync(file, "utf8")).join("\n");
  }
  if (process.stdin.isTTY) {
    console.error("Usage: npm run metrics:report -- path/to/log.txt");
    console.error("   or: wrangler tail --format pretty | npm run metrics:report --");
    process.exitCode = 1;
    return "";
  }
  return readFileSync(0, "utf8");
}

function parseEvents(input) {
  const events = [];
  for (const line of input.split(/\r?\n/)) {
    const match = line.match(/\[analytics\]\s+({.*})/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed.event === "string") events.push(parsed);
    } catch {
      // Ignore malformed log fragments from streaming tails.
    }
  }
  return events;
}

function countBy(events, keyFn) {
  const counts = new Map();
  for (const event of events) {
    const key = keyFn(event);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function count(counts, event) {
  return counts.get(event) || 0;
}

function pct(numerator, denominator) {
  if (!denominator) return "n/a";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

const events = parseEvents(readInput());
const byEvent = countBy(events, (event) => event.event);
const byFailureReason = countBy(
  events.filter((event) => String(event.event).endsWith("_failed") || event.event === "room_join_failed"),
  (event) => `${event.event}:${event.props?.reason || "unknown"}`
);

const rooms = count(byEvent, "room_created");
const invites = count(byEvent, "invite_copied");
const guests = count(byEvent, "guest_joined");
const firstMessages = count(byEvent, "first_message_sent");
const games = count(byEvent, "game_started");
const checkouts = count(byEvent, "fort_pass_checkout_started");
const returns = count(byEvent, "fort_pass_checkout_returned");

console.log("# Pillowfort Beta Metrics");
console.log("");
console.log(`Events parsed: ${events.length}`);
console.log("");
console.log("## Activation Funnel");
console.log("");
console.log("| Step | Events | Rate vs rooms |");
console.log("| --- | ---: | ---: |");
for (const event of FUNNEL) {
  console.log(`| ${event} | ${count(byEvent, event)} | ${event === "room_created" ? "100%" : pct(count(byEvent, event), rooms)} |`);
}
console.log("");
console.log("## Fort Pass");
console.log("");
console.log("| Step | Events | Rate vs checkout starts |");
console.log("| --- | ---: | ---: |");
for (const event of FORT_PASS) {
  const rate = event === "fort_pass_checkout_started" && checkouts > 0 ? "100%" : pct(count(byEvent, event), checkouts);
  console.log(`| ${event} | ${count(byEvent, event)} | ${rate} |`);
}
console.log("");
console.log("## Headline Ratios");
console.log("");
console.log(`- Invite copied per room: ${pct(invites, rooms)}`);
console.log(`- Guest joined per room: ${pct(guests, rooms)}`);
console.log(`- First message per room: ${pct(firstMessages, rooms)}`);
console.log(`- Game started per room: ${pct(games, rooms)}`);
console.log(`- Fort Pass return per checkout start: ${pct(returns, checkouts)}`);
console.log("");
console.log("## Failure Reasons");
console.log("");
if (byFailureReason.size === 0) {
  console.log("No failure events in this sample.");
} else {
  console.log("| Bucket | Count |");
  console.log("| --- | ---: |");
  for (const [key, value] of [...byFailureReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`| ${key} | ${value} |`);
  }
}
