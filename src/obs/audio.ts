// Узровень гуку з падзеі obs-websocket InputVolumeMeters для waveline.
// inputLevelsMul — для кожнага канала [magnitude, peak, inputPeak] у лінейным маштабе 0…1.

/** Ніжэй за гэта — цішыня (дБ). */
export const FLOOR_DB = -50;
/** Вышэй за гэта — максімум (дБ). */
export const CEILING_DB = -3;

export function mulToDb(mul: number): number {
  return mul > 0 ? 20 * Math.log10(mul) : -Infinity;
}

/** Пераўтварае дБ у 0…1 лінейна паміж FLOOR_DB і CEILING_DB. */
export function dbToLevel(db: number, floorDb = FLOOR_DB, ceilingDb = CEILING_DB): number {
  if (!Number.isFinite(db) || db <= floorDb) return 0;
  if (db >= ceilingDb) return 1;
  return (db - floorDb) / (ceilingDb - floorDb);
}

/** Узровень крыніцы 0…1: найгучнейшы канал па magnitude (больш роўны, чым peak). */
export function levelFromMeters(inputLevelsMul: unknown): number {
  if (!Array.isArray(inputLevelsMul)) return 0;
  let max = 0;
  for (const channel of inputLevelsMul) {
    const magnitude = Array.isArray(channel) ? Number(channel[0]) : 0;
    if (Number.isFinite(magnitude) && magnitude > max) max = magnitude;
  }
  return dbToLevel(mulToDb(max));
}

/** Згладжванне: хутка ўзрастае на ўдары, павольна спадае. */
export function smoothLevel(prev: number, target: number, dtMs: number, attackMs = 40, releaseMs = 320): number {
  const tau = target > prev ? attackMs : releaseMs;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
  return prev + (target - prev) * k;
}

/** Штучны «гук» для праверкі без OBS: удары кожныя ~0,5 с з затуханнем і лёгкім шумам. */
export function simulatedLevel(timeMs: number): number {
  const beat = (timeMs % 500) / 500;
  const pulse = Math.exp(-beat * 5);
  const wobble = 0.15 * Math.sin(timeMs / 170) + 0.1 * Math.sin(timeMs / 53);
  return Math.min(1, Math.max(0, 0.3 + 0.55 * pulse + wobble));
}
