import {interpolate, useCurrentFrame} from 'remotion';
import {colors} from '../theme';

export const Waveform: React.FC<{size?: number}> = ({size = 170}) => {
  const frame = useCurrentFrame();
  const heights = [0.45, 0.72, 1, 0.64, 0.4];

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: colors.mint,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: size * 0.04,
      }}
    >
      {heights.map((height, index) => (
        <div
          key={index}
          style={{
            width: size * 0.075,
            height:
              size *
              height *
              interpolate(Math.sin((frame + index * 4) / 5), [-1, 1], [0.62, 1]),
            maxHeight: size * 0.62,
            minHeight: size * 0.18,
            borderRadius: 999,
            backgroundColor: '#1C1E1F',
          }}
        />
      ))}
    </div>
  );
};
