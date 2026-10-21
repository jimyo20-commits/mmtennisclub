// 매주 월요일 00:00(한국시간)에 운영자 접속과 상관없이 자동 백업합니다.
//  1) Netlify 저장소(Blobs)에 weekly-날짜 스냅샷 (최근 26주 보관)
//  2) GITHUB_TOKEN 이 설정돼 있으면 GitHub backups 브랜치에도 저장
import { getStore } from "@netlify/blobs";
import { backupToGithub } from "./github-backup.mjs";

const KEY = "state";
const kstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export default async () => {
  const store = getStore({ name: "moomyung", consistency: "strong" });
  const cur = await store.get(KEY, { type: "json", consistency: "strong" });
  if (!cur || !cur.state) return;
  try {
    await store.setJSON("backup/weekly-" + kstDate(), cur.state, { onlyIfNew: true });
    const { blobs } = await store.list({ prefix: "backup/weekly-" });
    const keys = blobs.map((b) => b.key).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 26))) await store.delete(k);
  } catch (_) {}
  try { await backupToGithub(store, "주간 자동 백업"); } catch (_) {}
};

// 일요일 15:00 UTC = 월요일 00:00 KST
export const config = { schedule: "0 15 * * 0" };
