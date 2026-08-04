import {Img, staticFile} from 'remotion';
import {colors, shadows} from '../theme';

export const KeyboardCard: React.FC<{
  src: string;
  width?: number;
  rotate?: number;
}> = ({src, width = 860, rotate = 0}) => (
  <div
    style={{
      width,
      padding: 10,
      borderRadius: 34,
      background: 'linear-gradient(145deg, #444248, #1F1F23)',
      boxShadow: shadows.card,
      border: `1px solid ${colors.line}`,
      rotate: `${rotate}deg`,
      overflow: 'hidden',
    }}
  >
    <Img
      src={staticFile(src)}
      style={{width: '100%', display: 'block', borderRadius: 25}}
    />
  </div>
);
