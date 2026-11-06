/* Fetching a JSON file the wall cannot start without, retried.
 *
 * One dropped connection while the geography loaded (ERR_CONNECTION_RESET
 * from the laptop's Python server, November 2) left the wall on "Loading
 * geography..." until someone reloaded; behind a tunnel a viewer would see
 * the same blank page. So a network error, a server error (5xx), a rate limit
 * (429) or a body cut off mid-read is tried again, four tries in all, about
 * six seconds end to end. A 404 or any other 4xx is an answer, not a fault:
 * thrown at once, or null when the file is optional.
 *
 * The poller does not use this: it tries again on its next tick anyway.
 */

const DELAYS = [500, 1500, 4000];

export async function getJSON(url, init = {}, { optional = false } = {}) {
  for (let i = 0; ; i++) {
    let err;
    try {
      const r = await fetch(url, init);
      if (r.ok) return await r.json();
      err = new Error(`${url}: ${r.status}`);
      if (r.status < 500 && r.status !== 429) {
        if (optional) return null;
        throw Object.assign(err, { final: true });
      }
    } catch (e) {
      if (e.final) throw e;
      err = e;
    }
    if (i >= DELAYS.length) throw err;
    await new Promise((res) => setTimeout(res, DELAYS[i]));
  }
}
