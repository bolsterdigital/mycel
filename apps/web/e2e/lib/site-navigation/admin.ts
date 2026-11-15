// The menu editor's flows in admin.spec.ts, behind one import: the spec stands at its size budget
// (scripts/gates/e2e-budget.test.mjs), and each flow lives in its own file here.
export { exerciseMenuEditor as editor } from './editor';
export { exerciseNavigationPublication as publication } from './publication';
export { exerciseNavigationWriter as writer } from './writer';
