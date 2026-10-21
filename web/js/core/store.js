// AutoGlow 2 - Minimal shared state store
// subscribe(select, fn) calls fn only when the selected slice changes.

export function createStore(initial = {}) {
  let state = { ...initial };
  const subscribers = new Set();

  return {
    get: () => state,

    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const sub of subscribers) {
        const value = sub.select(state);
        if (!Object.is(value, sub.last)) {
          sub.last = value;
          sub.fn(value, state);
        }
      }
    },

    subscribe(select, fn) {
      const sub = { select, fn, last: select(state) };
      subscribers.add(sub);
      return () => subscribers.delete(sub);
    }
  };
}

export const appStore = createStore({
  connected: true,
  lightingMode: null
});
