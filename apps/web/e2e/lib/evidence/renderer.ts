// A silent renderer needs an already-enabled debugger: enabling the domain after a tight
// JavaScript loop starts stalls too. Arm before navigation and interrupt only failed pages.
// Rejected: a retry, page-script instrumentation, or recording source/locals from the operator.
import type { CDPSession, Page } from '@playwright/test';

/** How long one question after the test may take; a hung page otherwise costs a second timeout. */
const ASK_MS = 2000;

/** The answer, or `{ noAnswerMs }` when none came in time; an error is an answer too. */
export const ask = async <T>(question: () => Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<{ noAnswerMs: number }>((resolve) => {
    timer = setTimeout(() => resolve({ noAnswerMs: ASK_MS }), ASK_MS);
  });
  try {
    return await Promise.race([
      question().then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error: String(error) })
      ),
      silence,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export interface RendererDebugger {
  session?: CDPSession;
  scripts: Map<string, string>;
  armed: unknown;
}

/** Keep URL reduction with the evidence fixture, which already removes transient credentials. */
export async function armRenderer(
  page: Page,
  path: (url: string) => string
): Promise<RendererDebugger> {
  const state: RendererDebugger = { scripts: new Map(), armed: null };
  state.armed = await ask(async () => {
    const session = await page.context().newCDPSession(page);
    state.session = session;
    session.on('Debugger.scriptParsed', (script) => {
      state.scripts.set(script.scriptId, path(script.url));
    });
    await session.send('Debugger.enable');
    return true;
  });
  return state;
}

/** At most 32 locations, without scope values or source. Never leave teardown on a paused page. */
export async function rendererStack(state: RendererDebugger | undefined) {
  const session = state?.session;
  if (!session || !state) return { error: 'debugger unavailable' };
  const paused = new Promise<unknown>((resolve) => {
    session.once('Debugger.paused', (event) =>
      resolve({
        reason: event.reason,
        frames: event.callFrames.slice(0, 32).map((frame) => ({
          name: frame.functionName,
          url: state.scripts.get(frame.location.scriptId) ?? '',
          line: frame.location.lineNumber + 1,
          column: frame.location.columnNumber + 1,
        })),
      })
    );
  });
  try {
    return {
      armed: state.armed,
      ...(await ask(async () => {
        await session.send('Debugger.pause');
        return paused;
      })),
    };
  } finally {
    // Queue resume even when pause missed the deadline; command order prevents a late pause
    // from surviving teardown. The failed assertion is never retried after this interruption.
    void session.send('Debugger.resume').catch(() => {});
  }
}
