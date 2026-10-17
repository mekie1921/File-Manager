import * as IntentLauncher from 'expo-intent-launcher';
import { openWithCompatibleApp } from './fileManagerOperations.js';

export function openAndroidFile(contentUri, mimeType) {
  return openWithCompatibleApp(
    contentUri,
    mimeType,
    IntentLauncher.startActivityAsync
  );
}
