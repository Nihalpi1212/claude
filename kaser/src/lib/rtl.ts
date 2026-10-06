import { DevSettings, I18nManager, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import type { Lang } from '@/i18n';

/** Make the native layout direction match the chosen language. Reloads the app if it must change. */
export async function applyDirection(lang: Lang) {
  const rtl = lang === 'ar';
  if (Platform.OS === 'web' || Boolean(I18nManager.isRTL) === rtl) return;
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  try {
    await Updates.reloadAsync();
  } catch {
    DevSettings.reload();
  }
}
