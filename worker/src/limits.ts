// Free-service ceilings. The D1 triggers created by migrations 0001, 0003, and 0005
// enforce the audio, global-neuron, and monthly-email limits inside the database
// (raise a limit via a new migration editing the trigger SQL, never only here).
export const BASE_DAILY_AUDIO_SECONDS = 600;
export const GLOBAL_DAILY_NEURON_LIMIT = 8_000;
export const MONTHLY_EMAIL_LIMIT = 2_500;
