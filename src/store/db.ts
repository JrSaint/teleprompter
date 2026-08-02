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
  /** SEGMENTER_VERSION last stamped on this script — segmentation is
      derived live from the body, so the stamp exists to make
      segmenter freshness VISIBLE in the data (script.updated moves
      when the algorithm does; B.3.3 finding 0). */
  segVersion?: number;
  /** Layout hash last stamped: the char budget the CURRENT font size
      implies (dynamic segmentation) — a size change re-stamps, so
      layout freshness is visible in the data like segmenter
      freshness. */
  layoutHash?: string;
}

export interface Settings {
  mirrorH: boolean;
  mirrorV: boolean;
  distanceFt: number;   // speaker's standing distance, 3–10
  sizeMult: number;     // 1.0–2.0 user multiplier on computed size
  diagOverlay: boolean; // diagnostics overlay on the prompter
  voiceStart: boolean;  // armed mode auto-starts on first phrase heard
  /** Swap timing per language (B.3.5 duel verdict: Flow locked for
      EN; PT stays Lead until its engine is cured). Lead: swap when
      all but the final content word is in. Confirm: swap only on
      completion. Flow: lead rules plus the pace-model predictive
      swap. */
  swapTimingByLang: Record<Lang, 'lead' | 'confirm' | 'flow'>;
  /** Next-phrase preview opacity (eye-voice span legibility). */
  previewOpacity: number;
  /** Speech engine: web (Safari API) or native (iPad app, on-device). */
  engine: 'web' | 'native';
  /** Display pattern: ladder (3 slots, strictly downward with a wrap
      to the top — the B.3.4 A/B verdict; default pending the column
      A/B), karaoke (2 slots, alternating), or column (Erika's
      second-voice design: full-script gradient column, active line
      pinned at a fixed reading anchor, ONE discrete step per
      voice-driven advance). */
  displayMode: 'karaoke' | 'ladder' | 'column';
  /** Column steps reposition instantly (no glide), crossfade only. */
  reduceMotion?: boolean;
  /** pt-BR ship-gate fallback (no UI — dev flag): server-assisted
      recognition for PT only. EN stays fully on-device, always. */
  ptServerAssisted?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mirrorH: false,
  mirrorV: false,
  distanceFt: 5,
  sizeMult: 1.4,
  diagOverlay: false,
  voiceStart: true,
  swapTimingByLang: { 'en-US': 'flow', 'pt-BR': 'lead' },
  previewOpacity: 0.6,
  engine: 'web',
  displayMode: 'ladder',
};

const db = localforage.createInstance({ name: 'voice-prompter' });

export async function loadScripts(): Promise<Script[]> {
  return (await db.getItem<Script[]>('scripts')) ?? [];
}

export async function saveScripts(scripts: Script[]): Promise<void> {
  await db.setItem('scripts', scripts);
}

export async function loadSettings(): Promise<Settings> {
  const saved =
    (await db.getItem<Partial<Settings> & { swapTiming?: string }>('settings')) ?? {};
  // pre-B.3.5 logs stored a single swapTiming scalar; the per-language
  // defaults (EN flow / PT lead — the duel verdict) supersede it
  delete saved.swapTiming;
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  merged.swapTimingByLang = {
    ...DEFAULT_SETTINGS.swapTimingByLang,
    ...(saved.swapTimingByLang ?? {}),
  };
  return merged;
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
  // v6: adds "pau" to the PT alias demo (B.3.3 tape, t=56772) and
  // stamps segVersion. Upserts by id so updates reach devices seeded
  // earlier (the two rig-test scripts are fixtures; local edits to
  // them are intentionally replaced).
  const FLAG = 'seeded_rigtest_v6';
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
 * Stamp every stored script (user scripts AND seeds) with the current
 * segmenter version on load. Segmentation is always derived live from
 * the body, so nothing is recomputed — but the stamp moves
 * script.updated whenever the algorithm changes, making segmenter
 * freshness visible in the data instead of assumed (B.3.3 finding 0:
 * a re-segmentation "shipped" invisibly is indistinguishable from one
 * that never shipped).
 */
export async function ensureSegmenterVersion(
  version: number,
  layoutHash?: string,
): Promise<void> {
  const scripts = await loadScripts();
  let touched = false;
  for (const s of scripts) {
    if (s.segVersion !== version || (layoutHash !== undefined && s.layoutHash !== layoutHash)) {
      s.segVersion = version;
      if (layoutHash !== undefined) s.layoutHash = layoutHash;
      s.updated = Date.now();
      touched = true;
    }
  }
  if (touched) await saveScripts(scripts);
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
