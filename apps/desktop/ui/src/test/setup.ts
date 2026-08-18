import '@testing-library/jest-dom/vitest'

// Node's experimental `localStorage` global shadows jsdom's implementation
// and stays undefined without `--localstorage-file`; give tests a real
// Storage-shaped shim so code using window.localStorage works.
if (globalThis.localStorage === undefined) {
  const store = new Map<string, string>()
  const shim: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key)
    },
    setItem: (key, value) => {
      store.set(key, String(value))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(window, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  })
}
