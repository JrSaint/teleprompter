import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.santosministries.voiceprompter',
  appName: 'Voice Prompter',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    backgroundColor: '#000000',
  },
};

export default config;
