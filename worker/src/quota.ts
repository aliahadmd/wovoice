import { ApiError } from "./errors";
import type { AppEnv } from "./types";

const WHISPER_NEURONS_PER_MINUTE = 46.63;
const NOVA_NEURONS_PER_MINUTE = 472.73;
const POLISH_RESERVE_NEURONS = 5;
const RESERVATION_LIFETIME_MS = 2 * 60_000;

export interface QuotaReservation {
  id: string;
  dateKey: string;
  audioSeconds: number;
  reservedNeurons: number;
}

export async function reserveQuota(
  env: AppEnv,
  userId: string,
  requestId: string,
  audioSeconds: number,
): Promise<QuotaReservation> {
  const now = Date.now();
  const dateKey = new Date(now).toISOString().slice(0, 10);
  const asrRate = env.ASR_MODEL === "nova-3" ? NOVA_NEURONS_PER_MINUTE : WHISPER_NEURONS_PER_MINUTE;
  const reservedNeurons = audioSeconds / 60 * asrRate + POLISH_RESERVE_NEURONS;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO daily_usage
          (user_id, date_key, used_audio_seconds, reserved_audio_seconds, used_neurons, reserved_neurons, request_count)
         VALUES(?, ?, 0, 0, 0, 0, 0)`,
      ).bind(userId, dateKey),
      env.DB.prepare(
        "INSERT OR IGNORE INTO global_daily_usage(date_key, used_neurons, reserved_neurons) VALUES(?, 0, 0)",
      ).bind(dateKey),
      env.DB.prepare(
        `UPDATE daily_usage SET reserved_audio_seconds = reserved_audio_seconds + ?,
          reserved_neurons = reserved_neurons + ?, request_count = request_count + 1
         WHERE user_id = ? AND date_key = ?`,
      ).bind(audioSeconds, reservedNeurons, userId, dateKey),
      env.DB.prepare(
        "UPDATE global_daily_usage SET reserved_neurons = reserved_neurons + ? WHERE date_key = ?",
      ).bind(reservedNeurons, dateKey),
      env.DB.prepare(
        `INSERT INTO quota_reservations
          (id, user_id, date_key, audio_seconds, reserved_neurons, created_at, expires_at, status)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'reserved')`,
      ).bind(requestId, userId, dateKey, audioSeconds, reservedNeurons, now, now + RESERVATION_LIFETIME_MS),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const retryAfter = secondsUntilUtcReset(now);
    if (message.includes("USER_QUOTA_EXCEEDED")) {
      throw new ApiError(429, "USER_QUOTA_EXCEEDED", false, "Your free dictation time is used for today.", retryAfter);
    }
    if (message.includes("SERVICE_DAILY_LIMIT_REACHED")) {
      throw new ApiError(503, "SERVICE_DAILY_LIMIT_REACHED", true, "WoVoice has reached today's free service limit.", retryAfter);
    }
    throw error;
  }
  return { id: requestId, dateKey, audioSeconds, reservedNeurons };
}

export async function completeQuota(
  env: AppEnv,
  reservation: QuotaReservation,
  actualNeurons: number,
): Promise<void> {
  const completedNeurons = Math.max(0, Math.min(actualNeurons, reservation.reservedNeurons));
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE daily_usage SET
         reserved_audio_seconds = MAX(0, reserved_audio_seconds - ?),
         reserved_neurons = MAX(0, reserved_neurons - ?),
         used_audio_seconds = used_audio_seconds + ?,
         used_neurons = used_neurons + ?
       WHERE user_id = (SELECT user_id FROM quota_reservations WHERE id = ?)
         AND date_key = ?
         AND EXISTS (SELECT 1 FROM quota_reservations WHERE id = ? AND status = 'reserved')`,
    ).bind(
      reservation.audioSeconds,
      reservation.reservedNeurons,
      reservation.audioSeconds,
      completedNeurons,
      reservation.id,
      reservation.dateKey,
      reservation.id,
    ),
    env.DB.prepare(
      `UPDATE global_daily_usage SET
         reserved_neurons = MAX(0, reserved_neurons - ?),
         used_neurons = used_neurons + ?
       WHERE date_key = ?
         AND EXISTS (SELECT 1 FROM quota_reservations WHERE id = ? AND status = 'reserved')`,
    ).bind(reservation.reservedNeurons, completedNeurons, reservation.dateKey, reservation.id),
    env.DB.prepare("UPDATE quota_reservations SET status = 'completed' WHERE id = ? AND status = 'reserved'")
      .bind(reservation.id),
  ]);
}

export async function releaseQuota(env: AppEnv, reservation: QuotaReservation): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE daily_usage SET
         reserved_audio_seconds = MAX(0, reserved_audio_seconds - ?),
         reserved_neurons = MAX(0, reserved_neurons - ?)
       WHERE user_id = (SELECT user_id FROM quota_reservations WHERE id = ?)
         AND date_key = ?
         AND EXISTS (SELECT 1 FROM quota_reservations WHERE id = ? AND status = 'reserved')`,
    ).bind(reservation.audioSeconds, reservation.reservedNeurons, reservation.id, reservation.dateKey, reservation.id),
    env.DB.prepare(
      `UPDATE global_daily_usage SET reserved_neurons = MAX(0, reserved_neurons - ?)
       WHERE date_key = ?
         AND EXISTS (SELECT 1 FROM quota_reservations WHERE id = ? AND status = 'reserved')`,
    ).bind(reservation.reservedNeurons, reservation.dateKey, reservation.id),
    env.DB.prepare("UPDATE quota_reservations SET status = 'released' WHERE id = ? AND status = 'reserved'")
      .bind(reservation.id),
  ]);
}

export async function releaseExpiredReservations(env: AppEnv): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, date_key AS dateKey, audio_seconds AS audioSeconds, reserved_neurons AS reservedNeurons
     FROM quota_reservations WHERE status = 'reserved' AND expires_at < ? LIMIT 100`,
  ).bind(Date.now()).all<QuotaReservation>();
  for (const reservation of rows.results) await releaseQuota(env, reservation);
  return rows.results.length;
}

function secondsUntilUtcReset(now: number): number {
  const tomorrow = Date.parse(`${new Date(now + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Math.max(1, Math.ceil((tomorrow - now) / 1_000));
}
