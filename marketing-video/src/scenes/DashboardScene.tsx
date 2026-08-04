import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {Backdrop} from '../components/Backdrop';
import {PhoneFrame} from '../components/PhoneFrame';
import {colors} from '../theme';

const Feature: React.FC<{title: string; detail: string; delay: number}> = ({
  title,
  detail,
  delay,
}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '58px 1fr',
        gap: 22,
        alignItems: 'center',
        opacity: interpolate(frame, [delay, delay + 16], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        }),
        translate: `${interpolate(frame, [delay, delay + 16], [36, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        })}px 0`,
      }}
    >
      <div
        style={{
          width: 54,
          height: 54,
          borderRadius: 18,
          backgroundColor: colors.mint,
          color: '#183025',
          fontSize: 34,
          fontWeight: 800,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ✓
      </div>
      <div>
        <div style={{fontSize: 35, fontWeight: 700}}>{title}</div>
        <div style={{fontSize: 25, color: colors.muted, marginTop: 4}}>{detail}</div>
      </div>
    </div>
  );
};

export const DashboardScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{color: colors.white}}>
      <Backdrop />
      <div
        style={{
          position: 'absolute',
          left: 110,
          top: 88,
          opacity: interpolate(frame, [0, 22], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          translate: `${interpolate(frame, [0, 25], [-70, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px 0`,
        }}
      >
        <PhoneFrame src="assets/wovoice-home.png" width={420} rotate={-2.5} />
      </div>
      <div
        style={{
          position: 'absolute',
          left: 485,
          top: 155,
          opacity: interpolate(frame, [55, 78], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          translate: `${interpolate(frame, [55, 78], [-80, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px 0`,
        }}
      >
        <PhoneFrame src="assets/wovoice-dictionary.png" width={360} rotate={3.5} />
      </div>

      <div style={{position: 'absolute', left: 930, top: 100, right: 100}}>
        <div
          style={{
            color: colors.mint,
            fontSize: 25,
            fontWeight: 750,
            letterSpacing: 4,
            opacity: interpolate(frame, [5, 20], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          PRIVATE VOICE WORKSPACE
        </div>
        <div
          style={{
            marginTop: 20,
            fontSize: 76,
            lineHeight: 1.04,
            fontWeight: 790,
            letterSpacing: -4,
            opacity: interpolate(frame, [12, 30], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          Useful insights.<br />Your data stays yours.
        </div>
        <div style={{display: 'grid', gap: 28, marginTop: 56}}>
          <Feature title="Local History" detail="Search, copy, detail and delete" delay={34} />
          <Feature title="Personal Dictionary" detail="Names and terms you approve" delay={47} />
          <Feature title="Private Analytics" detail="Words, WPM and processing speed" delay={60} />
          <Feature title="Estimated AI Usage" detail="Transparent estimates, never an invoice" delay={73} />
        </div>
        <div
          style={{
            marginTop: 48,
            display: 'inline-flex',
            padding: '16px 24px',
            borderRadius: 18,
            background: 'rgba(125,228,182,.11)',
            border: '1px solid rgba(125,228,182,.35)',
            color: colors.mint,
            fontSize: 25,
            fontWeight: 650,
            opacity: interpolate(frame, [92, 110], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          No ads · No tracking · No server-side transcript history
        </div>
      </div>
    </AbsoluteFill>
  );
};
