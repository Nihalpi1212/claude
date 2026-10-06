import { useColorScheme } from 'react-native';

/** Kaser Brand Book v1.0 (Sept 2026) */
export const brand = {
  orange: '#FD8912', // Kaser Orange — primary
  ink: '#201B17', // Ink — text on orange, dark surfaces
  cream: '#FFF8EE', // Cream — app background
  green: '#276B54', // Fresh Green — verified / success
  warmGray: '#6F6861', // secondary text
  error: '#BC453D',
  white: '#FFFFFF',
};

const light = {
  isDark: false,
  bg: brand.cream,
  card: brand.white,
  cardAlt: '#FFF1DD',
  text: brand.ink,
  textSecondary: brand.warmGray,
  textTertiary: '#A59D95',
  separator: 'rgba(32,27,23,0.10)',
  fill: 'rgba(32,27,23,0.06)',
  primary: brand.orange,
  /** darker orange for small orange text/icons on light surfaces (AA contrast) */
  primaryText: '#B35A00',
  primaryTint: '#FFE9CF',
  onPrimary: brand.ink, // brand rule: ink text on orange, never small white
  success: brand.green,
  successTint: '#DCEEE6',
  warning: '#9A6200',
  warningTint: '#FFEFC8',
  danger: brand.error,
  star: brand.orange,
  tile: '#FFE6C7', // food-art tile background
  shadow: brand.ink,
};

const dark: typeof light = {
  isDark: true,
  bg: '#14100E',
  card: brand.ink,
  cardAlt: '#2B2420',
  text: brand.cream,
  textSecondary: '#B8AFA6',
  textTertiary: '#7E766E',
  separator: 'rgba(255,248,238,0.14)',
  fill: 'rgba(255,248,238,0.10)',
  primary: brand.orange,
  primaryText: '#FFA64A',
  primaryTint: '#3B2614',
  onPrimary: brand.ink,
  success: '#4DAE8A',
  successTint: '#14302A',
  warning: '#FFC24D',
  warningTint: '#3A2C0C',
  danger: '#E8766E',
  star: brand.orange,
  tile: '#3A2A1A',
  shadow: '#000000',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

// brand: cards 16, buttons 12, pills 999; digital corners 12–20
export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };
// 8px base
export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };

export const type = {
  largeTitle: { fontSize: 34, fontWeight: '800' as const, letterSpacing: 0.2 },
  title1: { fontSize: 28, fontWeight: '800' as const, letterSpacing: 0.2 },
  title2: { fontSize: 22, fontWeight: '700' as const },
  title3: { fontSize: 20, fontWeight: '700' as const },
  headline: { fontSize: 17, fontWeight: '700' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  callout: { fontSize: 16, fontWeight: '400' as const },
  subhead: { fontSize: 15, fontWeight: '400' as const },
  footnote: { fontSize: 13, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '600' as const },
};

// brand: flat, uncluttered — soft shadows only
export const shadow = (t: Theme, level: 1 | 2 | 3 = 1) => ({
  shadowColor: t.shadow,
  shadowOpacity: t.isDark ? 0 : [0.05, 0.08, 0.12][level - 1],
  shadowRadius: [6, 12, 20][level - 1],
  shadowOffset: { width: 0, height: [2, 4, 8][level - 1] },
  elevation: [1, 3, 6][level - 1],
});
