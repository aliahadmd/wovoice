-- The quota ceilings exist to stop usage from growing past a limit. The previous
-- UPDATE triggers re-checked the ceiling on every write, including the ones that
-- complete or release a reservation (which never increase the tracked total).
-- Once an administrator cleared a quota grant, or the grant lapsed, while the
-- day's usage sat above the base limit, those settlement writes aborted forever:
-- the reservation stayed 'reserved' and releaseExpiredReservations threw on it at
-- the start of every scheduled run. Only growth is refused now; the epsilon keeps
-- REAL rounding in the complete step (reserved - x, used + x) from counting as growth.

DROP TRIGGER enforce_user_quota_update;

CREATE TRIGGER enforce_user_quota_update
BEFORE UPDATE ON daily_usage
WHEN NEW.used_audio_seconds + NEW.reserved_audio_seconds
       > OLD.used_audio_seconds + OLD.reserved_audio_seconds + 0.000001
  AND NEW.used_audio_seconds + NEW.reserved_audio_seconds > COALESCE(
    (
      SELECT CASE
        WHEN quota_limit_audio_seconds IS NOT NULL
          AND quota_override_expires_at IS NOT NULL
          AND quota_override_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
        THEN quota_limit_audio_seconds
        ELSE 600
      END
      FROM users WHERE id = NEW.user_id
    ),
    600
  )
BEGIN SELECT RAISE(ABORT, 'USER_QUOTA_EXCEEDED'); END;

DROP TRIGGER enforce_global_quota_update;

CREATE TRIGGER enforce_global_quota_update
BEFORE UPDATE ON global_daily_usage
WHEN NEW.used_neurons + NEW.reserved_neurons > OLD.used_neurons + OLD.reserved_neurons + 0.000001
  AND NEW.used_neurons + NEW.reserved_neurons > 8000
BEGIN SELECT RAISE(ABORT, 'SERVICE_DAILY_LIMIT_REACHED'); END;
