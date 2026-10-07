import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { GitHubClient, SyncError } from '../lib/github';
import type { Ledger } from '../lib/ledger';
import { mergeLedgers } from '../lib/merge';
import { syncLedger } from '../lib/sync';
import type { DeviceSettings, Session } from '../lib/vault';

export type SyncStatus =
  | { state: 'off' }
  | { state: 'syncing'; at?: string }
  | { state: 'ok'; at: string }
  | { state: 'error'; message: string; at?: string };

export interface SyncControls {
  device: DeviceSettings | null;
  status: SyncStatus;
  syncNow: () => Promise<void>;
  /** Ask for a sync soon (after a local change). */
  requestSync: () => void;
  connect: (repo: string, token: string, deviceName: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

const PERIODIC_MS = 2 * 60_000;
const DEBOUNCE_MS = 2_500;

export function useSync(
  session: Session | null,
  ledgerRef: MutableRefObject<Ledger | null>,
  apply: (l: Ledger) => Promise<void>,
  onImported: (n: number) => void,
): SyncControls {
  const [device, setDevice] = useState<DeviceSettings | null>(null);
  const [status, setStatus] = useState<SyncStatus>({ state: 'off' });
  const running = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const deviceRef = useRef<DeviceSettings | null>(null);
  deviceRef.current = device;

  useEffect(() => {
    setDevice(null);
    setStatus({ state: 'off' });
    if (!session) return;
    let cancelled = false;
    session.deviceSettings().then((d) => {
      if (cancelled) return;
      setDevice(d);
      setStatus(d.sync ? { state: 'ok', at: d.lastSyncAt ?? '' } : { state: 'off' });
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const syncNow = useCallback(async () => {
    const cfg = deviceRef.current?.sync;
    if (!session || !cfg || !ledgerRef.current) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    setStatus((s) => ({ state: 'syncing', at: 'at' in s ? s.at : undefined }));
    try {
      const before = ledgerRef.current;
      const res = await syncLedger(before, {
        client: new GitHubClient(cfg.repo, cfg.token),
        seal: (l) => session.sealForSync(l),
        open: (t) => session.openFromSync(t),
        device: cfg.deviceName,
      });
      const latest = ledgerRef.current!;
      // If something changed on this phone while syncing, keep it and sync again.
      const final = latest === before ? res.ledger : mergeLedgers(latest, res.ledger);
      if (latest !== before) again.current = true;
      await apply(final);
      const at = new Date().toISOString();
      const d = { ...deviceRef.current, lastSyncAt: at };
      setDevice(d);
      session.saveDeviceSettings(d).catch(() => {});
      setStatus({ state: 'ok', at });
      if (res.imported) onImported(res.imported);
    } catch (e) {
      const message = e instanceof SyncError || e instanceof Error ? e.message : 'Sync failed.';
      setStatus((s) => ({ state: 'error', message, at: 'at' in s ? s.at : undefined }));
    } finally {
      running.current = false;
      if (again.current) {
        again.current = false;
        timer.current = setTimeout(() => void syncNow(), 500);
      }
    }
  }, [session, ledgerRef, apply, onImported]);

  const requestSync = useCallback(() => {
    if (!deviceRef.current?.sync) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void syncNow(), DEBOUNCE_MS);
  }, [syncNow]);

  // Sync when unlocked, when the app comes back to the foreground, and every couple of minutes.
  const configured = !!device?.sync;
  useEffect(() => {
    if (!session || !configured) return;
    void syncNow();
    const onVisible = () => document.visibilityState === 'visible' && void syncNow();
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(() => document.visibilityState === 'visible' && void syncNow(), PERIODIC_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
      clearTimeout(timer.current);
    };
  }, [session, configured, syncNow]);

  const connect = useCallback(async (repo: string, token: string, deviceName: string) => {
    if (!session) return;
    const client = new GitHubClient(repo.trim(), token.trim());
    await client.check();
    const d: DeviceSettings = { ...deviceRef.current, sync: { repo: repo.trim(), token: token.trim(), deviceName: deviceName.trim() || 'Phone' } };
    await session.saveDeviceSettings(d);
    deviceRef.current = d;
    setDevice(d);
  }, [session]);

  const disconnect = useCallback(async () => {
    if (!session) return;
    const d: DeviceSettings = { ...deviceRef.current, sync: undefined };
    await session.saveDeviceSettings(d);
    setDevice(d);
    setStatus({ state: 'off' });
  }, [session]);

  return { device, status, syncNow, requestSync, connect, disconnect };
}

export function describeStatus(s: SyncStatus): string {
  if (s.state === 'off') return 'Sync is off';
  if (s.state === 'syncing') return 'Syncing…';
  if (s.state === 'error') return s.message;
  return s.at ? `Synced ${timeAgo(s.at)}` : 'Sync is on';
}

export function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
