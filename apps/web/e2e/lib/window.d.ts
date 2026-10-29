// What specs install on `window` through `addInitScript` and read back with `page.evaluate`.
// Declared once here instead of a cast per call site.
export {};

declare global {
  interface Window {
    /** CSP violations the writing surface reported, collected per page (#11-writer-csp). */
    writerCspViolations: string[];
  }
}
