import {Img, staticFile} from 'remotion';
import {colors, shadows} from '../theme';

export const PhoneFrame: React.FC<{
  src: string;
  width?: number;
  rotate?: number;
}> = ({src, width = 430, rotate = 0}) => {
  const height = Math.round(width * (1600 / 720));

  return (
    <div
      style={{
        width,
        height,
        padding: 13,
        borderRadius: width * 0.11,
        background: 'linear-gradient(145deg, #4D4B53, #1D1D21 55%)',
        boxShadow: shadows.card,
        rotate: `${rotate}deg`,
        border: `1px solid ${colors.line}`,
        overflow: 'hidden',
      }}
    >
      <Img
        src={staticFile(src)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          borderRadius: width * 0.082,
        }}
      />
    </div>
  );
};
