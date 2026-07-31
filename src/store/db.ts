import localforage from 'localforage';
import type { Lang } from '../core/text';

export interface Script {
  id: string;
  title: string;
  body: string;
  lang: Lang;
  updated: number;
  /** Pronunciation aliases, one per line: "target: variant, variant" */
  aliases?: string;
}

export interface Settings {
  mirrorH: boolean;
  mirrorV: boolean;
  distanceFt: number;   // speaker's standing distance, 3–10
  sizeMult: number;     // 1.0–2.0 user multiplier on computed size
  diagOverlay: boolean; // diagnostics overlay on the prompter
  voiceStart: boolean;  // armed mode auto-starts on first phrase heard
  /** Lead: swap when all but the final content word is in (default).
      Confirm: swap only on phrase completion. */
  swapTiming: 'lead' | 'confirm';
  /** Next-phrase preview opacity (eye-voice span legibility). */
  previewOpacity: number;
  /** Speech engine: web (Safari API) or native (iPad app, on-device). */
  engine: 'web' | 'native';
}

export const DEFAULT_SETTINGS: Settings = {
  mirrorH: false,
  mirrorV: false,
  distanceFt: 5,
  sizeMult: 1.4,
  diagOverlay: false,
  voiceStart: true,
  swapTiming: 'lead',
  previewOpacity: 0.6,
  engine: 'web',
};

const db = localforage.createInstance({ name: 'voice-prompter' });

export async function loadScripts(): Promise<Script[]> {
  return (await db.getItem<Script[]>('scripts')) ?? [];
}

export async function saveScripts(scripts: Script[]): Promise<void> {
  await db.setItem('scripts', scripts);
}

export async function loadSettings(): Promise<Settings> {
  const saved = (await db.getItem<Partial<Settings>>('settings')) ?? {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(s: Settings): Promise<void> {
  await db.setItem('settings', s);
}

/* ---- Flight-recorder session logs (last 5 kept) ---- */
const MAX_SESSIONS = 5;

export async function saveSessionLog(log: unknown & { id: string }): Promise<void> {
  const sessions =
    (await db.getItem<Array<{ id: string }>>('sessions')) ?? [];
  const rest = sessions.filter((s) => s.id !== log.id);
  await db.setItem('sessions', [log, ...rest].slice(0, MAX_SESSIONS));
}

export async function loadSessionLogs(): Promise<unknown[]> {
  return (await db.getItem<unknown[]>('sessions')) ?? [];
}

/**
 * Seed the rig-test scripts once per device (existing scripts are never
 * touched; re-running is a no-op thanks to the flag).
 */
export async function seedRigScripts(seeds: Script[]): Promise<void> {
  // v4: adds "próprio" to the PT alias demo (first native rig tape,
  // t=54787). Upserts by id so updates reach devices seeded earlier
  // (the two rig-test scripts are fixtures; local edits to them are
  // intentionally replaced).
  const FLAG = 'seeded_rigtest_v4';
  if (await db.getItem(FLAG)) return;
  const scripts = await loadScripts();
  for (const seed of seeds) {
    const at = scripts.findIndex((s) => s.id === seed.id);
    const fresh = { ...seed, updated: Date.now() };
    if (at >= 0) scripts[at] = fresh;
    else scripts.push(fresh);
  }
  await saveScripts(scripts);
  await db.setItem(FLAG, 1);
}

/**
 * One-time, non-destructive migration from the scroll-era app: copy
 * localStorage scripts/settings into IndexedDB, leaving the originals
 * untouched.
 */
export async function migrateFromLocalStorage(): Promise<void> {
  if (await db.getItem('migrated')) return;
  try {
    const oldScripts = JSON.parse(localStorage.getItem('tp_scripts') ?? 'null');
    if (Array.isArray(oldScripts) && (await loadScripts()).length === 0) {
      const converted: Script[] = oldScripts
        .filter((s) => s && typeof s.body === 'string')
        .map((s) => ({
          id: String(s.id ?? crypto.randomUUID()),
          title: String(s.title ?? 'Untitled'),
          body: String(s.body),
          lang: 'en-US' as Lang,
          updated: Number(s.updated) || Date.now(),
        }));
      if (converted.length > 0) await saveScripts(converted);
    }
    const oldSettings = JSON.parse(localStorage.getItem('tp_settings') ?? 'null');
    if (oldSettings && typeof oldSettings === 'object') {
      const s = await loadSettings();
      if (typeof oldSettings.mirrorH === 'boolean') s.mirrorH = oldSettings.mirrorH;
      if (typeof oldSettings.mirrorV === 'boolean') s.mirrorV = oldSettings.mirrorV;
      await saveSettings(s);
    }
  } catch {
    /* corrupt old data — never block startup on migration */
  }
  await db.setItem('migrated', 1);
}
