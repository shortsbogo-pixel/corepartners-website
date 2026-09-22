// R2 에 저장된 주간 미션 조건을 읽고 쓴다. 규칙·렌더링은 ./mission-config.ts (순수 모듈).
import { bindings } from "./bindings.server";
import {
  DEFAULT_MISSION_CONFIG,
  type MissionConfig,
  validateMissionConfig,
} from "./mission-config";

export const MISSION_CONFIG_KEY = "mission-config";
export const MISSION_HISTORY_PREFIX = "mission-config-history/";

export type LoadedMissionConfig = {
  config: MissionConfig;
  source: "saved" | "default";
  savedAt?: string;
};

/**
 * 저장값을 읽는다. 없거나(첫 배포), 읽기 실패, 검증 실패 시에는 기본값을 돌려준다.
 * 공개 페이지가 이 함수 실패로 깨지는 일은 없어야 하므로 예외를 밖으로 던지지 않는다.
 */
export async function loadMissionConfig(): Promise<LoadedMissionConfig> {
  const storage = bindings().STORAGE;
  if (storage) {
    try {
      const obj = await storage.get(MISSION_CONFIG_KEY);
      if (obj) {
        const raw = (await obj.json()) as { config?: unknown; savedAt?: string };
        const v = validateMissionConfig(raw?.config);
        if (v.ok) return { config: v.config, source: "saved", savedAt: raw.savedAt };
        console.error("mission-config invalid; using default", v.errors);
      }
    } catch (e) {
      console.error("mission-config read failed; using default", e);
    }
  }
  return { config: DEFAULT_MISSION_CONFIG, source: "default" };
}

/** 현재값을 덮어쓰고, 같은 내용을 이력 키에도 남긴다(되돌리기·감사용). */
export async function saveMissionConfig(config: MissionConfig, now: Date): Promise<void> {
  const storage = bindings().STORAGE;
  if (!storage) throw new Error("Storage not available");
  const savedAt = now.toISOString();
  const body = JSON.stringify({ config, savedAt });
  const meta = { httpMetadata: { contentType: "application/json" } };
  await storage.put(`${MISSION_HISTORY_PREFIX}${savedAt}.json`, body, meta);
  await storage.put(MISSION_CONFIG_KEY, body, meta);
}
