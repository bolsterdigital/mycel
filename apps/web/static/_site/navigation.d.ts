export function fit(input: {
  costs: number[];
  available: number;
  shown?: number;
  slack?: number;
}): number;
export function priority<T>(parts: {
  search?: T | null;
  languages?: T | null;
  second?: T | null;
  name?: T | null;
  links?: T[];
}): T[];
export function stickyFits(input: {
  oneRow: boolean;
  height: number;
  viewport: number;
  share?: number;
}): boolean;
export function actionFit(input: {
  available: number;
  natural: number;
  narrowest: number;
}): 'natural' | 'tight' | 'out';
