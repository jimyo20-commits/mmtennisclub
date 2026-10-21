// 무명회 테니스 클럽 - 공유 데이터 API (Netlify Functions + Netlify Blobs)
//  GET  /api/state[?rev=N]        현재 데이터 (rev가 같으면 {same:true})
//  GET  /api/state?backups         서버 백업 목록
//  GET  /api/state?backup=YYYY-MM-DD  서버 백업 내용
//  POST /api/state {ops:[...]}     변경 내용 반영 후 최신 데이터 반환
import { getStore } from "@netlify/blobs";

const KEY = "state";
const BAD = new Set(["__proto__", "constructor", "prototype"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// ---- 변경 내용(ops) 적용 -------------------------------------------------
// 경로의 "@id" 단계는 배열 안에서 id가 같은 항목을 가리킵니다.
function parentOf(state, p) {
  let cur = state;
  for (let i = 0; i < p.length - 1; i++) {
    const k = p[i];
    if (k[0] === "@") {
      cur = Array.isArray(cur) ? cur.find((x) => x && x.id === k.slice(1)) : undefined;
      if (!cur) return null;
    } else {
      if (!isObj(cur)) return null;
      if (cur[k] === undefined) cur[k] = {};
      cur = cur[k];
    }
  }
  return [cur, p[p.length - 1]];
}

function applyOp(state, op) {
  if (!op || !Array.isArray(op.p)) return state;
  const p = op.p;
  if (p.length === 0) return isObj(op.v) ? op.v : state; // 전체 교체 (복원)
  if (p.some((k) => typeof k !== "string" || BAD.has(k))) return state;
  const r = parentOf(state, p);
  if (!r) return state;
  const [parent, last] = r;
  if ("add" in op) {
    if (!isObj(parent) || !isObj(op.add) || typeof op.add.id !== "string") return state;
    if (!Array.isArray(parent[last])) parent[last] = [];
    if (!parent[last].some((x) => x && x.id === op.add.id)) parent[last].push(op.add);
  } else if ("rm" in op) {
    if (isObj(parent) && Array.isArray(parent[last])) parent[last] = parent[last].filter((x) => !(x && x.id === op.rm));
  } else if (op.d) {
    if (isObj(parent)) delete parent[last];
  } else if ("v" in op) {
    if (last[0] === "@") {
      if (!Array.isArray(parent)) return state;
      const i = parent.findIndex((x) => x && x.id === last.slice(1));
      if (i >= 0) parent[i] = op.v;
    } else if (isObj(parent)) {
      parent[last] = op.v;
    }
  }
  return state;
}

const kstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function snapshot(store, state, name) {
  try {
    await store.setJSON("backup/" + name, state, { onlyIfNew: true });
    const { blobs } = await store.list({ prefix: "backup/before-restore-" });
    const keys = blobs.map((b) => b.key).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 20))) await store.delete(k);
  } catch (_) {}
}

export default async (req) => {
  const store = getStore({ name: "moomyung", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.has("backups")) {
      const { blobs } = await store.list({ prefix: "backup/" });
      return json({ ok: true, backups: blobs.map((b) => b.key.slice(7)).sort().reverse() });
    }
    const bk = url.searchParams.get("backup");
    if (bk) {
      if (!/^[0-9A-Za-z\-_.]{1,60}$/.test(bk)) return json({ ok: false }, 400);
      const data = await store.get("backup/" + bk, { type: "json" });
      return data ? json({ ok: true, state: data }) : json({ ok: false, error: "not found" }, 404);
    }
    const cur = await store.get(KEY, { type: "json" });
    if (!cur) return json({ ok: true, rev: 0, state: null });
    const want = url.searchParams.get("rev");
    if (want !== null && Number(want) === cur.rev) return json({ ok: true, same: true, rev: cur.rev });
    return json({ ok: true, rev: cur.rev, state: cur.state });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, 5000) : [];
    if (!ops.length) return json({ ok: false, error: "no ops" }, 400);
    const replacing = ops.some((o) => o && Array.isArray(o.p) && o.p.length === 0);

    for (let attempt = 0; attempt < 12; attempt++) {
      const entry = await store.getWithMetadata(KEY, { type: "json", consistency: "strong" });
      const cur = entry ? entry.data : { rev: 0, state: null };
      if (replacing && cur.state) await snapshot(store, cur.state, "before-restore-" + Date.now());
      let state = cur.state ? structuredClone(cur.state) : {};
      for (const op of ops) state = applyOp(state, op);
      const next = { rev: (cur.rev || 0) + 1, state };
      const res = entry
        ? await store.setJSON(KEY, next, { onlyIfMatch: entry.etag })
        : await store.setJSON(KEY, next, { onlyIfNew: true });
      if (res && res.modified === false) { // 동시에 다른 사람이 저장함 → 잠깐 쉬고 다시 시도
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
        continue;
      }
      return json({ ok: true, rev: next.rev, state });
    }
    return json({ ok: false, error: "busy" }, 503);
  }

  return json({ ok: false }, 405);
};

export const config = { path: "/api/state" };
