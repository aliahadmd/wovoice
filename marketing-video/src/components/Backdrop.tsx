import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {colors} from '../theme';

export const Backdrop: React.FC<{accent?: 'mint' | 'purple'}> = ({
  accent = 'mint',
}) => {
  const frame = useCurrentFrame();
  const glow = accent === 'mint' ? '125, 228, 182' : '168, 151, 255';

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg,
        backgroundImage: `radial-gradient(circle at 78% 30%, rgba(${glow}, 0.14), transparent 34%), radial-gradient(circle at 15% 85%, rgba(91, 72, 146, 0.15), transparent 36%)`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: 620,
          height: 620,
          borderRadius: 999,
          border: `1px solid rgba(${glow}, 0.12)`,
          right: -180,
          top: -210,
          scale: interpolate(frame, [0, 120], [0.92, 1.08], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.22,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          translate: `${interpolate(frame, [0, 150], [0, -18], {extrapolateRight: 'clamp'})}px ${interpolate(frame, [0, 150], [0, -10], {extrapolateRight: 'clamp'})}px`,
        }}
      />
    </AbsoluteFill>
  );
};
