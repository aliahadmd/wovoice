import {Img, staticFile} from 'remotion';
import {colors, shadows} from '../theme';

/** A desktop screenshot (Mac app or admin console) in a rounded, shadowed frame. */
export const ScreenFrame: React.FC<{
  src: string;
  width: number;
  aspect: number;
  style?: React.CSSProperties;
}> = ({src, width, aspect, style}) => (
  <div
    style={{
      width,
      height: Math.round(width / aspect),
      borderRadius: 18,
      overflow: 'hidden',
      border: `1px solid ${colors.line}`,
      backgroundColor: '#141418',
      boxShadow: `${shadows.card}, 0 0 0 10px rgba(255,255,255,.03)`,
      ...style,
    }}
  >
    <Img
      src={staticFile(src)}
      style={{width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top'}}
    />
  </div>
);
