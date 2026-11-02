import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {Backdrop} from '../components/Backdrop';
import {ScreenFrame} from '../components/ScreenFrame';
import {colors} from '../theme';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const ADMIN_ASPECT = 1530 / 1218;

const Row: React.FC<{text: string; never?: boolean; delay: number}> = ({text, never = false, delay}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        fontSize: 28,
        color: never ? colors.white : colors.muted,
        opacity: interpolate(frame, [delay, delay + 12], [0, 1], clamp),
        translate: `${interpolate(frame, [delay, delay + 14], [-24, 0], {...clamp, easing: easeOut})}px 0`,
      }}
    >
      <span style={{color: never ? colors.mint : colors.purple, fontSize: 24, width: 24, textAlign: 'center'}}>
        {never ? '⊘' : '●'}
      </span>
      {text}
    </div>
  );
};

/** One admin screenshot that slides into the fan from the right. */
const Card: React.FC<{src: string; delay: number; x: number; y: number; rotate: number; width: number}> = ({
  src,
  delay,
  x,
  y,
  rotate,
  width,
}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [delay, delay + 22], [0, 1], {...clamp, easing: easeOut});
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity: enter,
        translate: `${(1 - enter) * 160}px ${(1 - enter) * 30}px`,
        rotate: `${rotate * enter}deg`,
      }}
    >
      <ScreenFrame src={src} width={width} aspect={ADMIN_ASPECT} />
    </div>
  );
};

export const AdminScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{color: colors.white}}>
      <Backdrop />
      <div style={{position: 'absolute', left: 105, top: 92, width: 720}}>
        <div style={{color: colors.mint, fontSize: 25, fontWeight: 750, letterSpacing: 4, opacity: interpolate(frame, [0, 12], [0, 1], clamp)}}>
          TRANSPARENT BY DESIGN
        </div>
        <div
          style={{
            marginTop: 20,
            fontSize: 76,
            lineHeight: 1.04,
            fontWeight: 790,
            letterSpacing: -4,
            opacity: interpolate(frame, [6, 24], [0, 1], clamp),
            translate: `${interpolate(frame, [6, 26], [-28, 0], {...clamp, easing: easeOut})}px 0`,
          }}
        >
          A real admin console.<br /><span style={{color: colors.mint}}>Never your words.</span>
        </div>
        <div style={{marginTop: 46, fontSize: 22, letterSpacing: 3, fontWeight: 700, color: colors.purple, opacity: interpolate(frame, [26, 36], [0, 1], clamp)}}>
          THE CONSOLE SHOWS
        </div>
        <div style={{display: 'grid', gap: 12, marginTop: 16}}>
          <Row text="Usage, quotas, and service health" delay={30} />
          <Row text="Account status and signed-in devices" delay={36} />
          <Row text="An audit log of every admin action" delay={42} />
        </div>
        <div style={{marginTop: 34, fontSize: 22, letterSpacing: 3, fontWeight: 700, color: colors.mint, opacity: interpolate(frame, [54, 64], [0, 1], clamp)}}>
          IT NEVER SHOWS
        </div>
        <div style={{display: 'grid', gap: 12, marginTop: 16}}>
          <Row text="Voice recordings" never delay={58} />
          <Row text="Dictated text or History contents" never delay={64} />
          <Row text="Dictionary words" never delay={70} />
        </div>
      </div>

      <Card src="assets/admin-audit.png" delay={12} x={1030} y={120} rotate={5} width={700} />
      <Card src="assets/admin-user.png" delay={26} x={960} y={250} rotate={-2} width={740} />
      <Card src="assets/admin-overview.png" delay={40} x={880} y={370} rotate={-5.5} width={780} />
    </AbsoluteFill>
  );
};
