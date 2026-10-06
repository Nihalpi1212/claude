import { FadeInUp } from 'react-native-reanimated';

/** Brand motion: entrance 180–260 ms, fade and rise. */
export const rise = (delay = 0) => FadeInUp.duration(240).delay(delay);

/** Tap feedback 100–160 ms. */
export const TAP_IN = 100;
export const TAP_OUT = 140;
