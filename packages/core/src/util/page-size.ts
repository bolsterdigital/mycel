// The largest page a list use case accepts. An admin list that wants "all of them" asks for this
// and sees at most this many. Rejected: `100` per schema and per caller, where a smaller maximum
// in a schema would only show up as a refused request in one admin screen.
export const MAX_PAGE_SIZE = 100;
