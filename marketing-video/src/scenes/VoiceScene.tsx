import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {Backdrop} from '../components/Backdrop';
import {KeyboardCard} from '../components/KeyboardCard';
import {PhoneFrame} from '../components/PhoneFrame';
import {Pill} from '../components/Pill';
import {colors} from '../theme';

export const VoiceScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{color: colors.white}}>
      <Backdrop accent="purple" />
      <div style={{position: 'absolute', left: 105, top: 90, width: 690}}>
        <div
          style={{
            color: colors.mint,
            fontSize: 25,
            fontWeight: 750,
            letterSpacing: 4,
            opacity: interpolate(frame, [0, 12], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          SPEECH-FIRST INPUT
        </div>
        <div
          style={{
            marginTop: 20,
            fontSize: 92,
            lineHeight: 0.98,
            fontWeight: 790,
            letterSpacing: -5,
            opacity: interpolate(frame, [5, 24], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            translate: `${interpolate(frame, [5, 24], [-28, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            })}px 0`,
          }}
        >
          Tap.<br />Speak.<br /><span style={{color: colors.mint}}>Done.</span>
        </div>
        <div
          style={{
            marginTop: 32,
            fontSize: 34,
            lineHeight: 1.35,
            color: colors.muted,
            opacity: interpolate(frame, [20, 38], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          One tap starts recording.<br />A second tap finishes the thought.
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          right: 90,
          top: 210,
          opacity: interpolate(frame, [10, 25, 92, 112], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          translate: `${interpolate(frame, [10, 28], [90, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px 0`,
        }}
      >
        <KeyboardCard src="assets/keyboard-voice-idle.png" width={930} rotate={-1.5} />
        <div
          style={{
            position: 'absolute',
            left: 350,
            top: 270,
            width: 160,
            height: 160,
            borderRadius: 999,
            border: `4px solid ${colors.mint}`,
            opacity: interpolate(frame, [35, 55, 75, 90], [0, 1, 1, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            scale: interpolate(frame % 30, [0, 29], [0.82, 1.3], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            boxShadow: '0 0 50px rgba(125,228,182,.45)',
          }}
        />
      </div>

      <div
        style={{
          position: 'absolute',
          right: 160,
          top: 92,
          opacity: interpolate(frame, [96, 116], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          translate: `${interpolate(frame, [96, 116], [100, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px 0`,
          scale: interpolate(frame, [96, 118], [0.92, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            output: 'perceptual-scale',
          }),
        }}
      >
        <PhoneFrame src="assets/keyboard-recording.png" width={390} rotate={2.5} />
      </div>

      <div
        style={{
          position: 'absolute',
          left: 105,
          bottom: 92,
          display: 'flex',
          gap: 15,
          opacity: interpolate(frame, [108, 126], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        <Pill mint>LIVE WAVEFORM</Pill>
        <Pill>CANCEL ANYTIME</Pill>
        <Pill>60 SEC MAX</Pill>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 600,
          bottom: 205,
          width: 770,
          borderRadius: 28,
          padding: '28px 34px',
          background: 'rgba(35,35,40,.96)',
          border: `1px solid ${colors.line}`,
          boxShadow: '0 24px 70px rgba(0,0,0,.38)',
          opacity: interpolate(frame, [142, 160], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          translate: `0 ${interpolate(frame, [142, 160], [45, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px`,
        }}
      >
        <div style={{fontSize: 22, color: colors.mint, letterSpacing: 3, fontWeight: 700}}>INSERTED</div>
        <div style={{fontSize: 43, marginTop: 10, fontWeight: 590}}>Can we meet tomorrow at 9:30?</div>
      </div>
    </AbsoluteFill>
  );
};
