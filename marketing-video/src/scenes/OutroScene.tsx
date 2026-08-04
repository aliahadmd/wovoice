import {AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {Backdrop} from '../components/Backdrop';
import {Pill} from '../components/Pill';
import {colors} from '../theme';

export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{color: colors.white}}>
      <Backdrop />
      <AbsoluteFill
        style={{
          padding: '90px 110px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          textAlign: 'center',
        }}
      >
        <Img
          src={staticFile('assets/wovoice-logo.svg')}
          style={{
            width: 176,
            height: 176,
            opacity: interpolate(frame, [0, 18], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            scale: interpolate(frame, [0, 22], [0.7, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.spring({damping: 170}),
              output: 'perceptual-scale',
            }),
          }}
        />
        <div
          style={{
            fontSize: 126,
            fontWeight: 820,
            letterSpacing: -7,
            marginTop: 28,
            opacity: interpolate(frame, [10, 30], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          Wo<span style={{color: colors.mint}}>Voice</span>
        </div>
        <div
          style={{
            fontSize: 45,
            color: colors.muted,
            marginTop: 16,
            opacity: interpolate(frame, [24, 42], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          A private AI speech keyboard, built end to end.
        </div>
        <div
          style={{
            display: 'flex',
            gap: 18,
            marginTop: 52,
            opacity: interpolate(frame, [38, 58], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          <Pill>ANDROID IME</Pill>
          <Pill>KOTLIN</Pill>
          <Pill>CLOUDFLARE WORKERS AI</Pill>
          <Pill mint>PRIVACY-FIRST</Pill>
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 58,
            fontSize: 27,
            color: 'rgba(255,255,255,.58)',
            letterSpacing: 5,
            fontWeight: 600,
            opacity: interpolate(frame, [62, 82], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          DESIGNED · ENGINEERED · DEPLOYED
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
