import { standaloneFetch } from './standalone-api.mjs';

// The ordinary app uses the Node API. The exported HTML uses the same catalog
// engine locally, so opening the file never requires a running server.
export function apiFetch(input, options) {
  if (import.meta.env.MODE === 'standalone') return standaloneFetch(input, options);
  return fetch(input, options);
}
