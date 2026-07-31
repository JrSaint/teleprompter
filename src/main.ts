import './style.css';
import {
  loadScripts, loadSettings, migrateFromLocalStorage, seedRigScripts,
  ensureSegmenterVersion, type Script, type Settings,
} from './store/db';
import { RIG_SCRIPTS } from './store/seeds';
import { SEGMENTER_VERSION } from './core/segmenter';
import { createSetupView } from './ui/SetupView';
import { createPrompterView } from './ui/PrompterView';
import { createCalibrationView } from './ui/CalibrationView';
import type { Lang } from './core/text';
import { diag } from './core/diag';

const root = document.getElementById('app')!;

interface ViewHandle {
  el: HTMLElement;
  dispose?: () => void;
  controller?: unknown;
}

let active: ViewHandle | null = null;

function show(view: ViewHandle): void {
  active?.dispose?.();
  root.innerHTML = '';
  root.appendChild(view.el);
  active = view;
}

async function showSetup(settings: Settings): Promise<void> {
  const scripts = await loadScripts();
  show(
    createSetupView(scripts, settings, {
      onPrompt: (script) => showPrompter(script, settings),
      onCalibrate: (lang) => showCalibration(settings, lang),
    }),
  );
}

function showPrompter(script: Script, settings: Settings): void {
  const view = createPrompterView(script, settings, () => void showSetup(settings));
  show(view);
  // Debug/simulation handle: lets development and automated checks feed
  // words end-to-end without a microphone (also used by unit-less rig
  // dry runs on the Mac). Force-arms first, since a denied/absent mic
  // correctly returns the flow to idle. Harmless in production.
  (window as unknown as Record<string, unknown>).__vf = {
    controller: view.controller,
    feed: (words: string[]) => {
      if (!view.controller.running) view.controller.flow.to('armed');
      view.controller.consume(words);
    },
    diag,
  };
}

function showCalibration(settings: Settings, lang: Lang): void {
  show(createCalibrationView(settings, lang, () => void showSetup(settings)));
}

async function boot(): Promise<void> {
  await migrateFromLocalStorage();
  await seedRigScripts(RIG_SCRIPTS);
  await ensureSegmenterVersion(SEGMENTER_VERSION);
  const settings = await loadSettings();
  await showSetup(settings);
  if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

void boot();
