import localforage from 'localforage';
import type { Lang } from '../core/text';

export interface Script {
  id: string;
  title: string;
  body: string;
  lang: Lang;
  updated: number;
}

export interface Settings {
  mirrorH: boolean;
  mirrorV: boolean;
  distanceFt: number;   // speaker's standing distance, 3–10
  sizeMult: number;     // 1.0–2.0 user multiplier on computed size
  diagOverlay: boolean; // diagnostics overlay on the prompter
  voiceStart: boolean;  // armed mode auto-starts on first phrase heard
}

export const DEFAULT_SETTINGS: Settings = {
  mirrorH: false,
  mirrorV: false,
  distanceFt: 5,
  sizeMult: 1.4,
  diagOverlay: false,
  voiceStart: true,
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

/**
 * Seed the rig-test scripts once per device (existing scripts are never
 * touched; re-running is a no-op thanks to the flag).
 */
export async function seedRigScripts(seeds: Script[]): Promise<void> {
  const FLAG = 'seeded_rigtest_v1';
  if (await db.getItem(FLAG)) return;
  const scripts = await loadScripts();
  const have = new Set(scripts.map((s) => s.id));
  let added = false;
  for (const seed of seeds) {
    if (!have.has(seed.id)) {
      scripts.push({ ...seed, updated: Date.now() });
      added = true;
    }
  }
  if (added) await saveScripts(scripts);
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
