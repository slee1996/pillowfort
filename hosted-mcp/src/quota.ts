import { DurableObject } from 'cloudflare:workers';
import type { Env, LeaseResult } from './env';

interface Lease {
  id: string;
  principalId: string;
  startedAt: number;
  expiresAt: number;
  reservedSeconds: number;
}
interface QuotaState {
  day: string;
  usedSeconds: number;
  lastStartAt: number;
  leases: Lease[];
}

function integer(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Invalid hosted MCP quota configuration.');
  }
  return parsed;
}

/** Global reservation ledger: metadata only, no participant or room credentials. */
export class ParticipantQuota extends DurableObject<Env> {
  private normalize(state: QuotaState | undefined, now: number): QuotaState {
    const day = new Date(now).toISOString().slice(0, 10);
    const current = state ?? { day, usedSeconds: 0, lastStartAt: 0, leases: [] };
    if (current.day !== day) {
      const midnight = Date.parse(`${day}T00:00:00Z`);
      current.day = day;
      current.usedSeconds = 0;
      for (const lease of current.leases) {
        lease.reservedSeconds = Math.max(0, Math.ceil((lease.expiresAt - Math.max(midnight, lease.startedAt)) / 1000));
        current.usedSeconds += lease.reservedSeconds;
      }
    }
    current.leases = current.leases.filter(lease => lease.expiresAt > now);
    return current;
  }

  async status() {
    const now = Date.now();
    const state = this.normalize(await this.ctx.storage.get<QuotaState>('quota'), now);
    const maxActiveSessions = integer(this.env.MAX_ACTIVE_SESSIONS, 1, 10);
    const maxSessionSeconds = integer(this.env.MAX_SESSION_SECONDS, 30, 3600);
    const dailySeconds = integer(this.env.MAX_DAILY_SESSION_MINUTES, 1, 1440) * 60;
    if (dailySeconds < maxActiveSessions * maxSessionSeconds) throw new Error('Daily session budget must cover concurrent maximum leases.');
    const remainingSeconds = Math.max(0, dailySeconds - state.usedSeconds);
    const nextDay = Date.parse(`${state.day}T00:00:00Z`) + 86_400_000;
    const retryAfter = state.leases.length >= maxActiveSessions
      ? Math.max(1, Math.ceil((Math.min(...state.leases.map(lease => lease.expiresAt)) - now) / 1000))
      : remainingSeconds < maxSessionSeconds ? Math.max(1, Math.ceil((nextDay - now) / 1000))
      : Math.max(0, Math.ceil((state.lastStartAt + 20_000 - now) / 1000));
    return {
      advisory: true, participantAllocated: false, activeSessions: state.leases.length,
      maxActiveSessions, maxSessionSeconds, remainingDailySessionSeconds: remainingSeconds,
      canStartFullSession: retryAfter === 0, retryAfterSeconds: retryAfter, sessionStartSpacingSeconds: 20,
    };
  }

  async acquire(leaseId: string, principalId: string, ttlMs: number): Promise<LeaseResult> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(leaseId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(principalId)) {
      return { ok: false, code: 'INVALID_LEASE', retryAfter: 0 };
    }
    const concurrency = integer(this.env.MAX_ACTIVE_SESSIONS, 1, 10);
    const maximumSeconds = integer(this.env.MAX_SESSION_SECONDS, 30, 3600);
    const dailySeconds = integer(this.env.MAX_DAILY_SESSION_MINUTES, 1, 1440) * 60;
    if (dailySeconds < concurrency * maximumSeconds) throw new Error('Daily session budget must cover concurrent maximum leases.');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > maximumSeconds * 1000) {
      return { ok: false, code: 'INVALID_LEASE', retryAfter: 0 };
    }
    return this.ctx.storage.transaction(async transaction => {
      const now = Date.now();
      const state = this.normalize(await transaction.get<QuotaState>('quota'), now);
      const existing = state.leases.find(lease => lease.id === leaseId);
      if (existing) return existing.principalId === principalId
        ? { ok: true, expiresAt: existing.expiresAt }
        : { ok: false, code: 'INVALID_LEASE', retryAfter: 0 };
      const principalLease = state.leases.find(lease => lease.principalId === principalId);
      if (principalLease) return { ok: false, code: 'PRINCIPAL_SESSION_LIMIT', retryAfter: Math.max(1, Math.ceil((principalLease.expiresAt - now) / 1000)) };
      if (state.leases.length >= concurrency) return { ok: false, code: 'SESSION_CAPACITY', retryAfter: Math.max(1, Math.ceil((Math.min(...state.leases.map(lease => lease.expiresAt)) - now) / 1000)) };
      if (now - state.lastStartAt < 20_000) return { ok: false, code: 'SESSION_START_RATE', retryAfter: Math.ceil((20_000 - (now - state.lastStartAt)) / 1000) };
      const reservedSeconds = Math.ceil(ttlMs / 1000);
      if (state.usedSeconds + reservedSeconds > dailySeconds) {
        const nextDay = Date.parse(`${state.day}T00:00:00Z`) + 86_400_000;
        return { ok: false, code: 'DAILY_SESSION_BUDGET', retryAfter: Math.max(1, Math.ceil((nextDay - now) / 1000)) };
      }
      const expiresAt = now + ttlMs;
      state.leases.push({ id: leaseId, principalId, startedAt: now, expiresAt, reservedSeconds });
      state.usedSeconds += reservedSeconds;
      state.lastStartAt = now;
      await transaction.put('quota', state);
      await transaction.setAlarm(Math.min(...state.leases.map(lease => lease.expiresAt)));
      return { ok: true, expiresAt };
    });
  }

  /** Call only after all owned participants are disposed or the actor was evicted. */
  async release(leaseId: string): Promise<void> {
    await this.ctx.storage.transaction(async transaction => {
      const now = Date.now();
      const state = this.normalize(await transaction.get<QuotaState>('quota'), now);
      const lease = state.leases.find(item => item.id === leaseId);
      if (lease) {
        const unused = Math.max(0, Math.min(lease.reservedSeconds, Math.floor((lease.expiresAt - now) / 1000)));
        state.usedSeconds = Math.max(0, state.usedSeconds - unused);
        state.leases = state.leases.filter(item => item.id !== leaseId);
      }
      await transaction.put('quota', state);
      if (state.leases.length) await transaction.setAlarm(Math.min(...state.leases.map(item => item.expiresAt)));
      else await transaction.deleteAlarm();
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.transaction(async transaction => {
      const state = this.normalize(await transaction.get<QuotaState>('quota'), Date.now());
      await transaction.put('quota', state);
      if (state.leases.length) await transaction.setAlarm(Math.min(...state.leases.map(lease => lease.expiresAt)));
    });
  }
}
