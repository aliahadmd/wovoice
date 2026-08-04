import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {Backdrop} from '../components/Backdrop';
import {Pill} from '../components/Pill';
import {Waveform} from '../components/Waveform';
import {colors, shadows} from '../theme';

export const AccuracyScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{color: colors.white}}>
      <Backdrop />
      <div
        style={{
          position: 'absolute',
          left: 110,
          top: 105,
          display: 'flex',
          alignItems: 'center',
          gap: 38,
          opacity: interpolate(frame, [0, 18], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        <Waveform size={142} />
        <div>
          <div style={{fontSize: 82, fontWeight: 790, letterSpacing: -4, lineHeight: 1.02}}>
            Accuracy that respects
            <br />
            <span style={{color: colors.mint}}>your meaning.</span>
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 110,
          right: 110,
          top: 420,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 26,
        }}
      >
        <div
          style={{
            borderRadius: 34,
            padding: '36px 40px',
            background: 'rgba(255,255,255,.055)',
            border: `1px solid ${colors.line}`,
            opacity: interpolate(frame, [20, 36], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            translate: `${interpolate(frame, [20, 36], [-35, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            })}px 0`,
          }}
        >
          <div style={{fontSize: 23, color: colors.muted, fontWeight: 700, letterSpacing: 3}}>NATURAL SPEECH</div>
          <div style={{fontSize: 44, lineHeight: 1.26, marginTop: 18, color: '#D0CDD6'}}>
            “can we meet tomorrow<br />at nine thirty”
          </div>
        </div>
        <div
          style={{
            borderRadius: 34,
            padding: '36px 40px',
            background: 'linear-gradient(135deg, rgba(125,228,182,.18), rgba(125,228,182,.06))',
            border: '1px solid rgba(125,228,182,.45)',
            boxShadow: shadows.mint,
            opacity: interpolate(frame, [38, 58], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            translate: `${interpolate(frame, [38, 58], [35, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            })}px 0`,
          }}
        >
          <div style={{fontSize: 23, color: colors.mint, fontWeight: 700, letterSpacing: 3}}>READY TO SEND</div>
          <div style={{fontSize: 44, lineHeight: 1.26, marginTop: 18, fontWeight: 620}}>
            Can we meet tomorrow<br />at 9:30?
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 110,
          right: 110,
          bottom: 104,
          display: 'flex',
          justifyContent: 'center',
          gap: 18,
          opacity: interpolate(frame, [66, 86], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          translate: `0 ${interpolate(frame, [66, 86], [28, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })}px`,
        }}
      >
        <Pill>PUNCTUATION</Pill>
        <Pill>NUMBERS</Pill>
        <Pill>NEW PARAGRAPHS</Pill>
        <Pill mint>LIGHT POLISH</Pill>
      </div>
    </AbsoluteFill>
  );
};
