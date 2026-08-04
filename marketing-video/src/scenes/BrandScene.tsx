import {AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Backdrop} from '../components/Backdrop';
import {Pill} from '../components/Pill';
import {colors, shadows} from '../theme';

export const BrandScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <AbsoluteFill style={{color: colors.white}}>
      <Backdrop />
      <AbsoluteFill
        style={{
          padding: '100px 120px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
        }}
      >
        <Img
          src={staticFile('assets/wovoice-logo.svg')}
          style={{
            width: 190,
            height: 190,
            marginBottom: 34,
            opacity: interpolate(frame, [0, 14], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            scale: interpolate(frame, [0, 18], [0.68, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.spring({damping: 180}),
              output: 'perceptual-scale',
            }),
            filter: 'drop-shadow(0 22px 42px rgba(125,228,182,.22))',
          }}
        />
        <div
          style={{
            fontSize: 132,
            lineHeight: 1,
            fontWeight: 800,
            letterSpacing: -7,
            opacity: interpolate(frame, [9, 25], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            translate: `0 ${interpolate(frame, [9, 25], [28, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            })}px`,
          }}
        >
          Wo<span style={{color: colors.mint}}>Voice</span>
        </div>
        <div
          style={{
            marginTop: 28,
            fontSize: 49,
            color: colors.muted,
            fontWeight: 500,
            letterSpacing: -1.7,
            opacity: interpolate(frame, [20, 38], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          Speak naturally. Get polished text.
        </div>
        <div
          style={{
            display: 'flex',
            gap: 18,
            marginTop: 52,
            opacity: interpolate(frame, [35, 55], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            translate: `0 ${interpolate(frame, [35, 55], [18, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })}px`,
            filter: shadows.mint,
          }}
        >
          <Pill mint>ACCURATE</Pill>
          <Pill>PRIVATE</Pill>
          <Pill>ANDROID</Pill>
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 70,
            fontSize: 24,
            letterSpacing: 4,
            color: 'rgba(255,255,255,.45)',
            opacity: interpolate(frame, [2 * fps, 2.6 * fps], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          AI SPEECH KEYBOARD
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
