// "지금 백업"(수동) → 현재 공유 데이터를 GitHub 저장소의 backups 브랜치에 저장합니다.
// 필요한 환경변수: GITHUB_TOKEN (Contents: Read and write 권한). 선택: GITHUB_REPO (기본 jimyo20-commits/mmtennisclub)
// 개인정보 보호: 전화번호 가운데 4자리는 0000으로 바꾸고, 비밀번호(pw)와 사진은 제외합니다.
import { getStore } from "@netlify/blobs";

const KEY = "state";
const BRANCH = "backups";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-0000-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-0000-${d.slice(6)}`;
  return String(p || "").replace(/^(\D*\d{3}\D*)(\d{4}|\*{4})(\D*\d{4}\D*)$/, "$10000$3");
}

function strip(o) { // 사진(data:...) 제거
  if (Array.isArray(o)) o.forEach(strip);
  else if (o && typeof o === "object") for (const k of Object.keys(o)) {
    if (typeof o[k] === "string" && o[k].startsWith("data:")) delete o[k]; else strip(o[k]);
  }
}

export function sanitize(state) {
  const s = structuredClone(state);
  for (const m of s.members || []) { m.phone = maskPhone(m.phone); delete m.pw; }
  for (const g of s.guests || []) if (g && g.phone) g.phone = maskPhone(g.phone);
  strip(s);
  return s;
}

const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().replace("T", "_").slice(0, 19).replace(/:/g, "-");
let last = 0;

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const token = process.env.GITHUB_TOKEN;
  if (!token) return json({ ok: false, error: "no_token" }, 501);
  if (Date.now() - last < 15000) return json({ ok: false, error: "too_fast" }, 429);
  last = Date.now();
  const repo = process.env.GITHUB_REPO || "jimyo20-commits/mmtennisclub";
  const gh = (path, init = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "moomyung-backup", "content-type": "application/json" },
  });

  const store = getStore({ name: "moomyung", consistency: "strong" });
  const cur = await store.get(KEY, { type: "json", consistency: "strong" });
  if (!cur || !cur.state) return json({ ok: false, error: "empty" }, 404);

  // backups 브랜치가 없으면 기본 브랜치에서 만듭니다 (이 브랜치는 Netlify 사이트 배포에 쓰이지 않음)
  let r = await gh(`/git/ref/heads/${BRANCH}`);
  if (r.status === 404) {
    const repoInfo = await (await gh("")).json();
    const base = await (await gh(`/git/ref/heads/${repoInfo.default_branch || "main"}`)).json();
    r = await gh("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: base.object.sha }) });
    if (!r.ok) return json({ ok: false, error: "branch", detail: r.status }, 502);
  } else if (!r.ok) return json({ ok: false, error: "github", detail: r.status }, 502);

  const name = `backups/backup-${kst()}.json`;
  const content = Buffer.from(JSON.stringify(sanitize(cur.state), null, 1), "utf8").toString("base64");
  const put = await gh(`/contents/${name}`, { method: "PUT", body: JSON.stringify({ message: `수동 백업 ${name.slice(15, 34)}`, content, branch: BRANCH }) });
  if (!put.ok) return json({ ok: false, error: "put", detail: put.status }, 502);
  return json({ ok: true, file: name, branch: BRANCH });
};

export const config = { path: "/api/github-backup" };
