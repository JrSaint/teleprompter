import { describe, it, expect } from 'vitest';
import { FlowModel } from './flowpredict';
import { PhraseMatcher } from './matcher';
import { segmentScript } from './segmenter';

describe('FlowModel', () => {
  it('needs three usable gaps before it predicts', () => {
    const m = new FlowModel();
    m.noteContent(0);
    m.noteContent(300);
    expect(m.medianRate()).toBeNull(); // 1 gap
    m.noteContent(600);
    expect(m.medianRate()).toBeNull(); // 2 gaps
    m.noteContent(900);
    expect(m.medianRate()).toBe(300);
  });

  it('ignores same-batch and pause gaps', () => {
    const m = new FlowModel();
    m.noteContent(0);
    m.noteContent(10);    // same recognizer emission — not speech rate
    m.noteContent(310);
    m.noteContent(5000);  // a pause, not a 4.7s word
    m.noteContent(5300);
    m.noteContent(5600);
    expect(m.medianRate()).toBe(300); // only the three 300ms gaps count
  });

  it('window: gated on confirmation pct, suspension, and cold model', () => {
    const m = new FlowModel();
    [0, 300, 600, 900].forEach((t) => m.noteContent(t));
    expect(m.window(2, 0.5)).toEqual({ fireAt: 900 + 600, deadline: 900 + 1080, rateMs: 300 });
    expect(m.window(2, 0.4)).toBeNull();   // under 50% confirmed
    expect(m.window(0, 1)).toBeNull();     // nothing left to predict
    m.noteUnmatched();
    expect(m.window(2, 0.5)).toBeNull();   // suspended
    m.noteMatched();
    expect(m.window(2, 0.5)).not.toBeNull();
  });
});

describe('matcher.flowAdvance', () => {
  it('advances one phrase with rule flow-predict and absorbs the tail', () => {
    const phrases = segmentScript(
      'Alpha bravo charlie delta. Foxtrot golf hotel india. Juliet kilo lima mike.',
      'en-US',
    );
    const m = new PhraseMatcher(phrases, { leadMode: true });
    m.feed(['alpha', 'bravo']);
    const e = m.flowAdvance();
    expect(e?.rule).toBe('flow-predict');
    expect(e?.to).toBe(1);
    expect(e?.evidence).toBe(2);
    // the predicted phrase's dropped tail is leftover-absorbed
    const r = m.feed(['charlie']);
    expect(r.matchedAny).toBe(true);
    expect(m.current).toBe(1);
  });

  it('never predicts the finish', () => {
    const phrases = segmentScript('Alpha bravo charlie delta.', 'en-US');
    const m = new PhraseMatcher(phrases, { leadMode: true });
    m.feed(['alpha', 'bravo']);
    expect(m.flowAdvance()).toBeNull();
    expect(m.finished).toBe(false);
  });

  it('a MULTI-word late tail is fully absorbed — it must not credit the next phrase', () => {
    // the predicted-past phrase left TWO unspoken words; when the
    // engine emits them late, single-shot absorption let the second
    // one exact-credit an identical token ahead and the display then
    // lead-advanced a full content word before it was spoken (review
    // finding, verified empirically against this exact shape)
    const phrases = segmentScript(
      'Alpha bravo charlie delta. Echo foxtrot delta golf. Hotel india juliet kilo.',
      'en-US',
    );
    const m = new PhraseMatcher(phrases, { leadMode: true });
    m.feed(['alpha', 'bravo']);
    expect(m.flowAdvance()?.to).toBe(1);
    // late tail of phrase 0 arrives: BOTH words absorb silently
    const r1 = m.feed(['charlie']);
    const r2 = m.feed(['delta']);
    expect(r1.matchedAny).toBe(true);
    expect(r2.matchedAny).toBe(true);
    expect(r2.contentHits).toBe(0); // no credit spills onto phrase 1's "delta"
    // speaking phrase 1's real words must NOT fire lead early: its
    // own "delta" is still unheard
    const r3 = m.feed(['echo', 'foxtrot']);
    expect(r3.events).toEqual([]);
    expect(m.current).toBe(1);
    // ...and the genuine "delta" + final complete it normally
    m.feed(['delta', 'golf']);
    expect(m.current).toBe(2);
  });
});
