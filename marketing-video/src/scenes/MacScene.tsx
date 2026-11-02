import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {Backdrop} from '../components/Backdrop';
import {ScreenFrame} from '../components/ScreenFrame';
import {colors, shadows} from '../theme';

// Timeline (30 fps): key held 26→112, bubble listens until 112, transcribes until
// 128, text types in 128→160, then the Mac History window slides over at 150.
const KEY_DOWN = 26;
const KEY_UP = 112;
const INSERTED = 128;
const HISTORY_IN = 150;
const DICTATED = "Hi team, the launch moves to Friday at 10:30. I'll share the final build tonight.";

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

const OptionKey: React.FC = () => {
  const frame = useCurrentFrame();
  const pressed = interpolate(frame, [KEY_DOWN, KEY_DOWN + 5, KEY_UP, KEY_UP + 5], [0, 1, 1, 0], clamp);
  return (
    <div style={{display: 'flex', alignItems: 'center', gap: 28, marginTop: 54}}>
      <div
        style={{
          width: 148,
          height: 132,
          borderRadius: 26,
          border: `2px solid ${pressed > 0.5 ? colors.mint : '#55525d'}`,
          borderBottomWidth: 10 - pressed * 7,
          background: 'linear-gradient(180deg, #2b2a31, #1d1c22)',
          translate: `0 ${pressed * 7}px`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          padding: '16px 20px',
          color: pressed > 0.5 ? colors.mint : colors.white,
          boxShadow: pressed > 0.5 ? shadows.mint : 'none',
        }}
      >
        <div style={{fontSize: 46, fontWeight: 700, lineHeight: 1}}>⌥</div>
        <div style={{fontSize: 24, fontWeight: 600}}>option</div>
      </div>
      <div style={{fontSize: 30, color: colors.muted, lineHeight: 1.35}}>
        {frame < KEY_DOWN ? 'Hold the key…' : frame < KEY_UP ? 'Speak while holding…' : 'Release to insert.'}
      </div>
    </div>
  );
};

const RecordingBubble: React.FC = () => {
  const frame = useCurrentFrame();
  const state = frame < KEY_UP ? 'listening' : frame < INSERTED ? 'working' : 'done';
  const accent = state === 'listening' ? '#6fd8ea' : state === 'working' ? colors.purple : colors.mint;
  const appear = interpolate(frame, [KEY_DOWN, KEY_DOWN + 10], [0, 1], {...clamp, easing: easeOut});
  const leave = interpolate(frame, [INSERTED + 26, INSERTED + 38], [1, 0], clamp);
  const seconds = Math.max(0, Math.min(frame, KEY_UP) - KEY_DOWN) / 30;
  return (
    <div
      style={{
        position: 'absolute',
        left: 130,
        top: -128,
        width: 640,
        display: 'flex',
        alignItems: 'center',
        gap: 22,
        padding: '20px 26px',
        borderRadius: 24,
        border: '1px solid #3d3b46',
        background: 'rgba(16,16,20,.94)',
        boxShadow: '0 30px 80px rgba(0,0,0,.6)',
        opacity: appear * leave,
        translate: `0 ${(1 - appear) * -24}px`,
        zIndex: 3,
      }}
    >
      <div style={{width: 16, height: 16, borderRadius: 99, background: state === 'listening' ? '#ff5f57' : accent}} />
      <div style={{display: 'flex', alignItems: 'center', gap: 5, height: 46}}>
        {Array.from({length: 18}, (_, index) => {
          const level = state === 'listening'
            ? interpolate(Math.sin((frame + index * 7) / 3.2) * Math.cos((frame + index * 3) / 7), [-1, 1], [0.2, 1])
            : state === 'working'
              ? interpolate(Math.sin((frame - index * 2) / 3), [-1, 1], [0.2, 0.6])
              : 0.22;
          return <div key={index} style={{width: 5, height: 46 * level, borderRadius: 3, background: accent}} />;
        })}
      </div>
      <div style={{flex: 1}}>
        <div style={{fontSize: 27, fontWeight: 700}}>
          {state === 'listening' ? 'Listening…' : state === 'working' ? 'Transcribing…' : 'Inserted ✓'}
        </div>
        <div style={{fontSize: 21, color: colors.muted}}>
          {state === 'listening' ? 'Release ⌥ to transcribe · esc cancels' : state === 'working' ? 'Whisper + light cleanup' : 'Pasted at your cursor'}
        </div>
      </div>
      <div style={{fontSize: 24, color: colors.muted, fontVariantNumeric: 'tabular-nums'}}>
        0:{Math.floor(seconds).toString().padStart(2, '0')}
      </div>
    </div>
  );
};

const NoteWindow: React.FC = () => {
  const frame = useCurrentFrame();
  const typed = Math.round(interpolate(frame, [INSERTED, INSERTED + 32], [0, DICTATED.length], clamp));
  const caretOn = Math.floor(frame / 15) % 2 === 0;
  return (
    <div
      style={{
        width: 900,
        height: 520,
        borderRadius: 22,
        border: `1px solid ${colors.line}`,
        background: 'linear-gradient(180deg, #222128, #19181d)',
        boxShadow: shadows.card,
        overflow: 'hidden',
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px', borderBottom: `1px solid ${colors.line}`}}>
        {['#ff5f57', '#febc2e', '#28c840'].map((color) => (
          <div key={color} style={{width: 15, height: 15, borderRadius: 99, background: color}} />
        ))}
        <div style={{marginLeft: 14, fontSize: 22, color: colors.muted}}>Notes — Launch plan</div>
      </div>
      <div style={{padding: '34px 40px', fontSize: 40, lineHeight: 1.45, fontWeight: 500}}>
        {DICTATED.slice(0, typed)}
        <span style={{display: 'inline-block', width: 3, height: 44, marginLeft: 2, verticalAlign: -8, background: colors.mint, opacity: caretOn ? 1 : 0}} />
      </div>
    </div>
  );
};

export const MacScene: React.FC = () => {
  const frame = useCurrentFrame();
  const history = interpolate(frame, [HISTORY_IN, HISTORY_IN + 22], [0, 1], {...clamp, easing: easeOut});

  return (
    <AbsoluteFill style={{color: colors.white}}>
      <Backdrop accent="purple" />
      <div style={{position: 'absolute', left: 105, top: 96, width: 640}}>
        <div style={{color: colors.mint, fontSize: 25, fontWeight: 750, letterSpacing: 4, opacity: interpolate(frame, [0, 12], [0, 1], clamp)}}>
          NOW ON MAC
        </div>
        <div
          style={{
            marginTop: 20,
            fontSize: 92,
            lineHeight: 0.98,
            fontWeight: 790,
            letterSpacing: -5,
            opacity: interpolate(frame, [5, 24], [0, 1], clamp),
            translate: `${interpolate(frame, [5, 24], [-28, 0], {...clamp, easing: easeOut})}px 0`,
          }}
        >
          Hold ⌥.<br />Speak.<br /><span style={{color: colors.mint}}>Release.</span>
        </div>
        <div style={{marginTop: 30, fontSize: 33, lineHeight: 1.35, color: colors.muted, opacity: interpolate(frame, [16, 32], [0, 1], clamp)}}>
          Dictate into any app on your Mac.<br />Text lands right at your cursor.
        </div>
        <div style={{opacity: interpolate(frame, [18, 30], [0, 1], clamp)}}>
          <OptionKey />
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 880,
          top: 360,
          opacity: interpolate(frame, [8, 24], [0, 1], clamp) * (1 - history * 0.65),
          translate: `${interpolate(frame, [8, 26], [90, 0], {...clamp, easing: easeOut})}px 0`,
          scale: 1 - history * 0.06,
        }}
      >
        <RecordingBubble />
        <NoteWindow />
      </div>

      <div
        style={{
          position: 'absolute',
          left: 960,
          top: 180,
          opacity: history,
          translate: `0 ${(1 - history) * 140}px`,
          rotate: `${interpolate(history, [0, 1], [4, -1.5])}deg`,
        }}
      >
        <ScreenFrame src="assets/mac-history.png" width={860} aspect={1060 / 760} />
        <div
          style={{
            position: 'absolute',
            left: 24,
            bottom: -76,
            padding: '14px 22px',
            borderRadius: 16,
            background: 'rgba(125,228,182,.12)',
            border: '1px solid rgba(125,228,182,.4)',
            color: colors.mint,
            fontSize: 26,
            fontWeight: 650,
            whiteSpace: 'nowrap',
          }}
        >
          Every dictation is saved to History — synced with your phone
        </div>
      </div>
    </AbsoluteFill>
  );
};
