import { diag } from './diag';

/**
 * The prompting state machine — explicit and logged, per spec.
 *
 * idle      mic off, manual navigation only
 * armed     mic on, waiting to hear the first (current) phrase
 * following actively matching and advancing
 * holding   mic on, but nothing matched recently (silence / ad-lib)
 * finished  advanced past the last phrase
 */
export type FlowState = 'idle' | 'armed' | 'following' | 'holding' | 'finished';

export class Flow {
  private _state: FlowState = 'idle';
  onChange?: (s: FlowState) => void;

  get state(): FlowState {
    return this._state;
  }

  to(next: FlowState): void {
    if (next === this._state) return;
    diag.event(`state: ${this._state} → ${next}`);
    this._state = next;
    this.onChange?.(next);
  }
}
