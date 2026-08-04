import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {Backdrop} from '../components/Backdrop';
import {KeyboardCard} from '../components/KeyboardCard';
import {Pill} from '../components/Pill';
import {colors} from '../theme';

export const ManualScene: React.FC = () => {
  const frame = useCurrentFrame();
  const cards = [
    {src: 'assets/keyboard-manual.png', left: 105, top: 430, rotate: -4, delay: 18},
    {src: 'assets/keyboard-numbers.png', left: 535, top: 385, rotate: 1, delay: 31},
    {src: 'assets/keyboard-symbols.png', left: 970, top: 430, rotate: 4, delay: 44},
  ];

  return (
    <AbsoluteFill style={{color: colors.white}}>
      <Backdrop accent="purple" />
      <div style={{position: 'absolute', left: 105, top: 90}}>
        <div
          style={{
            fontSize: 81,
            lineHeight: 1.04,
            fontWeight: 790,
            letterSpacing: -4.5,
            opacity: interpolate(frame, [0, 18], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          Voice when you want it.
          <br />
          <span style={{color: colors.purple}}>A full keyboard when you need it.</span>
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          right: 110,
          top: 135,
          opacity: interpolate(frame, [45, 62], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        <Pill mint>OFFLINE FALLBACK</Pill>
      </div>
      {cards.map((card, index) => (
        <div
          key={card.src}
          style={{
            position: 'absolute',
            left: card.left,
            top: card.top,
            opacity: interpolate(frame, [card.delay, card.delay + 18], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            translate: `0 ${interpolate(frame, [card.delay, card.delay + 22], [150, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.spring({damping: 180}),
            })}px`,
            scale: interpolate(frame, [card.delay, card.delay + 24], [0.86, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              output: 'perceptual-scale',
            }),
            zIndex: index + 1,
          }}
        >
          <KeyboardCard src={card.src} width={760} rotate={card.rotate} />
        </div>
      ))}
      <div
        style={{
          position: 'absolute',
          left: 105,
          bottom: 72,
          display: 'flex',
          gap: 16,
          opacity: interpolate(frame, [68, 88], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        <Pill>SHIFT + CAPS LOCK</Pill>
        <Pill>2 SYMBOL PAGES</Pill>
        <Pill>UNICODE-SAFE DELETE</Pill>
        <Pill>SMART ACTION KEY</Pill>
      </div>
    </AbsoluteFill>
  );
};
