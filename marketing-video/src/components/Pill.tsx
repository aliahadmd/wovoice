import {colors} from '../theme';

export const Pill: React.FC<{children: React.ReactNode; mint?: boolean}> = ({
  children,
  mint = false,
}) => (
  <div
    style={{
      padding: '14px 24px',
      borderRadius: 999,
      backgroundColor: mint ? colors.mint : 'rgba(255,255,255,0.07)',
      color: mint ? '#17231D' : colors.white,
      border: mint ? 'none' : `1px solid ${colors.line}`,
      fontSize: 28,
      fontWeight: 650,
      letterSpacing: -0.5,
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </div>
);
