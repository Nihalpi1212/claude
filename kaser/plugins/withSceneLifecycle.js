/**
 * iOS 27 aborts at launch unless the app adopts the UIScene life cycle
 * ("NoSceneLifecycleAdoption"). Expo ships ExpoAppSceneDelegate for this, but the
 * bare template's AppDelegate still creates its own window. This plugin:
 *   1. declares UIApplicationSceneManifest pointing at EXExpoAppSceneDelegate
 *   2. makes AppDelegate conform to ExpoReactNativeFactoryProvider and stops it
 *      creating the window / starting React Native itself (the scene delegate does).
 * Idempotent; becomes a no-op once the Expo template does this natively.
 */
const { withInfoPlist, withAppDelegate } = require('expo/config-plugins');

const withSceneLifecycle = (config) => {
  config = withInfoPlist(config, (c) => {
    if (!c.modResults.UIApplicationSceneManifest) {
      c.modResults.UIApplicationSceneManifest = {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'Default Configuration',
              UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
            },
          ],
        },
      };
    }
    return c;
  });

  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== 'swift') return c;
    let src = c.modResults.contents;
    if (src.includes('ExpoReactNativeFactoryProvider')) return c; // already adopted

    src = src.replace(
      /class AppDelegate: ExpoAppDelegate \{/,
      'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {'
    );
    // drop the manual window + startReactNative block; the scene delegate owns it now
    src = src.replace(
      /#if os\(iOS\) \|\| os\(tvOS\)\s*\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*\n\s*factory\.startReactNative\([\s\S]*?launchOptions: launchOptions\)\s*\n#endif\s*\n/,
      ''
    );
    c.modResults.contents = src;
    return c;
  });

  return config;
};

module.exports = withSceneLifecycle;
