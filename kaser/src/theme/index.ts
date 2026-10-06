import { useColorScheme } from 'react-native';

export const brand = {
  maroon: '#8A1538', // Qatar maroon — the Kaser signature colour
  maroonDeep: '#5C0D26',
  maroonLight: '#B02350',
  gold: '#E4B25A',
  goldDeep: '#C9922E',
};

const light = {
  isDark: false,
  bg: '#F4F4F6',
  card: '#FFFFFF',
  cardAlt: '#F9F9FB',
  text: '#1B1B1F',
  textSecondary: '#6B6B76',
  textTertiary: '#A1A1AB',
  separator: 'rgba(60,60,67,0.14)',
  fill: 'rgba(120,120,128,0.12)',
  primary: brand.maroon,
  primaryTint: '#F8E7ED',
  onPrimary: '#FFFFFF',
  success: '#1FA463',
  successTint: '#E3F6EC',
  warning: '#F2A100',
  danger: '#E5484D',
  star: '#F5A623',
  blurTint: 'systemChromeMaterialLight' as const,
  shadow: '#1B1B1F',
};

const dark: typeof light = {
  isDark: true,
  bg: '#000000',
  card: '#1C1C1F',
  cardAlt: '#252528',
  text: '#F5F5F7',
  textSecondary: '#A0A0AB',
  textTertiary: '#6C6C76',
  separator: 'rgba(235,235,245,0.16)',
  fill: 'rgba(120,120,128,0.32)',
  primary: '#D6345F',
  primaryTint: '#3A1421',
  onPrimary: '#FFFFFF',
  success: '#34C27A',
  successTint: '#12301F',
  warning: '#FFB020',
  danger: '#FF6369',
  star: '#F5A623',
  blurTint: 'systemChromeMaterialDark' as any,
  shadow: '#000000',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const radius = { sm: 10, md: 16, lg: 22, xl: 28, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 };

export const type = {
  largeTitle: { fontSize: 34, fontWeight: '800' as const, letterSpacing: 0.3 },
  title1: { fontSize: 28, fontWeight: '700' as const, letterSpacing: 0.3 },
  title2: { fontSize: 22, fontWeight: '700' as const },
  title3: { fontSize: 20, fontWeight: '600' as const },
  headline: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 17, fontWeight: '400' as const },
  callout: { fontSize: 16, fontWeight: '400' as const },
  subhead: { fontSize: 15, fontWeight: '400' as const },
  footnote: { fontSize: 13, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '500' as const },
};

export const shadow = (t: Theme, level: 1 | 2 | 3 = 1) => ({
  shadowColor: t.shadow,
  shadowOpacity: t.isDark ? 0 : [0.06, 0.1, 0.16][level - 1],
  shadowRadius: [8, 16, 28][level - 1],
  shadowOffset: { width: 0, height: [2, 6, 12][level - 1] },
  elevation: [2, 5, 10][level - 1],
});
