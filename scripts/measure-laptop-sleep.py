#!/usr/bin/env python3
"""Join an awake private Worker trace to actual macOS OS-power records. Never requests sleep."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import platform
import re
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
CLOCK = "python3 -c 'import json,platform,socket,time;print(json.dumps([platform.system(),socket.gethostname(),time.time_ns()//1000000]))'"
# Only timestamps and transitions cross SSH, not wake reasons or the raw system log.
POWER = """/usr/bin/pmset -g log | /usr/bin/awk '($4=="Sleep" && /Entering Sleep state/) || ($4=="DarkWake" && /DarkWake from/) || ($4=="Wake" && /Wake from|DarkWake to FullWake/) {print $1,$2,$3,$4}'"""


def ssh(target, command, timeout=25):
    return subprocess.check_output(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                                    '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=7', target, command],
                                   text=True, timeout=timeout)


def clock(target):
    ranges = []
    names = set()
    for _ in range(3):
        start = time.time_ns() // 1_000_000
        system, name, remote = json.loads(ssh(target, CLOCK))
        end = time.time_ns() // 1_000_000
        if system != 'Darwin' or name.split('.')[0].lower() == socket.gethostname().split('.')[0].lower():
            raise ValueError('A different, dedicated macOS laptop is required. Never suspend the observer.')
        names.add(name)
        ranges.append((start-remote-1, end-remote+1))
    lo, hi = max(a for a,b in ranges), min(b for a,b in ranges)
    if len(names) != 1 or not 0 <= hi-lo <= 1000:
        raise ValueError('Clock calibration is inconsistent or wider than one second.')
    return names.pop(), [lo,hi]


def power_events(lines):
    records = []
    for line in lines.splitlines():
        date, stamp, zone, kind = line.split()
        t = datetime.strptime(f'{date} {stamp} {zone}', '%Y-%m-%d %H:%M:%S %z')
        records.append((kind, int(t.timestamp())*1000))
    return records


def summarize(obs, relay, power, offset):
    if obs['controlOnly'] or obs['fault'] != 'physical-sleep' or relay['fault'] != 'physical-sleep':
        raise ValueError('An awake control is not a physical measurement.')
    start, end = obs['windowStartUtcMs'], obs['windowEndUtcMs']
    if not start < end or not 0 <= offset[1]-offset[0] <= 1000:
        raise ValueError('Invalid trial window or clock calibration.')
    events = []
    for kind, host in power:
        # pmset timestamps have one-second resolution. Never report millisecond precision for wake itself.
        lo, hi = host+offset[0], host+999+offset[1]
        if hi < start or lo > end:
            continue
        if lo < start or hi > end:
            raise ValueError('A power event straddles the observer window; cannot attribute this trial.')
        events.append((kind, lo, hi))
    if not events or events[0][0] != 'Sleep' or not any(e[0]=='Wake' for e in events):
        raise ValueError('No attributable system sleep and full wake in the observation window.')
    if events[-1][0] != 'Wake' or sum(e[0]=='Wake' for e in events) != 1:
        raise ValueError('Incomplete or multiple full sleep/wake cycles; repeat as separate trials.')
    for i, (kind,lo,hi) in enumerate(events[1:],1):
        previous=events[i-1][0]
        if (kind not in ('Wake','DarkWake','Sleep') or kind=='Sleep' and previous!='DarkWake' or
                kind=='DarkWake' and previous!='Sleep' or lo<events[i-1][1]):
            raise ValueError('Ambiguous ordering of power transitions.')
    _, asleepLo, asleepHi = events[0]
    _, wakeLo, wakeHi = events[-1]
    receipts = [s['receivedAt'] for s in obs['samples'] if s['submittedAt']>wakeHi and
                s['receivedAt'] is not None and s['submittedAt']<=s['receivedAt']<=end]
    if wakeLo <= asleepHi:
        raise ValueError('The recorded sleep and full wake cannot be separated at this clock precision.')
    if any(t < asleepLo for t in obs['offers']):
        raise ValueError('The host had already received a succession offer before system sleep.')
    submitted=sum(s['submittedAt']>wakeHi for s in obs['samples'])
    timeline = sorted((e['at'],e['event']) for e in relay['events'] if start <= e['at'] <= end)
    probes = [t for t,e in timeline if t>wakeHi and e=='original-probe-send-attempt']
    answered = any(t>=p and e=='original-probe-reply-committed' for p in probes for t,e in timeline)
    return {'measured':bool(receipts), 'physicalCycleVerified':True, 'powerSource':'dedicated Mac: pmset Sleep to full Wake (DarkWake is not full wake)',
            'darkWakes':sum(e[0]=='DarkWake' for e in events), 'powerEventsUtcIntervalsMs':events,
            'elapsedSleepToFullWakeMs':[wakeLo-asleepHi, wakeHi-asleepLo],
            'fullWakeToFirstDefinitelyNewChatMs':[min(receipts)-wakeHi,min(receipts)-wakeLo] if receipts else None,
            'postWakeSubmissions':submitted, 'observationEndedAfterWakeMs':[end-wakeHi,end-wakeLo],
            'trafficOutcome':'displayed' if receipts else ('not observed before the window ended' if submitted else 'no post-wake submission'),
            'eligiblePostWakeReceipts':len(receipts), 'originalConnectionAnsweredAfterFullWake':answered,
            'originalSocketCloseObservedUtcMs':[t for t,e in timeline if e=='original-socket-close-observed'],
            'originalSocketErrorObservedUtcMs':[t for t,e in timeline if e=='original-socket-error-observed'],
            'relayCommittedOriginalDisconnectUtcMs':[t for t,e in timeline if e=='relay-committed-original-disconnect'],
            'firstOfferObservedUtcMs':min(obs['offers'],default=None),
            'offerTiming':('none' if not obs['offers'] else 'overlaps sleep onset' if min(obs['offers'])<=asleepHi else
                           'before full wake' if min(obs['offers'])<wakeLo else 'overlaps full wake' if min(obs['offers'])<=wakeHi else 'after full wake'),
            'signedAcceptances':len(obs['signedAcceptances']),
            'interpretation':'One trial, not an avoidable-offer rate. An absent close observation does not prove a physical socket remained open. The chat interval includes sampling, UI observation and any consent delay.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('output', type=Path, help='new directory')
    p.add_argument('--dedicated-mac', required=True, help='existing key-only SSH destination, for clocks and power logs only')
    p.add_argument('--transport', required=True, choices=('ssh-loopback', 'private-https'), help='actual network path used by the laptop browser')
    p.add_argument('--extra-final-wait-ms', type=int, choices=(0,30000), default=0)
    args = p.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@-]*',args.dedicated_mac):
        p.error('use a known SSH hostname or user@hostname, not an option or command')
    target, before = clock(args.dedicated_mac)
    out=args.output.resolve(); out.mkdir(parents=False, exist_ok=False)
    raw=out/'observers'
    subprocess.run(['node','scripts/protocol-workerd-evidence.mjs','physical-sleep',str(raw)],cwd=ROOT,check=True,
                   env=dict(os.environ,PILLOWFORT_STUDY_EXTRA_MS=str(args.extra_final_wait_ms)))
    target_after, after = clock(args.dedicated_mac)
    if target_after != target:
        raise ValueError('Clock samples came from different hosts.')
    offset=[min(before[0],after[0]),max(before[1],after[1])]
    obs=json.loads((raw/'browser-results.json').read_text()); relay=json.loads((raw/'relay-observations.json').read_text())
    if not obs['passed'] or len(obs['faults']) != 1 or relay['extraFinalWaitMs'] != args.extra_final_wait_ms:
        raise ValueError('Missing completed observation with the requested detector.')
    outcome={'transport':args.transport,'extraFinalWaitMs':args.extra_final_wait_ms,'observerPlatform':platform.system(),
             'observerMinusHostMsBefore':before,'observerMinusHostMsAfter':after,'assumption':'No undetected clock step between calibrations.'}
    power=power_events(ssh(args.dedicated_mac,POWER))
    try:
        outcome.update(summarize(obs['faults'][0],relay,power,offset))
    except ValueError as exc:
        outcome.update(measured=False,physicalCycleVerified=False,reason=str(exc))
    (out/'physical-result.json').write_text(json.dumps(outcome,indent=2)+'\n')
    print(json.dumps(outcome,indent=2))
    if not outcome['measured']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
