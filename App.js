import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  FlatList,
  Image,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Directory as ExpoDirectory, File as ExpoFile, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import {
  loadTrashEntries,
  moveItemsToTrash,
  moveToTrash,
  permanentlyDelete,
  restoreFromTrash,
} from './localFileOperations';
import {
  copyFileIntoAuthorizedFolder,
  createAuthorizedFolder,
  deleteAuthorizedItem,
  listAuthorizedDirectory,
  parentBreadcrumbs,
} from './authorizedFolderOperations';
import {
  supabase,
  supabaseConfigurationError,
} from './cloud/supabaseClient.js';
import { ensureAnonymousSession } from './cloud/anonymousSession.js';
import {
  createCloudFileService,
  MAX_CLOUD_FILE_SIZE_BYTES,
} from './cloud/cloudFileService.js';
import { shareFilesOneAtATime } from './sharingOperations.js';
import { openAndroidFile } from './androidFileOpening';
import {
  createAppSecurity,
  isValidCredential,
} from './appSecurity';
import {
  CATEGORY_CONFIG,
  collectionCategoryForFile,
  fileCategoryKey,
  fileIconForItem,
} from './fileCategories.js';
import {
  DEFAULT_COLLECTIONS,
  emptyCollectionMetadata,
  normalizeCollectionMetadata,
  removeCollectionAssignments,
  renameCollectionPath,
  setCollectionMembership,
} from './fileCollections.js';
import {
  appDirectoryBreadcrumbs,
  createLocalFolder,
  importLocalFile,
  listLocalFilesRecursively,
  matchesSearch,
  parentDirectoryUri,
  renameLocalItem,
  sortEntries,
  visibleSelectedItems,
} from './fileManagerOperations.js';

const DOCUMENT_ROOT = FileSystem.documentDirectory || FileSystem.cacheDirectory || 'file://app-storage/';
const APP_STORAGE = `${DOCUMENT_ROOT}PocketFiles/`;
const TRASH_ROOT = `${DOCUMENT_ROOT}PocketFilesTrash/`;
const TRASH_INDEX = `${TRASH_ROOT}index.json`;
const COLLECTION_METADATA = `${APP_STORAGE}.pocketfiles-collections.json`;
const AUTHORIZED_FOLDER_RECORD = `${DOCUMENT_ROOT}pocketfiles-authorized-folder.json`;
let shareCacheFileSequence = 0;
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);
const APP_ICON = require('./assets/M App Icon.png');
const SECURITY_CREDENTIAL_OPTIONS = [
  { type: 'password', label: 'Password', details: 'Use a private password with at least 8 characters.' },
  { type: 'pattern', label: 'Pattern', details: 'Connect at least 4 different dots.' },
];

function createShareCacheFile() {
  shareCacheFileSequence += 1;
  return new ExpoFile(
    Paths.cache,
    `pocketfiles-share-${Date.now()}-${shareCacheFileSequence}.tmp`
  );
}

async function readCloudUploadFile(uri) {
  return new ExpoFile(uri).bytes();
}

async function getCloudUploadFileSize(uri) {
  return new ExpoFile(uri).size;
}

async function saveCloudDownload(filename, bytes) {
  const storageInfo = await FileSystem.getInfoAsync(APP_STORAGE);
  if (!storageInfo.exists) {
    await FileSystem.makeDirectoryAsync(APP_STORAGE, { intermediates: true });
  }
  const dotIndex = filename.lastIndexOf('.');
  const baseName = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : '';

  for (let index = 0; index < 1000; index += 1) {
    const candidate =
      index === 0 ? filename : `${baseName} (${index})${extension}`;
    const destination = new ExpoFile(APP_STORAGE, candidate);
    if (destination.exists) continue;

    try {
      destination.create();
    } catch (error) {
      if (destination.exists) continue;
      throw new Error(`Could not create the local download: ${error?.message || 'file creation failed'}`);
    }
    try {
      destination.write(bytes);
      return destination.uri;
    } catch (error) {
      try {
        destination.delete();
      } catch (cleanupError) {
        throw new Error(
          `The cloud download could not be written: ${error?.message || 'write failed'}. The incomplete local file could not be removed: ${cleanupError?.message || 'cleanup failed'}`
        );
      }
      throw new Error(`The cloud download could not be written: ${error?.message || 'write failed'}`);
    }
  }
  throw new Error('Could not find a safe unused filename for this cloud download.');
}

const cloudFileService = supabase
  ? createCloudFileService({
      supabase,
      readLocalFile: readCloudUploadFile,
      getLocalFileSize: getCloudUploadFileSize,
      writeLocalFile: saveCloudDownload,
    })
  : null;

const DEFAULT_THEME = {
  background: '#f2f8f5',
  card: '#ffffff',
  cardAlt: '#e7f1eb',
  border: '#d8e7dd',
  text: '#16352a',
  muted: '#62786d',
  accent: '#16875f',
  accentSoft: '#dff3e8',
  accentStrong: '#076344',
  success: '#138a68',
  danger: '#d84a5b',
  dangerSoft: '#fff0f1',
  surface: '#07543b',
  warm: '#e59c3b',
  sky: '#36a4a0',
};

const DARK_THEME = {
  background: '#0d1c16',
  card: '#172820',
  cardAlt: '#22392e',
  border: '#304c3e',
  text: '#eff8f2',
  muted: '#a1b9aa',
  accent: '#79d5a4',
  accentSoft: '#244834',
  accentStrong: '#b6f0cb',
  success: '#68d6ae',
  danger: '#ff8995',
  dangerSoft: '#492b3a',
  surface: '#10271d',
  warm: '#ffc27a',
  sky: '#78c8ed',
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function getExtension(name = '') {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === name.length - 1) return '';
  return name.slice(dotIndex + 1).toLowerCase();
}

function canPreviewImage(item) {
  return PREVIEWABLE_IMAGE_EXTENSIONS.has(getExtension(item?.name));
}

function normalizePath(path) {
  if (!path) return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function requireImportedFileName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim() === '.' ||
    name.trim() === '..' ||
    /[\/\\\u0000-\u001f]/.test(name)
  ) {
    throw new Error('The selected file has an invalid name.');
  }
  return name.trim();
}

function metadataForItem(item) {
  const extension = getExtension(item.name);
  const type = item.isDirectory ? 'Folder' : extension ? extension.toUpperCase() : 'File';
  return {
    ...item,
    extension,
    type,
  };
}

export default function App() {
  const appSecurity = useMemo(
    () => createAppSecurity({
      platform: Platform.OS,
      secureStore: SecureStore,
      crypto: Crypto,
    }),
    []
  );
  const [darkMode, setDarkMode] = useState(false);
  const [activeTab, setActiveTab] = useState('home');
  const [activeStorage, setActiveStorage] = useState('app');
  const [currentPath, setCurrentPath] = useState(APP_STORAGE);
  const [authorizedFolder, setAuthorizedFolder] = useState(null);
  const [authorizedPathStack, setAuthorizedPathStack] = useState([]);
  const [authorizedFolderError, setAuthorizedFolderError] = useState('');
  const [entries, setEntries] = useState([]);
  const [allLocalFiles, setAllLocalFiles] = useState([]);
  const [collectionMetadata, setCollectionMetadata] = useState(emptyCollectionMetadata);
  const [collectionMetadataError, setCollectionMetadataError] = useState('');
  const [collectionMetadataNotice, setCollectionMetadataNotice] = useState('');
  const [collectionMetadataReady, setCollectionMetadataReady] = useState(false);
  const [collectionCategory, setCollectionCategory] = useState(null);
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [collectionEditorCategory, setCollectionEditorCategory] = useState(null);
  const [collectionSaving, setCollectionSaving] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [imagePreviewError, setImagePreviewError] = useState('');
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState('name');
  const [viewMode, setViewMode] = useState('list');
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectedTrashIds, setSelectedTrashIds] = useState([]);
  const [categoryFilter, setCategoryFilter] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [trashEntries, setTrashEntries] = useState([]);
  const [trashError, setTrashError] = useState('');
  const [promptTarget, setPromptTarget] = useState(null);
  const [promptValue, setPromptValue] = useState('');
  const [storageInfo, setStorageInfo] = useState(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudStatus, setCloudStatus] = useState('Cloud is not connected.');
  const [cloudFiles, setCloudFiles] = useState([]);
  const [cloudError, setCloudError] = useState('');
  const [securityReady, setSecurityReady] = useState(false);
  const [securityRetryKey, setSecurityRetryKey] = useState(0);
  const [securityConfig, setSecurityConfig] = useState(null);
  const [securityLoadError, setSecurityLoadError] = useState('');
  const [securityMessage, setSecurityMessage] = useState('');
  const [securityInput, setSecurityInput] = useState('');
  const [securityCandidate, setSecurityCandidate] = useState('');
  const [securityCredentialType, setSecurityCredentialType] = useState('password');
  const [securitySetupAction, setSecuritySetupAction] = useState('set');
  const [securitySetupStep, setSecuritySetupStep] = useState(null);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricCheckError, setBiometricCheckError] = useState('');
  const [lockoutUntil, setLockoutUntil] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const settings = await appSecurity.load();
        if (mounted) {
          setSecurityConfig(settings);
          setSecurityLoadError('');
          setIsLocked(settings.enabled);
          setSecurityReady(true);
        }
      } catch (loadError) {
        if (mounted) {
          setSecurityLoadError(
            loadError?.message || 'App security settings could not be loaded.'
          );
          setSecurityReady(true);
          setIsLocked(true);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [appSecurity, securityRetryKey]);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    let mounted = true;
    const refreshAvailability = async () => {
      try {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const securityLevel = hasHardware
          ? await LocalAuthentication.getEnrolledLevelAsync()
          : LocalAuthentication.SecurityLevel.NONE;
        if (mounted) {
          setBiometricAvailable(
            hasHardware &&
            securityLevel === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG
          );
          setBiometricCheckError('');
        }
      } catch (error) {
        if (mounted) {
          setBiometricAvailable(false);
          setBiometricCheckError(
            error?.message || 'Biometric authentication could not be checked.'
          );
        }
      }
    };
    void refreshAvailability();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refreshAvailability();
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!securityConfig?.enabled) return undefined;
    const lockApp = () => {
      setIsLocked(true);
      setSecurityInput('');
      setSecurityMessage('');
      clearSecurityFlow();
    };
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') lockApp();
    });
    let onVisibilityChange;
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      onVisibilityChange = () => {
        if (document.hidden) lockApp();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      subscription.remove();
      if (onVisibilityChange && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [securityConfig?.enabled]);

  useEffect(() => {
    if (!lockoutUntil) return undefined;
    const timer = setInterval(() => {
      const time = Date.now();
      setCurrentTime(time);
      if (time >= lockoutUntil) setLockoutUntil(0);
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutUntil]);

  function updateSearch(value) {
    if (value !== search) {
      setSelectedIds([]);
      setSelectedTrashIds([]);
    }
    setSearch(value);
    if (activeTab === 'home' && value.trim()) {
      setActiveStorage('app');
      setCurrentPath(APP_STORAGE);
      setCategoryFilter(null);
      setSelectedCollection(null);
      setSelectedIds([]);
      setActiveTab('browse');
    }
  }

  const lockoutRemaining = Math.ceil(Math.max(0, lockoutUntil - currentTime) / 1000);

  function updateSecurityInput(value, credentialType) {
    if (credentialType === 'password') {
      setSecurityInput(value.slice(0, 64));
    }
    setSecurityMessage('');
  }

  function clearSecurityFlow() {
    setSecuritySetupStep(null);
    setSecurityInput('');
    setSecurityCandidate('');
    setSecurityMessage('');
    setSecuritySetupAction('set');
  }

  async function authenticateBiometric(promptMessage) {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      promptDescription: 'Confirm your identity to continue.',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
      ...(Platform.OS === 'android' ? { biometricsSecurityLevel: 'strong' } : {}),
    });
    if (!result.success) {
      throw new Error('Authentication was not completed.');
    }
  }

  async function openCredentialSetup(type, action = 'set') {
    setSecurityCredentialType(type);
    setSecuritySetupAction(action);
    setSecurityInput('');
    setSecurityCandidate('');
    setSecurityMessage('');
    if (securityConfig?.enabled && securityConfig.biometricEnabled) {
      setSecurityBusy(true);
      try {
        await authenticateBiometric('Verify to change app lock');
        if (action === 'remove') {
          const settings = await appSecurity.removeCredential();
          setSecurityConfig(settings);
          if (!settings.enabled) setIsLocked(false);
          return;
        }
        setSecuritySetupStep('new');
      } catch (error) {
        setSecurityMessage(error?.message || 'Biometric authentication failed.');
      } finally {
        setSecurityBusy(false);
      }
      return;
    }
    setSecuritySetupStep(securityConfig?.credentialType ? 'current' : 'new');
  }

  function startLockout(retryAfterMs) {
    const time = Date.now();
    setCurrentTime(time);
    setLockoutUntil(time + retryAfterMs);
  }

  async function submitSecurityCredential() {
    if (securityBusy || !securitySetupStep) return;
    setSecurityBusy(true);
    setSecurityMessage('');
    try {
      if (securitySetupStep === 'current') {
        const result = await appSecurity.verifyCredential(securityInput);
        if (!result.success) {
          if (result.retryAfterMs > 0) {
            startLockout(result.retryAfterMs);
            setSecurityMessage('Too many attempts. Please wait before trying again.');
          } else {
            setSecurityMessage('That credential is incorrect.');
          }
          setSecurityInput('');
          return;
        }
        setLockoutUntil(0);
        if (securitySetupAction === 'remove') {
          const settings = await appSecurity.removeCredential();
          setSecurityConfig(settings);
          if (!settings.enabled) setIsLocked(false);
          clearSecurityFlow();
          return;
        }
        setSecurityInput('');
        setSecuritySetupStep('new');
        return;
      }

      if (!isValidCredential(securityCredentialType, securityInput)) {
        setSecurityMessage(
          securityCredentialType === 'password'
            ? 'Use a password with 8 to 64 characters.'
            : 'Choose a pattern using at least 4 different dots.'
        );
        return;
      }
      if (securitySetupStep === 'new') {
        setSecurityCandidate(securityInput);
        setSecurityInput('');
        setSecuritySetupStep('confirm');
        return;
      }
      if (securityInput !== securityCandidate) {
        setSecurityCandidate('');
        setSecurityInput('');
        setSecuritySetupStep('new');
        setSecurityMessage('The entries did not match. Please enter it again.');
        return;
      }
      setSecurityConfig(
        await appSecurity.setCredential(securityCredentialType, securityInput)
      );
      setIsLocked(false);
      clearSecurityFlow();
    } catch (error) {
      setSecurityMessage(error?.message || 'App lock could not be updated.');
    } finally {
      setSecurityBusy(false);
    }
  }

  async function unlockWithCredential() {
    if (
      securityBusy ||
      lockoutUntil > Date.now() ||
      !securityConfig?.credentialType
    ) {
      return;
    }
    if (!isValidCredential(securityConfig.credentialType, securityInput)) {
      setSecurityMessage(
        securityConfig.credentialType === 'password'
          ? 'Enter your app password.'
          : 'Enter your saved pattern using at least 4 dots.'
      );
      return;
    }
    setSecurityBusy(true);
    setSecurityMessage('');
    try {
      const result = await appSecurity.verifyCredential(securityInput);
      setSecurityInput('');
      if (result.success) {
        setLockoutUntil(0);
        setIsLocked(false);
      } else if (result.retryAfterMs > 0) {
        startLockout(result.retryAfterMs);
        setSecurityMessage('Too many attempts. Please wait before trying again.');
      } else {
        setSecurityMessage('That credential is incorrect.');
      }
    } catch (error) {
      setSecurityMessage(error?.message || 'The app could not be unlocked.');
    } finally {
      setSecurityBusy(false);
    }
  }

  function renderPatternInput() {
    const patternDisabled = securityBusy ||
      (lockoutRemaining > 0 && (isLocked || securitySetupStep === 'current'));
    return (
      <View style={styles.patternEntry}>
        <View style={styles.patternGrid}>
          {Array.from({ length: 9 }, (_, index) => {
            const dot = String(index + 1);
            const selectedIndex = securityInput.indexOf(dot);
            return (
              <TouchableOpacity
                key={dot}
                accessibilityRole="button"
                accessibilityLabel={`Pattern dot ${dot}${selectedIndex >= 0 ? `, position ${selectedIndex + 1}` : ''}`}
                accessibilityState={{ selected: selectedIndex >= 0 }}
                disabled={patternDisabled || selectedIndex >= 0}
                onPress={() => {
                  setSecurityInput((value) => `${value}${dot}`);
                  setSecurityMessage('');
                }}
                style={[
                  styles.patternDot,
                  {
                    backgroundColor: selectedIndex >= 0 ? theme.accent : theme.cardAlt,
                    borderColor: selectedIndex >= 0 ? theme.accent : theme.border,
                    opacity: patternDisabled ? 0.6 : 1,
                  },
                ]}
              >
                <Text style={{ color: selectedIndex >= 0 ? '#ffffff' : theme.text, fontWeight: '700' }}>
                  {selectedIndex >= 0 ? selectedIndex + 1 : '·'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={patternDisabled || !securityInput}
          onPress={() => {
            setSecurityInput('');
            setSecurityMessage('');
          }}
          style={[styles.outlineButton, { borderColor: theme.border, opacity: securityInput ? 1 : 0.55 }]}
        >
          <Text style={{ color: theme.text }}>Clear pattern</Text>
        </TouchableOpacity>
      </View>
    );
  }

  async function connectCloud() {
    if (cloudBusy) return;
    setCloudBusy(true);
    try {
      if (!supabase || !cloudFileService) {
        throw new Error(supabaseConfigurationError || 'Cloud configuration is unavailable.');
      }
      const result = await ensureAnonymousSession(supabase);
      const files = await cloudFileService.list();
      setCloudFiles(files);
      setCloudError('');
      setCloudStatus(
        `${result.created ? 'New anonymous session' : 'Connected session'} · ${files.length} cloud file(s)`
      );
    } catch (error) {
      const message = error?.message || 'Could not connect to cloud.';
      setCloudStatus(`Connection failed: ${message}`);
      setCloudError(message);
      Alert.alert('Cloud connection failed', message);
    } finally {
      setCloudBusy(false);
    }
  }

  async function refreshCloudFiles() {
    if (cloudBusy) return;
    setCloudBusy(true);
    try {
      if (!supabase || !cloudFileService) {
        throw new Error(supabaseConfigurationError || 'Cloud configuration is unavailable.');
      }
      await ensureAnonymousSession(supabase);
      const files = await cloudFileService.list();
      setCloudFiles(files);
      setCloudError('');
      setCloudStatus(`Connected · ${files.length} cloud file(s)`);
    } catch (error) {
      const message = error?.message || 'Could not refresh cloud files.';
      setCloudError(message);
      setCloudStatus(`Cloud unavailable: ${message}`);
      Alert.alert('Cloud refresh failed', message);
    } finally {
      setCloudBusy(false);
    }
  }

  async function unlockWithBiometrics() {
    if (securityBusy || !securityConfig?.biometricEnabled) return;
    setSecurityBusy(true);
    setSecurityMessage('');
    try {
      await authenticateBiometric('Unlock PocketFiles');
      setIsLocked(false);
    } catch (error) {
      setSecurityMessage(error?.message || 'Biometric authentication failed.');
    } finally {
      setSecurityBusy(false);
    }
  }

  async function updateBiometricUnlock(enabled) {
    if (securityBusy) return;
    setSecurityBusy(true);
    setSecurityMessage('');
    try {
      if (Platform.OS === 'web') {
        throw new Error('Biometric app lock is available in the Android and iOS apps only.');
      }
      if (enabled && !biometricAvailable) {
        throw new Error(
          biometricCheckError || 'Set up fingerprint or face authentication on this device first.'
        );
      }
      await authenticateBiometric(
        enabled ? 'Enable biometric app lock' : 'Turn off biometric app lock'
      );
      const settings = await appSecurity.setBiometricEnabled(enabled);
      setSecurityConfig(settings);
      if (!settings.enabled) setIsLocked(false);
      setSecurityMessage('');
    } catch (error) {
      setSecurityMessage(error?.message || 'Biometric app lock could not be updated.');
    } finally {
      setSecurityBusy(false);
    }
  }

  const theme = darkMode ? DARK_THEME : DEFAULT_THEME;

  const currentEntries = useMemo(() => {
    const filtered = entries.filter((item) => {
      const matchesCategory = !categoryFilter || fileCategoryKey(item) === categoryFilter;
      const assignedToSelectedCollection =
        !selectedCollection ||
        collectionMetadata.assignments[item.uri]?.[categoryFilter]?.includes(selectedCollection);
      return (
        matchesSearch(item.name, search) &&
        (item.isDirectory || matchesCategory) &&
        (item.isDirectory || assignedToSelectedCollection)
      );
    });
    return sortEntries(filtered, sortMode);
  }, [categoryFilter, collectionMetadata, entries, search, selectedCollection, sortMode]);

  const recentFiles = useMemo(() => {
    return [...allLocalFiles]
      .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0))
      .slice(0, 6);
  }, [allLocalFiles]);
  const visibleRecentFiles = useMemo(
    () =>
      allLocalFiles
        .filter((file) => matchesSearch(file.name, search))
        .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0))
        .slice(0, search.trim() ? 100 : 6),
    [allLocalFiles, search]
  );

  const categorySummary = useMemo(() => {
    return CATEGORY_CONFIG.map((category) => ({
      ...category,
      count: allLocalFiles.filter((file) => fileCategoryKey(file) === category.key).length,
    }));
  }, [allLocalFiles]);
  const totalAppFileUsage = useMemo(
    () => allLocalFiles.reduce(
      (total, file) => total + (Number.isFinite(file.size) ? file.size : 0),
      0
    ),
    [allLocalFiles]
  );

  const visibleCategories = useMemo(
    () => CATEGORY_CONFIG.filter((category) => matchesSearch(category.label, search)),
    [search]
  );
  const visibleCollections = useMemo(
    () =>
      (DEFAULT_COLLECTIONS[collectionCategory] || []).filter((name) => matchesSearch(name, search)),
    [collectionCategory, search]
  );

  const visibleTrashEntries = useMemo(
    () => trashEntries.filter((entry) => matchesSearch(entry.name, search)),
    [search, trashEntries]
  );

  const visibleCloudFiles = useMemo(
    () => cloudFiles.filter((record) => matchesSearch(record.filename, search)),
    [cloudFiles, search]
  );

  const selectedCurrentEntries = visibleSelectedItems(currentEntries, selectedIds);
  const selectedVisibleTrashEntries = visibleSelectedItems(visibleTrashEntries, selectedTrashIds);
  const allCurrentEntriesSelected =
    currentEntries.length > 0 && currentEntries.every((item) => selectedIds.includes(item.id));
  const selectedCollectionEntries = selectedCurrentEntries.filter(
    (item) => collectionCategoryForFile(item) === collectionEditorCategory
  );
  const selectedCollectionCategories = [
    ...new Set(selectedCurrentEntries.map(collectionCategoryForFile).filter(Boolean)),
  ];

  async function ensureDirectory(path) {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(path, { intermediates: true });
    }
  }

  async function loadStorageInfo() {
    try {
      const [free, total] = await Promise.all([
        FileSystem.getFreeDiskStorageAsync(),
        FileSystem.getTotalDiskCapacityAsync(),
      ]);
      if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) {
        setStorageInfo(null);
        return;
      }
      setStorageInfo({ free, total, used: Math.max(total - free, 0) });
    } catch (error) {
      console.warn('Storage info unavailable', error);
      setStorageInfo(null);
    }
  }

  const readDirectory = useCallback(async (dirPath) => {
    setIsLoading(true);
    setError('');
    try {
      if (activeStorage === 'authorized') {
        const items = listAuthorizedDirectory(dirPath, ExpoDirectory);
        setEntries(items.map(metadataForItem));
        return;
      }

      const allFiles = (await listLocalFilesRecursively(FileSystem, APP_STORAGE))
        .filter((item) => item.uri !== COLLECTION_METADATA)
        .map(metadataForItem);
      setAllLocalFiles(allFiles);
      if (categoryFilter) {
        setEntries(allFiles);
        return;
      }

      const entriesList = (await FileSystem.readDirectoryAsync(dirPath)).filter(
        (name) => `${dirPath}${name}` !== COLLECTION_METADATA
      );
      const items = await Promise.all(
        entriesList.map(async (name) => {
          const uri = `${dirPath}${name}`;
          const info = await FileSystem.getInfoAsync(uri);
          return metadataForItem({
            id: uri,
            name,
            uri,
            isDirectory: info.isDirectory,
            size: info.size || 0,
            modifiedAt: info.modificationTime || info.lastModified || Date.now(),
            path: dirPath,
          });
        })
      );
      setEntries(items);
    } catch (readError) {
      const message = readError?.message || 'The folder could not be read.';
      setError(
        activeStorage === 'authorized'
          ? `Could not access this authorized folder. Choose the folder again if access was revoked. ${message}`
          : message
      );
      setEntries([]);
       } finally {
      setIsLoading(false);
    }
  }, [activeStorage, categoryFilter]);

  async function readTrashIndex() {
    const result = await loadTrashEntries(FileSystem, TRASH_INDEX, TRASH_ROOT);
    setTrashEntries(result.entries);
    setTrashError(result.warning || '');
  }

  async function refreshTrashAfterOperation() {
    try {
      await readTrashIndex();
      return '';
    } catch (refreshError) {
      const message = refreshError?.message || 'Recycle-bin metadata could not be refreshed.';
      setTrashError(message);
      return message;
    }
  }

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void (async () => {
      try {
        const info = await FileSystem.getInfoAsync(AUTHORIZED_FOLDER_RECORD);
        if (!info.exists) return;
        const saved = JSON.parse(
          await FileSystem.readAsStringAsync(AUTHORIZED_FOLDER_RECORD, { encoding: 'utf8' })
        );
        if (typeof saved?.uri !== 'string' || !saved.uri.startsWith('content://')) {
          throw new Error('The saved folder reference is invalid. Select the folder again.');
        }
        const folder = { uri: saved.uri, name: saved.name || 'Authorized folder' };
        setAuthorizedFolder(folder);
        try {
          if (!new ExpoDirectory(folder.uri).exists) {
            setAuthorizedFolderError('Folder access is no longer available. Select the folder again to restore access.');
          }
        } catch (permissionError) {
          setAuthorizedFolderError(
            `Folder access could not be verified. Select the folder again if access was revoked: ${
              permissionError?.message || 'provider permission error'
            }`
          );
        }
      } catch (loadError) {
        setAuthorizedFolderError(
          loadError?.message || 'The saved authorized-folder information could not be read.'
        );
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await ensureDirectory(APP_STORAGE);
        await ensureDirectory(TRASH_ROOT);
        await readTrashIndex();
        await loadStorageInfo();
        await readDirectory(currentPath || APP_STORAGE);
      } catch (loadError) {
        const message = loadError?.message || 'Best could not load local storage.';
        setError(message);
        setTrashError(message);
      }
    })();
    }, [activeStorage, currentPath, readDirectory]);

  useEffect(() => {
    void (async () => {
      try {
        await ensureDirectory(APP_STORAGE);
        const info = await FileSystem.getInfoAsync(COLLECTION_METADATA);
        if (!info.exists) {
          setCollectionMetadata(emptyCollectionMetadata());
          setCollectionMetadataReady(true);
          return;
        }
        const raw = await FileSystem.readAsStringAsync(COLLECTION_METADATA, { encoding: 'utf8' });
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error('Collection metadata is malformed. Existing data was left untouched.');
        }
        const { metadata, changed } = normalizeCollectionMetadata(parsed);
        if (changed) {
          await FileSystem.writeAsStringAsync(
            COLLECTION_METADATA,
            JSON.stringify(metadata),
            { encoding: 'utf8' }
          );
        }
        setCollectionMetadata(metadata);
        setCollectionMetadataReady(true);
        if (changed) {
          setCollectionMetadataNotice('Unsupported legacy collection labels were removed. Your files were not moved or deleted.');
        }
      } catch (loadError) {
        setCollectionMetadataError(
          loadError?.message || 'Collections could not be loaded. Existing metadata was left untouched.'
        );
      }
    })();
  }, []);
  const navigateDirectory = useCallback((path) => {
    setCurrentPath(path);
    setSelectedIds([]);
  }, []);

  const goBack = useCallback(() => {
    if (activeStorage === 'authorized') {
      if (authorizedPathStack.length <= 1) return;
      const nextStack = authorizedPathStack.slice(0, -1);
      setAuthorizedPathStack(nextStack);
      navigateDirectory(nextStack[nextStack.length - 1].uri);
      return;
    }
    const previous = parentDirectoryUri(currentPath, APP_STORAGE);
    if (!previous) return;
    navigateDirectory(previous);
  }, [activeStorage, authorizedPathStack, currentPath, navigateDirectory]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (securitySetupStep) {
        clearSecurityFlow();
        return true;
      }
      if (isLocked) return true;
      if (promptTarget) {
        setPromptTarget(null);
        return true;
      }
      if (imagePreview) {
        setImagePreview(null);
        return true;
      }
      if (collectionEditorCategory) {
        setCollectionEditorCategory(null);
        return true;
      }
      if (selectedIds.length) {
        setSelectedIds([]);
        return true;
      }
      if (activeTab === 'browse') {
        if (
          activeStorage === 'authorized'
            ? authorizedPathStack.length > 1
            : normalizePath(currentPath) !== normalizePath(APP_STORAGE)
        ) {
          goBack();
        } else {
          setActiveTab('home');
        }
        return true;
      }
      if (activeTab !== 'home') {
        setActiveTab('home');
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [
    activeStorage,
    activeTab,
    authorizedPathStack.length,
    collectionEditorCategory,
    currentPath,
    imagePreview,
    isLocked,
    promptTarget,
    securitySetupStep,
    selectedIds.length,
    goBack,
  ]);

  function openAppStorage() {
    setActiveStorage('app');
    setCategoryFilter(null);
    setSelectedCollection(null);
    navigateDirectory(APP_STORAGE);
  }

  function openRecycleBin() {
    setActiveTab('trash');
  }

  function openAuthorizedFolder() {
    if (Platform.OS !== 'android') {
      Alert.alert('Android folder access', 'User-authorized folder browsing is currently available on Android only.');
      return;
    }
    if (!authorizedFolder) {
      Alert.alert('Select a folder', 'Choose a folder using Android’s system folder picker to grant Best access.');
      return;
    }
    const rootEntry = { uri: authorizedFolder.uri, name: authorizedFolder.name };
    setCategoryFilter(null);
    setSelectedCollection(null);
    setAuthorizedFolderError('');
    setAuthorizedPathStack([rootEntry]);
    setActiveStorage('authorized');
    navigateDirectory(rootEntry.uri);
  }

  async function selectAuthorizedFolder() {
    if (Platform.OS !== 'android') {
      Alert.alert('Android folder access', 'The Android Storage Access Framework is not available on this platform.');
      return;
    }
    try {
      const result = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(
        authorizedFolder?.uri || null
      );
      if (!result.granted) {
        Alert.alert('No folder selected', 'No folder access was granted. Your current storage view was not changed.');
        return;
      }

      const directory = new ExpoDirectory(result.directoryUri);
      const selectedFolder = {
        uri: result.directoryUri,
        name: directory.name || 'Authorized folder',
      };
      setAuthorizedFolder(selectedFolder);
      setCategoryFilter(null);
      setSelectedCollection(null);
      setAuthorizedFolderError('');
      setAuthorizedPathStack([selectedFolder]);
      setActiveStorage('authorized');
      setActiveTab('browse');
      navigateDirectory(selectedFolder.uri);

      try {
        await FileSystem.writeAsStringAsync(
          AUTHORIZED_FOLDER_RECORD,
          JSON.stringify(selectedFolder),
          { encoding: 'utf8' }
        );
      } catch (saveError) {
        Alert.alert(
          'Folder selected for this session',
          `Access was granted, but Best could not remember this folder for the next launch: ${
            saveError?.message || 'storage error'
          }`
        );
      }
    } catch (pickerError) {
      Alert.alert(
        'Folder selection failed',
        pickerError?.message || 'Android could not open the folder picker.'
      );
    }
  }

  function toggleSelection(itemId) {
    setSelectedIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]
    );
  }

  function toggleTrashSelection(itemId) {
    setSelectedTrashIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]
    );
  }

  async function processTrashSelection(action, ids = selectedTrashIds) {
    const items = trashEntries.filter((entry) => ids.includes(entry.id));
    if (!items.length) return;

    const outcomes = [];
    const deletedOriginalUris = [];
    for (const item of items) {
      try {
        let warning = null;
        if (action === 'restore') {
          if (item.state === 'missing') throw new Error('The trashed file is no longer available.');
          ({ warning } = await restoreFromTrash(FileSystem, item.id, TRASH_INDEX, TRASH_ROOT));
        } else {
          const result = await permanentlyDelete(FileSystem, item.id, TRASH_INDEX, TRASH_ROOT);
          warning = result.warning;
          if (result.entry?.originalUri) deletedOriginalUris.push(result.entry.originalUri);
        }
        outcomes.push({ item, error: null, warning });
      } catch (operationError) {
        outcomes.push({
          item,
          error: operationError?.message || 'The operation failed.',
        });
      }
    }

    const refreshError = await refreshTrashAfterOperation();
    const collectionWarning =
      action === 'delete' ? await pruneCollectionMetadata(deletedOriginalUris) : '';
    setSelectedTrashIds([]);
    const failures = outcomes.filter((outcome) => outcome.error);
    const warnings = outcomes.filter((outcome) => outcome.warning);
    if (collectionWarning) warnings.push({ item: { name: 'Collections' }, warning: collectionWarning });
    const verb = action === 'restore' ? 'restored' : 'permanently deleted';
    if (failures.length) {
      const details = failures
        .slice(0, 5)
        .map(({ item, error: message }) => `${item.name}: ${message}`)
        .join('\n');
      Alert.alert(
        'Some items could not be processed',
        `${outcomes.length - failures.length} of ${outcomes.length} item(s) ${verb}.\n\n${details}${
          warnings.length
            ? `\n\nCompleted with warnings:\n${warnings
                .slice(0, 3)
                .map(({ item, warning }) => `${item.name}: ${warning}`)
                .join('\n')}`
            : ''
        }${
          refreshError ? `\n\nRecycle-bin refresh issue: ${refreshError}` : ''
        }`
      );
    } else if (refreshError) {
      Alert.alert(
        'Operation completed with a warning',
        `${outcomes.length} item(s) were ${verb}, but the recycle bin could not be refreshed: ${refreshError}${
          warnings.length
            ? `\n\n${warnings
                .slice(0, 3)
                .map(({ item, warning }) => `${item.name}: ${warning}`)
                .join('\n')}`
            : ''
        }`
      );
    } else if (warnings.length) {
      Alert.alert(
        'Items processed with warnings',
        `${outcomes.length} item(s) were ${verb}.\n\n${warnings
          .slice(0, 5)
          .map(({ item, warning }) => `${item.name}: ${warning}`)
          .join('\n')}`
      );
    } else {
      Alert.alert('Recycle bin updated', `${outcomes.length} item(s) were ${verb}.`);
    }
  }

  function confirmTrashBatch(
    action,
    ids = selectedVisibleTrashEntries.map((entry) => entry.id)
  ) {
    const count = visibleSelectedItems(trashEntries, ids).length;
    if (!count) return;
    const isRestore = action === 'restore';
    Alert.alert(
      isRestore ? 'Restore selected items?' : 'Permanently delete selected items?',
      isRestore
        ? `${count} item(s) will be returned to their original locations. Existing files will not be overwritten.`
        : `${count} item(s) will be permanently removed. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: isRestore ? 'Restore' : 'Delete permanently',
          style: isRestore ? 'default' : 'destructive',
          onPress: () => processTrashSelection(action, ids),
        },
      ]
    );
  }

  async function renameItem(item, nextName) {
    if (activeStorage === 'authorized') {
      Alert.alert(
        'Rename unavailable',
        'This document provider does not expose a supported rename operation. Rename this item using the provider’s own app.'
      );
      return;
    }
    const directory = item.path || currentPath;
    try {
      const destination = await renameLocalItem(FileSystem, item, directory, nextName);
      if (destination !== item.uri && collectionMetadataReady) {
        const renamedMetadata = renameCollectionPath(collectionMetadata, item.uri, destination);
        try {
          await persistCollectionMetadata(renamedMetadata);
        } catch (metadataError) {
          Alert.alert(
            'Renamed with a collections warning',
            `"${item.name}" was renamed, but its collection assignments could not be updated: ${metadataError?.message || 'metadata write failed'}`
          );
        }
      }
      await readDirectory(directory);
    } catch (error) {
      Alert.alert('Rename failed', error.message || `Could not rename "${item.name}".`);
    }
  }

  async function persistCollectionMetadata(nextMetadata) {
    if (!collectionMetadataReady) {
      throw new Error('Collections are not available because their existing metadata could not be loaded safely.');
    }
    await FileSystem.writeAsStringAsync(
      COLLECTION_METADATA,
      JSON.stringify(nextMetadata),
      { encoding: 'utf8' }
    );
    setCollectionMetadata(nextMetadata);
    setCollectionMetadataError('');
    setCollectionMetadataNotice('');
  }

  async function pruneCollectionMetadata(uris) {
    if (!uris.length) return '';
    try {
      await persistCollectionMetadata(removeCollectionAssignments(collectionMetadata, uris));
      return '';
    } catch (metadataError) {
      return `The file was deleted, but collection metadata could not be updated: ${metadataError?.message || 'metadata write failed'}`;
    }
  }

  function previewImage(item) {
    setImagePreviewError('');
    setImagePreview(item);
  }

  async function toggleCollectionForSelection(collection) {
    const items = selectedCollectionEntries;
    if (!items.length || !collectionEditorCategory || collectionSaving) return;
    setCollectionSaving(true);
    try {
      const assignedCount = items.filter((item) =>
        collectionMetadata.assignments[item.uri]?.[collectionEditorCategory]?.includes(collection)
      ).length;
      const next = setCollectionMembership(
        collectionMetadata,
        collectionEditorCategory,
        items.map((item) => item.uri),
        collection,
        assignedCount !== items.length
      );
      await persistCollectionMetadata(next);
      setCollectionEditorCategory(null);
      Alert.alert(
        'Collections updated',
        `${items.length} ${collectionEditorCategory} file(s) were ${assignedCount === items.length ? 'removed from' : 'added to'} “${collection}”.`
      );
    } catch (saveError) {
      Alert.alert('Could not update collections', saveError?.message || 'Collection metadata could not be saved.');
    } finally {
      setCollectionSaving(false);
    }

  }

  async function handleDelete(item) {
    const ifTrash = item.isTrashEntry;
    if (activeStorage === 'authorized' && !ifTrash) {
      Alert.alert(
        'Permanently delete from authorized folder?',
        `"${item.name}" will be deleted using the selected document provider. It will not go to Best’s recycle bin.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete permanently',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteAuthorizedItem(FileSystem.StorageAccessFramework, item);
                await readDirectory(currentPath);
                Alert.alert('Deleted', `"${item.name}" was deleted by the document provider.`);
              } catch (deleteError) {
                Alert.alert(
                  'Delete failed',
                  deleteError?.message || `The provider could not delete "${item.name}".`
                );
              }
            },
          },
        ]
      );
      return;
    }
    const actionLabel = ifTrash ? 'Delete permanently' : 'Move to Trash';
    Alert.alert('Confirm', `Do you want to ${actionLabel.toLowerCase()}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: actionLabel,
        style: 'destructive',
        onPress: async () => {
          try {
            const result = ifTrash
              ? await permanentlyDelete(FileSystem, item.id, TRASH_INDEX, TRASH_ROOT)
              : await moveToTrash(FileSystem, item, TRASH_INDEX, TRASH_ROOT);
            const collectionWarning =
              ifTrash && result.entry?.originalUri
                ? await pruneCollectionMetadata([result.entry.originalUri])
                : '';
            const refreshError = await refreshTrashAfterOperation();
            if (ifTrash) {
              const messages = [result.warning, refreshError, collectionWarning].filter(Boolean);
              Alert.alert(
                'Deleted',
                `"${item.name}" was permanently deleted.${messages.length ? `\n\n${messages.join('\n')}` : ''}`
              );
            } else if (result.warning) {
              Alert.alert('Moved to Recycle Bin', result.warning);
            } else if (refreshError) {
              Alert.alert('Moved to Recycle Bin', `The file was moved, but the recycle bin could not refresh: ${refreshError}`);
            }
            if (!ifTrash) await readDirectory(currentPath);
          } catch (error) {
            Alert.alert(ifTrash ? 'Permanent deletion failed' : 'Delete failed', error.message || `Could not process "${item.name}".`);
          }
        },
      },
    ]);
  }

  async function restoreTrashEntry(entry) {
    try {
      const result = await restoreFromTrash(FileSystem, entry.id, TRASH_INDEX, TRASH_ROOT);
      const refreshError = await refreshTrashAfterOperation();
      await readDirectory(currentPath);
      Alert.alert(
        'Restored',
        `"${entry.name}" was restored to its original location.${
          result.warning || refreshError ? `\n\n${[result.warning, refreshError].filter(Boolean).join('\n')}` : ''
        }`
      );
    } catch (error) {
      Alert.alert('Restore failed', error.message || 'Could not restore the item.');
    }
  }

  async function handleBulkDelete() {
    const selectedEntries = selectedCurrentEntries;
    if (!selectedEntries.length) return;
    if (activeStorage === 'authorized') {
      Alert.alert(
        'Permanently delete selected items?',
        `${selectedEntries.length} item(s) will be deleted by the selected document provider and will not go to Best’s recycle bin.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete permanently',
            style: 'destructive',
            onPress: async () => {
              const outcomes = [];
              for (const item of selectedEntries) {
                try {
                  await deleteAuthorizedItem(FileSystem.StorageAccessFramework, item);
                  outcomes.push({ item, error: null });
                } catch (deleteError) {
                  outcomes.push({ item, error: deleteError?.message || 'Provider deletion failed.' });
                }
              }
              await readDirectory(currentPath);
              setSelectedIds([]);
              const failures = outcomes.filter((outcome) => outcome.error);
              if (failures.length) {
                const details = failures
                  .slice(0, 4)
                  .map(({ item, error: message }) => `${item.name}: ${message}`)
                  .join('\n');
                Alert.alert(
                  'Some items could not be deleted',
                  `${outcomes.length - failures.length} of ${outcomes.length} item(s) deleted.\n\n${details}`
                );
              } else {
                Alert.alert('Deleted', `${outcomes.length} item(s) were deleted by the provider.`);
              }
            },
          },
        ]
      );
      return;
    }
    Alert.alert('Delete selected', `Move ${selectedEntries.length} selected item(s) to the recycle bin?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const results = await moveItemsToTrash(FileSystem, selectedEntries, TRASH_INDEX, TRASH_ROOT);
          const succeeded = results.filter((result) => result.success);
          const failed = results.filter((result) => !result.success);
          const refreshError = await refreshTrashAfterOperation();
          await readDirectory(currentPath);
          setSelectedIds([]);
          if (failed.length) {
            const failureDetails = failed
              .slice(0, 4)
              .map((result) => `${result.item.name}: ${result.error}`)
              .join('\n');
            const remainingCount = failed.length > 4 ? `\nAnd ${failed.length - 4} more failure(s).` : '';
            Alert.alert(
              'Some items could not be moved',
              `${succeeded.length} of ${results.length} item(s) moved to the recycle bin.\n\n${failureDetails}${remainingCount}${
                refreshError ? `\n\nRecycle-bin refresh issue: ${refreshError}` : ''
              }`
            );
          } else {
            const warnings = succeeded
              .map((result) => result.warning)
              .filter(Boolean);
            if (refreshError) warnings.push(refreshError);
            if (warnings.length) Alert.alert('Items moved with warnings', warnings.join('\n'));
          }
        },
      },
    ]);
  }

  async function handleOpenFile(item) {
    if (item.isDirectory) {
      if (activeStorage === 'authorized') {
        const nextStack = [...authorizedPathStack, { uri: item.uri, name: item.name }];
        setAuthorizedPathStack(nextStack);
        navigateDirectory(item.uri);
      } else {
        navigateDirectory(`${item.uri}/`);
      }
      return;
    }
    try {
      if (Platform.OS === 'web') {
        Alert.alert('File opening unavailable', 'The web preview cannot open local files. Use the Android app to open this file with a compatible app.');
        return;
      }
      if (Platform.OS === 'android') {
        const file = new ExpoFile(item.uri);
        await openAndroidFile(file.contentUri, item.mimeType || file.type);
        return;
      }
      await shareFile(item, `Share ${item.name}`);
    } catch (error) {
      if (Platform.OS === 'android') {
        Alert.alert(
          'Could not open file',
          `${item.name} could not be opened by a compatible app.${
            error?.message ? `\n\n${error.message}` : ''
          }`,
          [
            {
              text: 'Share instead',
              onPress: async () => {
                try {
                  if (!(await Sharing.isAvailableAsync())) {
                    throw new Error('File sharing is unavailable on this device.');
                  }
                  await shareFile(item, `Share ${item.name}`);
                } catch (shareError) {
                  Alert.alert('Share failed', shareError?.message || 'Could not share the file.');
                }
              },
            },
            { text: 'Cancel', style: 'cancel' },
          ]
        );
      } else {
        Alert.alert('Share failed', error.message || 'Could not share the file.');
      }
    }
  }

  async function shareFile(item, dialogTitle) {
    let cacheCopy = null;
    let shareError = null;
    try {
      let shareUri = item.uri;
      if (activeStorage === 'authorized') {
        cacheCopy = createShareCacheFile();
        await new ExpoFile(item.uri).copy(cacheCopy);
        shareUri = cacheCopy.uri;
      }
      await Sharing.shareAsync(shareUri, {
        mimeType: item.mimeType || 'application/octet-stream',
        dialogTitle,
      });
    } catch (error) {
      shareError = error;
    }

    if (cacheCopy?.exists) {
      try {
        cacheCopy.delete();
      } catch (cleanupError) {
        if (shareError) {
          throw new Error(
            `${shareError.message || 'Sharing failed.'} The temporary cache copy could not be removed: ${
              cleanupError?.message || 'cleanup error'
            }`
          );
        }
        throw new Error(
          `The file was shared, but its temporary cache copy could not be removed: ${
            cleanupError?.message || 'cleanup error'
          }`
        );
      }
    }
    if (shareError) throw shareError;
  }

  async function importDocuments() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
      if (result.canceled || !result.assets?.length) return;
      const [asset] = result.assets;
      const name = requireImportedFileName(asset.name);
      if (activeStorage === 'authorized') {
        await copyFileIntoAuthorizedFolder(
          ExpoFile,
          ExpoDirectory,
          asset.uri,
          currentPath,
          name,
          entries
        );
        await readDirectory(currentPath);
        Alert.alert('Imported', `${name} was copied to the selected authorized folder.`);
        return;
      }
      await importLocalFile(FileSystem, asset.uri, currentPath, name);
      await readDirectory(currentPath);
      Alert.alert('Imported', `${name} has been saved to ${currentPath}.`);
    } catch (error) {
      Alert.alert('Import failed', error.message || 'The document could not be imported.');
    }
  }

  async function shareSelectedFiles() {
    const selectedEntries = selectedCurrentEntries;
    const filesToShare = selectedEntries.filter((entry) => !entry.isDirectory);
    if (!filesToShare.length) {
      Alert.alert('No files selected', 'Select one or more files to share.');
      return;
    }
    try {
      if (filesToShare.length === 1) {
        await shareFile(filesToShare[0], `Share ${filesToShare[0].name}`);
        return;
      }

      const result = await shareFilesOneAtATime(
        filesToShare,
        (file, index, total) =>
          new Promise((resolve) => {
            Alert.alert(
              `Open share sheet ${index + 1} of ${total}?`,
              `This opens a separate Android share sheet for "${file.name}". Return here afterward to continue, or choose Stop to end the queue. Android does not report whether a file was sent or the sheet was cancelled.`,
              [
                { text: 'Stop', style: 'cancel', onPress: () => resolve(false) },
                { text: 'Open share sheet', onPress: () => resolve(true) },
              ],
              { cancelable: false }
            );
          }),
        (file) => shareFile(file, `Share ${file.name}`)
      );
      if (result.stopped) {
        Alert.alert(
          'Sharing stopped',
          `The share sheet was completed for ${result.completedCount} of ${filesToShare.length} selected file(s). Expo cannot tell whether each file was sent or the share sheet was cancelled.`
        );
      } else {
        Alert.alert(
          'Sharing complete',
          `Opened and completed a separate share sheet for each of the ${result.completedCount} selected file(s). Expo cannot tell whether a file was sent or its share sheet was cancelled.`
        );
      }
    } catch (error) {
      Alert.alert('Share issue', error.message || 'Could not share the selected file(s). Remaining files were not opened.');
    }
  }

  async function uploadCloudFile() {
      if (cloudBusy) return;
      setCloudBusy(true);
      let uploadedRecord = null;
      try {
        if (!supabase || !cloudFileService) {
          throw new Error(supabaseConfigurationError || 'Cloud configuration is unavailable.');
        }
        await ensureAnonymousSession(supabase);
        const result = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (result.canceled || !result.assets?.length) return;
        const [asset] = result.assets;
        if (asset.size > MAX_CLOUD_FILE_SIZE_BYTES) {
          throw new Error(`Cloud files cannot be larger than ${MAX_CLOUD_FILE_SIZE_BYTES / (1024 * 1024)} MB.`);
        }
        uploadedRecord = await cloudFileService.upload({
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.size,
        });
        try {
          const files = await cloudFileService.list();
          setCloudFiles(files);
          setCloudError('');
          setCloudStatus(`Connected · ${files.length} cloud file(s)`);
          Alert.alert('Uploaded', `${uploadedRecord.filename} is now stored in your private cloud bucket.`);
        } catch (refreshError) {
          setCloudError(refreshError?.message || 'The upload completed, but the list could not be refreshed.');
          Alert.alert(
            'Upload completed',
            `${uploadedRecord.filename} was uploaded. The cloud list could not be refreshed: ${refreshError?.message || 'unknown refresh error'}`
          );
        }
      } catch (error) {
        const message = error?.message || 'Cloud upload failed.';
        setCloudError(message);
        Alert.alert(uploadedRecord ? 'Upload completed with an issue' : 'Upload failed', message);
      } finally {
        setCloudBusy(false);
      }
  }

  async function downloadCloudFile(record) {
      if (cloudBusy) return;
      setCloudBusy(true);
      let downloaded = null;
      try {
        if (!supabase || !cloudFileService) {
          throw new Error(supabaseConfigurationError || 'Cloud configuration is unavailable.');
        }
        await ensureAnonymousSession(supabase);
        downloaded = await cloudFileService.download(record);
        if (activeStorage === 'app' && normalizePath(currentPath) === normalizePath(APP_STORAGE)) {
          await readDirectory(APP_STORAGE);
        }
        Alert.alert(
          'Downloaded',
          `${record.filename} was saved locally as ${downloaded.localUri.replace(APP_STORAGE, '')}.`
        );
      } catch (error) {
        const message = error?.message || 'Cloud download failed.';
        setCloudError(message);
        Alert.alert(downloaded ? 'Download completed with an issue' : 'Download failed', message);
      } finally {
        setCloudBusy(false);
      }
  }

  function confirmDeleteCloudFile(record) {
      Alert.alert(
        'Delete cloud file?',
        `"${record.filename}" will be removed from cloud storage. This does not affect local copies.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              if (cloudBusy) return;
              setCloudBusy(true);
              let deleted = false;
              try {
                if (!supabase || !cloudFileService) {
                  throw new Error(supabaseConfigurationError || 'Cloud configuration is unavailable.');
                }
                await ensureAnonymousSession(supabase);
                await cloudFileService.remove(record);
                deleted = true;
                try {
                  const files = await cloudFileService.list();
                  setCloudFiles(files);
                  setCloudError('');
                  setCloudStatus(`Connected · ${files.length} cloud file(s)`);
                  Alert.alert('Deleted', `${record.filename} was removed from cloud storage.`);
                } catch (refreshError) {
                  setCloudError(refreshError?.message || 'Deletion completed, but the list could not be refreshed.');
                  Alert.alert(
                    'Deletion completed',
                    `${record.filename} was deleted. The cloud list could not be refreshed: ${refreshError?.message || 'unknown refresh error'}`
                  );
                }
              } catch (error) {
                const message = error?.message || 'Cloud deletion failed.';
                setCloudError(message);
                Alert.alert(deleted ? 'Deletion completed with an issue' : 'Cloud deletion failed', message);
              } finally {
                setCloudBusy(false);
              }
            },
          },
        ]
      );
  }

  const renderBrowseItem = ({ item }) => {
    const isSelected = selectedIds.includes(item.id);
    const isImage = !item.isDirectory && fileCategoryKey(item) === 'images';
    const hasThumbnail = isImage && canPreviewImage(item);
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={`${item.isDirectory ? 'Folder' : 'File'} ${item.name}${isSelected ? ', selected' : ''}`}
        accessibilityHint={item.isDirectory ? 'Tap to open folder. Long press to select.' : hasThumbnail ? 'Tap to preview image. Long press to select.' : 'Tap to open file. Long press to select.'}
        style={[
          styles.listRow,
          viewMode === 'grid' && styles.gridItem,
          { backgroundColor: isSelected ? theme.accentSoft : theme.card, borderColor: theme.border },
        ]}
        onPress={() => {
          if (selectedIds.length) {
            toggleSelection(item.id);
          } else if (hasThumbnail && activeStorage === 'app') {
            previewImage(item);
          } else {
            handleOpenFile(item);
          }
        }}
        onLongPress={() => toggleSelection(item.id)}
      >
        {hasThumbnail && activeStorage === 'app' ? (
          <Image
            source={{ uri: item.uri }}
            resizeMode="cover"
            resizeMethod="resize"
            style={[styles.fileThumbnail, viewMode === 'grid' && styles.gridThumbnail]}
          />
        ) : (
          <View style={[styles.fileGlyph, { backgroundColor: item.isDirectory ? theme.accentSoft : theme.cardAlt }]}>
            <Text style={styles.fileGlyphText}>{fileIconForItem(item)}</Text>
          </View>
        )}
        <View style={styles.listInfo}>
          <Text style={[styles.itemName, { color: theme.text }]}>{item.name}</Text>
          <Text style={[styles.itemMeta, { color: theme.muted }]}>
            {item.isDirectory ? 'Folder' : `${formatBytes(item.size)} · ${item.type}`}
          </Text>
        </View>
        <View style={styles.itemActions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Rename ${item.name}`}
            hitSlop={4}
            onPress={() => {
              if (activeStorage === 'authorized') {
                Alert.alert(
                  'Rename unavailable',
                  'This document provider does not expose a supported rename operation. Rename this item using the provider’s own app.'
                );
                return;
              }
              setPromptTarget({ type: 'rename', item });
              setPromptValue(item.name);
            }}
            style={[styles.smallAction, { backgroundColor: theme.cardAlt }]}
          >
            <Text style={[styles.actionGlyph, { color: theme.text }]}>{activeStorage === 'authorized' ? '—' : 'R'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${activeStorage === 'authorized' ? 'Delete' : 'Move to recycle bin'} ${item.name}`}
            hitSlop={4}
            onPress={() => handleDelete(item)}
            style={[styles.smallAction, { backgroundColor: theme.dangerSoft }]}
          >
            <Text style={[styles.actionGlyph, { color: theme.danger }]}>D</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  if (!securityReady || securityLoadError) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
        <StatusBar barStyle={darkMode ? 'light-content' : 'dark-content'} />
        <View style={[styles.securityScreen, { backgroundColor: theme.background }]}>
          <View style={[styles.brandMark, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}>
            <Image source={APP_ICON} resizeMode="cover" style={styles.brandMarkImage} />
          </View>
          <Text style={[styles.appTitle, styles.securityTitle, { color: theme.text }]}>
            {securityLoadError ? 'Security settings unavailable' : 'PocketFiles'}
          </Text>
          <Text style={[styles.bodyCopy, styles.securityCopy, { color: theme.muted }]}>
            {securityLoadError || 'Checking your app security settings…'}
          </Text>
          {securityLoadError && (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => {
                setSecurityReady(false);
                setSecurityLoadError('');
                setSecurityRetryKey((value) => value + 1);
              }}
              style={[styles.primaryButton, { backgroundColor: theme.accent }]}
            >
              <Text style={styles.primaryButtonText}>Retry</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (securityConfig?.enabled && isLocked) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
        <StatusBar barStyle={darkMode ? 'light-content' : 'dark-content'} />
        <View style={[styles.securityScreen, { backgroundColor: theme.background }]}>
          <View style={[styles.brandMark, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}>
            <Image source={APP_ICON} resizeMode="cover" style={styles.brandMarkImage} />
          </View>
          <Text style={[styles.appTitle, styles.securityTitle, { color: theme.text }]}>
            PocketFiles is locked
          </Text>
          <Text style={[styles.bodyCopy, styles.securityCopy, { color: theme.muted }]}>
            {securityConfig.credentialType === 'pattern'
              ? 'Draw your saved pattern or use an enabled biometric to open your files.'
              : securityConfig.credentialType === 'password'
                ? 'Enter your saved password or use an enabled biometric to open your files.'
                : 'Confirm with your fingerprint or another biometric enrolled on this device.'}
          </Text>
          {securityConfig.biometricEnabled && Platform.OS !== 'web' && (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={securityBusy}
              onPress={() => void unlockWithBiometrics()}
              style={[styles.primaryButton, styles.securityButton, { backgroundColor: theme.accent }]}
            >
              <Text style={styles.primaryButtonText}>
                {securityBusy ? 'Checking…' : 'Unlock with fingerprint / face'}
              </Text>
            </TouchableOpacity>
          )}
          {securityConfig.credentialType === 'pattern'
            ? renderPatternInput()
            : securityConfig.credentialType === 'password'
              ? (
                <TextInput
                  accessibilityLabel="App lock password"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!securityBusy && lockoutRemaining === 0}
                  maxLength={64}
                  onChangeText={(value) => updateSecurityInput(value, 'password')}
                  onSubmitEditing={() => void unlockWithCredential()}
                  placeholder="App lock password"
                  placeholderTextColor={theme.muted}
                  returnKeyType="go"
                  secureTextEntry
                  style={[styles.modalInput, styles.securityInput, {
                    backgroundColor: theme.card,
                    color: theme.text,
                    borderColor: theme.border,
                  }]}
                  value={securityInput}
                />
              )
              : null}
          {securityConfig.credentialType && (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={securityBusy || lockoutRemaining > 0}
              onPress={() => void unlockWithCredential()}
              style={[styles.primaryButton, styles.securityButton, {
                backgroundColor: theme.accent,
                opacity: securityBusy || lockoutRemaining > 0 ? 0.6 : 1,
              }]}
            >
              <Text style={styles.primaryButtonText}>
                {securityBusy
                  ? 'Checking…'
                  : lockoutRemaining > 0
                    ? `Try again in ${lockoutRemaining}s`
                    : 'Unlock with password or pattern'}
              </Text>
            </TouchableOpacity>
          )}
          {!biometricAvailable && Platform.OS !== 'web' && !!biometricCheckError && (
            <Text style={[styles.bodyCopy, styles.securityCopy, { color: theme.muted }]}>
              {biometricCheckError} If your device offers screen-lock authentication, it may be available as a system fallback.
            </Text>
          )}
          {Platform.OS === 'web' && !securityConfig.credentialType && (
            <Text style={[styles.bodyCopy, styles.securityCopy, { color: theme.muted }]}>
              Enable a password or pattern lock in Settings to protect this web app.
            </Text>
          )}
          {!!securityMessage && (
            <Text accessibilityRole="alert" style={[styles.errorText, styles.securityMessage, { color: theme.danger }]}>
              {securityMessage}
            </Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <StatusBar barStyle={darkMode ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
      <View style={[styles.appShell, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <View style={styles.brandWrap}>
            <View style={[styles.brandMark, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}>
              <Image source={APP_ICON} resizeMode="cover" style={styles.brandMarkImage} />
            </View>
            <View>
              <Text style={[styles.appTitle, { color: theme.text }]}>
                {activeTab === 'home' ? 'Best' : activeTab === 'browse' ? 'Files' : activeTab === 'trash' ? 'Recycle bin' : activeTab === 'cloud' ? 'Cloud files' : activeTab === 'settings' ? 'Settings' : activeTab === 'categories' ? collectionCategory ? `${CATEGORY_CONFIG.find((item) => item.key === collectionCategory)?.label || 'Collections'} collections` : 'Categories' : 'Recent'}
              </Text>
              <Text style={[styles.appSubtitle, { color: theme.muted }]}>
                {activeTab === 'browse'
                  ? (activeStorage === 'authorized' ? authorizedFolder?.name || 'Authorized folder' : 'On this device')
                  : activeTab === 'cloud'
                    ? cloudStatus
                    : activeTab === 'trash'
                      ? 'Recently removed local files'
                      : activeTab === 'settings'
                        ? 'Storage, appearance & privacy'
                        : 'Your files, all in one place'}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Switch to ${darkMode ? 'light' : 'dark'} theme`}
            style={[styles.toggleButton, { backgroundColor: theme.card, borderColor: theme.border }]}
            onPress={() => setDarkMode((prev) => !prev)}
          >
            <Text style={{ color: theme.text, fontWeight: '700', fontSize: 16 }}>{darkMode ? '☼' : '◐'}</Text>
          </TouchableOpacity>
        </View>

        {['home', 'browse', 'recent', 'cloud', 'trash', 'categories'].includes(activeTab) ? (
        <View style={[styles.searchBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.searchGlyph, { color: theme.muted }]}>⌕</Text>
          <TextInput
            accessibilityLabel="Search files"
            value={search}
            onChangeText={updateSearch}
            placeholder={
              activeTab === 'cloud'
                ? 'Search cloud files'
                : activeTab === 'home'
                  ? 'Search app files'
                  : activeTab === 'recent'
                    ? 'Search recent files'
                    : activeTab === 'trash'
                      ? 'Search recycle bin'
                      : activeTab === 'categories'
                        ? 'Search categories'
                        : 'Search this folder'
            }
            placeholderTextColor={theme.muted}
            style={[styles.searchInput, { color: theme.text }]}
            returnKeyType="search"
          />
          {!!search && (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              onPress={() => updateSearch('')}
              style={styles.clearSearch}
            >
              <Text style={{ color: theme.muted }}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
        ) : null}

        {activeTab === 'home' && (
          <ScrollView contentContainerStyle={styles.contentPad} showsVerticalScrollIndicator={false}>
            <View style={[styles.heroCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardEyebrow, { color: theme.muted }]}>DEVICE INTERNAL STORAGE</Text>
              {storageInfo ? (
                <>
                  <Text style={[styles.storageUsed, { color: theme.text }]}>{formatBytes(storageInfo.used)} used on device</Text>
                  <View style={[styles.storageBarContainer, { backgroundColor: theme.cardAlt }]}>
                    <View
                      style={[
                        styles.storageBarFill,
                        {
                          width: `${Math.min(100, (storageInfo.used / storageInfo.total) * 100)}%`,
                          backgroundColor: theme.accent,
                        },
                      ]}
                    />
                  </View>
                  <View style={styles.storageDetails}>
                    <Text style={{ color: theme.muted }}>Free {formatBytes(storageInfo.free)}</Text>
                    <Text style={{ color: theme.muted }}>Total {formatBytes(storageInfo.total)}</Text>
                  </View>
                </>
              ) : (
                <Text style={{ color: theme.muted }}>Storage information is unavailable on this device.</Text>
              )}
              <Text style={[styles.itemMeta, { color: theme.muted, marginTop: 10 }]}>
                Includes data used by Android and all apps; this is not Best’s private-folder size.
              </Text>
            </View>

            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setActiveTab('cloud')}
              style={[styles.cloudPromo, { backgroundColor: theme.surface, borderColor: theme.surface }]}
            >
              <View style={styles.cloudPromoCopy}>
                <Text style={styles.cloudPromoTitle}>Private cloud storage</Text>
                <Text style={styles.cloudPromoMeta}>{cloudStatus}</Text>
              </View>
              <Text style={styles.cloudPromoAction}>Open</Text>
            </TouchableOpacity>

            <View style={styles.sectionHeading}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Browse by type</Text>
              <TouchableOpacity accessibilityRole="button" onPress={() => { setCollectionCategory(null); setActiveTab('categories'); }}>
                <Text style={{ color: theme.accent, fontWeight: '600' }}>See all</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.categoryGrid}>
              {categorySummary.map((item) => (
                <TouchableOpacity
                  key={item.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.label}, ${item.count} items`}
                  style={[styles.categoryCard, { backgroundColor: theme.card, borderColor: theme.border }]}
                  onPress={() => {
                    setSelectedIds([]);
                    setSearch('');
                    setActiveStorage('app');
                    setCurrentPath(APP_STORAGE);
                    setCategoryFilter(item.key);
                    setSelectedCollection(null);
                    setActiveTab('browse');
                  }}
                >
                  <Text style={[styles.categoryMark, { color: theme.accent, backgroundColor: theme.accentSoft }]}>{item.icon}</Text>
                  <Text style={[styles.categoryTitle, { color: theme.text }]}>{item.label}</Text>
                  <Text style={{ color: theme.muted }}>{item.count} items</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View
              accessible
              accessibilityLabel={`Total PocketFiles storage usage: ${formatBytes(totalAppFileUsage)} across ${allLocalFiles.length} files`}
              style={[styles.fileUsageCard, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <View style={[styles.fileUsageIcon, { backgroundColor: theme.accentSoft }]}>
                <Text style={{ fontSize: 21 }}>💾</Text>
              </View>
              <View style={styles.listInfo}>
                <Text style={[styles.itemMeta, { color: theme.muted }]}>TOTAL FILE STORAGE</Text>
                <Text style={[styles.fileUsageTotal, { color: theme.text }]}>
                  {formatBytes(totalAppFileUsage)}
                </Text>
                <Text style={[styles.itemMeta, { color: theme.muted }]}>
                  Across {allLocalFiles.length} files in PocketFiles storage
                </Text>
              </View>
            </View>

            <View style={styles.sectionHeading}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Recent files</Text>
              <TouchableOpacity accessibilityRole="button" onPress={() => setActiveTab('recent')}>
                <Text style={{ color: theme.accent, fontWeight: '600' }}>View</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              {recentFiles.length ? (
                recentFiles.map((file) => (
                  <TouchableOpacity key={file.uri} onPress={() => canPreviewImage(file) ? previewImage(file) : handleOpenFile(file)} style={styles.recentItem}>
                    <Text style={[styles.recentMark, { color: theme.accent, backgroundColor: theme.accentSoft }]}>{fileIconForItem(file)}</Text>
                    <View style={styles.listInfo}>
                      <Text style={[styles.itemName, { color: theme.text }]}>{file.name}</Text>
                      <Text style={[styles.itemMeta, { color: theme.muted }]}>{formatDate(file.modifiedAt)}</Text>
                    </View>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={{ color: theme.muted }}>No recent files yet.</Text>
              )}
            </View>

            <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Quick access</Text>
              <View style={styles.quickActions}>
                <TouchableOpacity style={[styles.quickButton, { backgroundColor: theme.accentSoft }]} onPress={() => { openAppStorage(); setActiveTab('browse'); }}>
                  <Text style={{ color: theme.accent }}>App storage</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.quickButton, { backgroundColor: theme.cardAlt }]} onPress={() => setActiveTab('categories')}>
                  <Text style={{ color: theme.text }}>Categories</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.quickButton, { backgroundColor: theme.cardAlt }]} onPress={() => setActiveTab('recent')}>
                  <Text style={{ color: theme.text }}>Recent</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.quickButton, { backgroundColor: theme.cardAlt }]} onPress={openRecycleBin}>
                  <Text style={{ color: theme.text }}>Recycle bin</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.quickButton, { backgroundColor: theme.cardAlt }]} onPress={importDocuments}>
                  <Text style={{ color: theme.text }}>Import file</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.quickButton, { backgroundColor: theme.cardAlt }]} onPress={selectAuthorizedFolder}>
                  <Text style={{ color: theme.text }}>Choose authorized folder</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        )}

        {activeTab === 'browse' && (
          <View style={[styles.contentPad, styles.browseScreen]}>
            <View style={[styles.browseHeader, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Go to parent folder"
                onPress={goBack}
                style={[styles.breadcrumbButton, { backgroundColor: theme.cardAlt }]}
              >
                <Text>←</Text>
              </TouchableOpacity>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.breadcrumbBar}>
                {(activeStorage === 'authorized'
                  ? authorizedPathStack
                  : appDirectoryBreadcrumbs(currentPath, APP_STORAGE)
                ).map((segment, index, arr) => (
                  <TouchableOpacity
                    key={`${segment.uri || segment.name}-${index}`}
                    onPress={() => {
                      if (activeStorage === 'authorized') {
                        const nextStack = parentBreadcrumbs(authorizedPathStack, segment.uri);
                        setAuthorizedPathStack(nextStack);
                        navigateDirectory(segment.uri);
                        return;
                      }
                      if (index === 0) {
                        openAppStorage();
                        return;
                      }
                      navigateDirectory(segment.uri);
                    }}
                  >
                    <Text style={[styles.breadcrumb, { color: index === arr.length - 1 ? theme.text : theme.muted }]}> {segment.name} </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <Text style={[styles.itemMeta, { color: theme.muted, marginBottom: 8 }]}>
              {activeStorage === 'authorized'
                ? `Authorized folder: ${authorizedFolder?.name || 'Selected folder'} · Provider operations may vary`
                : 'Best private storage · managed by the app'}
            </Text>
            {categoryFilter ? (
              <View style={[styles.filterNotice, { backgroundColor: theme.accentSoft }]}>
                <Text style={{ color: theme.accent, fontWeight: '600' }}>
                  Showing {CATEGORY_CONFIG.find((item) => item.key === categoryFilter)?.label || 'category'}
                  {selectedCollection ? ` · ${selectedCollection}` : ''}
                </Text>
                <TouchableOpacity accessibilityRole="button" onPress={() => { setCategoryFilter(null); setSelectedCollection(null); }}>
                  <Text style={{ color: theme.accent }}>Clear filter</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {collectionMetadataError ? (
              <Text style={[styles.errorText, { color: theme.danger }]}>{collectionMetadataError}</Text>
            ) : null}
            {collectionMetadataNotice ? (
              <Text style={[styles.itemMeta, { color: theme.muted, marginBottom: 10 }]}>{collectionMetadataNotice}</Text>
            ) : null}
            {authorizedFolderError ? (
              <Text style={[styles.errorText, { color: theme.danger }]}>{authorizedFolderError}</Text>
            ) : null}
            <View style={styles.quickActions}>
              <TouchableOpacity
                style={[styles.quickButton, { backgroundColor: activeStorage === 'app' ? theme.accentSoft : theme.cardAlt }]}
                onPress={openAppStorage}
              >
                <Text style={{ color: activeStorage === 'app' ? theme.accent : theme.text }}>App storage</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.quickButton, { backgroundColor: activeStorage === 'authorized' ? theme.accentSoft : theme.cardAlt }]}
                onPress={openAuthorizedFolder}
              >
                <Text style={{ color: activeStorage === 'authorized' ? theme.accent : theme.text }}>Authorized folder</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.quickButton, { backgroundColor: theme.cardAlt }]}
                onPress={selectAuthorizedFolder}
              >
                <Text style={{ color: theme.text }}>{authorizedFolder ? 'Change folder' : 'Choose folder'}</Text>
              </TouchableOpacity>
            </View>

            {selectedCurrentEntries.length > 0 && (
              <View style={[styles.selectionBar, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <View>
                  <Text style={[styles.selectionText, { color: theme.text }]}>{selectedCurrentEntries.length} selected</Text>
                  <TouchableOpacity accessibilityRole="button" onPress={() => setSelectedIds([])}>
                    <Text style={[styles.itemMeta, { color: theme.accent }]}>Clear selection</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.selectionActions}>
                  {selectedCollectionCategories.map((category) =>
                    collectionMetadataReady ? (
                      <TouchableOpacity
                        key={category}
                        accessibilityRole="button"
                        style={[styles.quickButton, { backgroundColor: theme.accentSoft }]}
                        onPress={() => setCollectionEditorCategory(category)}
                      >
                        <Text style={{ color: theme.accent }}>Add {category} to collection</Text>
                      </TouchableOpacity>
                    ) : null
                  )}
                  <TouchableOpacity accessibilityRole="button" style={[styles.quickButton, { backgroundColor: theme.accentSoft }]} onPress={shareSelectedFiles}>
                    <Text style={{ color: theme.accent }}>Share</Text>
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" style={[styles.quickButton, { backgroundColor: theme.dangerSoft }]} onPress={handleBulkDelete}>
                    <Text style={{ color: theme.danger }}>{activeStorage === 'authorized' ? 'Delete permanently' : 'Delete'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <View style={styles.toolRow}>
              <TouchableOpacity accessibilityRole="button" onPress={() => {
                if (categoryFilter) {
                  setCategoryFilter(null);
                  setSelectedCollection(null);
                  setCurrentPath(APP_STORAGE);
                }
                setPromptValue('');
                setPromptTarget({ type: 'folder' });
              }} style={[styles.toolButton, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <Text style={{ color: theme.text }}>+ Folder</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" onPress={importDocuments} style={[styles.toolButton, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <Text style={{ color: theme.text }}>Import</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Sort by ${sortMode}. Tap to change sort.`}
                onPress={() => setSortMode((current) => {
                  const options = ['name', 'date', 'size', 'type'];
                  return options[(options.indexOf(current) + 1) % options.length];
                })}
                style={[styles.toolButton, { backgroundColor: theme.card, borderColor: theme.border }]}
              >
                <Text style={{ color: theme.text }}>Sort: {sortMode}</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" onPress={() => setViewMode((prev) => (prev === 'list' ? 'grid' : 'list'))} style={[styles.toolButton, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <Text style={{ color: theme.text }}>{viewMode === 'list' ? 'Grid' : 'List'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
              accessibilityLabel={allCurrentEntriesSelected ? 'Clear visible selection' : 'Select all visible items'}
              onPress={() => setSelectedIds((current) =>
                allCurrentEntriesSelected
                  ? current.filter((id) => !currentEntries.some((item) => item.id === id))
                  : [...new Set([...current, ...currentEntries.map((item) => item.id)])]
                )}
                style={[styles.toolButton, { backgroundColor: theme.card, borderColor: theme.border }]}
              >
              <Text style={{ color: theme.text }}>{allCurrentEntriesSelected ? 'Clear visible' : 'Select all'}</Text>
              </TouchableOpacity>
            </View>

            {error ? <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text> : null}

            {isLoading ? (
              <Text style={[styles.loadingText, { color: theme.muted }]}>Loading ...</Text>
            ) : (
              <FlatList
                key={viewMode}
                data={currentEntries}
                keyExtractor={(item) => item.uri}
                renderItem={renderBrowseItem}
                contentContainerStyle={styles.listContainer}
                numColumns={viewMode === 'grid' ? 2 : 1}
                columnWrapperStyle={viewMode === 'grid' ? styles.gridRow : undefined}
                ListEmptyComponent={
                  <View style={styles.emptyState}>
                    <Text style={[styles.emptyTitle, { color: theme.text }]}>
                      {error
                        ? 'Folder unavailable'
                        : search || categoryFilter
                          ? 'No matching files'
                          : 'Nothing here yet'}
                    </Text>
                    <Text style={[styles.emptyLabel, { color: theme.muted }]}>
                      {error ||
                        (search
                          ? 'Try another name or clear the search.'
                          : categoryFilter
                            ? 'Try a different folder or clear the category filter.'
                            : 'Import a file or create a folder to get started.')}
                    </Text>
                    {!error && activeStorage === 'app' ? (
                      <TouchableOpacity accessibilityRole="button" onPress={importDocuments} style={[styles.primaryButton, { backgroundColor: theme.accent }]}>
                        <Text style={styles.primaryButtonText}>Import a file</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                }
              />
            )}
          </View>
        )}

        {activeTab === 'trash' && (
          <ScrollView contentContainerStyle={styles.contentPad}>
            <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <View style={styles.sectionHeading}>
                <View style={styles.listInfo}>
                  <Text style={[styles.cardTitle, { color: theme.text }]}>Recycle bin</Text>
                  <Text style={[styles.itemMeta, { color: theme.muted }]}>
                    {search ? `${visibleTrashEntries.length} matching · ` : ''}{trashEntries.length} item(s) · local only
                  </Text>
                </View>
                {visibleTrashEntries.length > 0 ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => {
                      const allSelected = visibleTrashEntries.every((entry) => selectedTrashIds.includes(entry.id));
                      setSelectedTrashIds((current) =>
                        allSelected
                          ? current.filter((id) => !visibleTrashEntries.some((entry) => entry.id === id))
                          : [...new Set([...current, ...visibleTrashEntries.map((entry) => entry.id)])]
                      );
                    }}
                  >
                    <Text style={{ color: theme.accent, fontWeight: '600' }}>
                      {visibleTrashEntries.every((entry) => selectedTrashIds.includes(entry.id)) ? 'Clear visible' : 'Select all'}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {trashError ? <Text style={[styles.errorText, { color: theme.danger }]}>{trashError}</Text> : null}
              {selectedVisibleTrashEntries.length ? (
                <View style={[styles.selectionBar, { backgroundColor: theme.cardAlt, borderColor: theme.border }]}>
                  <Text style={[styles.selectionText, { color: theme.text }]}>{selectedVisibleTrashEntries.length} selected</Text>
                  <View style={styles.selectionActions}>
                    <TouchableOpacity accessibilityRole="button" onPress={() => confirmTrashBatch('restore', selectedVisibleTrashEntries.map((entry) => entry.id))} style={[styles.quickButton, { backgroundColor: theme.accentSoft }]}>
                      <Text style={{ color: theme.accent }}>Restore</Text>
                    </TouchableOpacity>
                    <TouchableOpacity accessibilityRole="button" onPress={() => confirmTrashBatch('delete', selectedVisibleTrashEntries.map((entry) => entry.id))} style={[styles.quickButton, { backgroundColor: theme.dangerSoft }]}>
                      <Text style={{ color: theme.danger }}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
              {visibleTrashEntries.length ? (
                visibleTrashEntries.map((entry) => (
                  <View key={entry.id} style={[styles.trashRow, { borderColor: theme.border, backgroundColor: selectedTrashIds.includes(entry.id) ? theme.accentSoft : theme.cardAlt }]}>
                    <View style={styles.listInfo}>
                      <Text style={[styles.itemName, { color: theme.text }]}>{entry.name}</Text>
                      <Text style={[styles.itemMeta, { color: theme.muted }]}>
                        {entry.state === 'missing' ? 'Missing from both its original and recycle-bin locations' : `Deleted ${formatDate(entry.movedAt)}`}
                      </Text>
                      <Text numberOfLines={1} style={[styles.itemMeta, { color: theme.muted }]}>Original location: {entry.originalUri}</Text>
                    </View>
                    <View style={styles.selectionActions}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Restore ${entry.name}`}
                        disabled={entry.state === 'missing'}
                        onPress={() => restoreTrashEntry(entry)}
                        style={[styles.quickButton, { backgroundColor: theme.accentSoft, opacity: entry.state === 'missing' ? 0.5 : 1 }]}
                      >
                        <Text style={{ color: theme.accent }}>Restore</Text>
                      </TouchableOpacity>
                      <TouchableOpacity accessibilityRole="button" onPress={() => handleDelete({ ...entry, isTrashEntry: true })} style={[styles.quickButton, { backgroundColor: theme.dangerSoft }]}>
                        <Text style={{ color: theme.danger }}>Delete</Text>
                      </TouchableOpacity>
                      <TouchableOpacity accessibilityRole="button" onPress={() => toggleTrashSelection(entry.id)} style={[styles.quickButton, { backgroundColor: theme.card }]}>
                        <Text style={{ color: theme.text }}>{selectedTrashIds.includes(entry.id) ? 'Selected' : 'Select'}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              ) : (
                <View style={styles.emptyState}>
                  <Text style={[styles.emptyTitle, { color: theme.text }]}>
                    {trashError ? 'Recycle bin unavailable' : search ? 'No matching items' : 'Your recycle bin is empty'}
                  </Text>
                  <Text style={[styles.emptyLabel, { color: theme.muted }]}>
                    {trashError || (search ? 'Try another name or clear the search.' : 'Items moved to trash from app storage will appear here.')}
                  </Text>
                </View>
              )}
              {trashEntries.length ? (
                <TouchableOpacity accessibilityRole="button" onPress={() => confirmTrashBatch('delete', trashEntries.map((entry) => entry.id))} style={[styles.destructiveOutline, { borderColor: theme.danger }]}>
                  <Text style={{ color: theme.danger, fontWeight: '600' }}>Empty recycle bin</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </ScrollView>
        )}

        {activeTab === 'cloud' && (
          <ScrollView contentContainerStyle={styles.contentPad}>
            <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <View style={styles.sectionHeading}>
                <View style={styles.listInfo}>
                  <Text style={[styles.cardTitle, { color: theme.text }]}>Your cloud files</Text>
                  <Text style={[styles.itemMeta, { color: theme.muted }]}>{cloudStatus}</Text>
                </View>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Refresh cloud files" disabled={cloudBusy} onPress={refreshCloudFiles} style={[styles.outlineButton, { borderColor: theme.border, opacity: cloudBusy ? 0.6 : 1 }]}>
                  <Text style={{ color: theme.text }}>{cloudBusy ? 'Working' : 'Refresh'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={[styles.bodyCopy, { color: theme.muted }]}>
                Upload, download, and remove files manually. Cloud files are private to your account; this app does not automatically synchronize local folders.
              </Text>
              {cloudError ? <Text style={[styles.errorText, { color: theme.danger }]}>{cloudError}</Text> : null}
              <View style={styles.quickActions}>
                <TouchableOpacity accessibilityRole="button" disabled={cloudBusy} onPress={connectCloud} style={[styles.primaryButton, { backgroundColor: theme.accent, flex: 1, opacity: cloudBusy ? 0.6 : 1 }]}>
                  <Text style={styles.primaryButtonText}>{cloudBusy ? 'Connecting…' : 'Connect cloud'}</Text>
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" disabled={cloudBusy} onPress={uploadCloudFile} style={[styles.outlineButton, { borderColor: theme.border, flex: 1, opacity: cloudBusy ? 0.6 : 1 }]}>
                  <Text style={{ color: theme.text }}>Upload file</Text>
                </TouchableOpacity>
              </View>
              {visibleCloudFiles.length ? (
                visibleCloudFiles.map((record) => (
                    <View key={record.id} style={[styles.cloudFileRow, { borderColor: theme.border }]}>
                      <View style={styles.listInfo}>
                        <Text numberOfLines={1} style={[styles.itemName, { color: theme.text }]}>{record.filename}</Text>
                        <Text style={[styles.itemMeta, { color: theme.muted }]}>
                          {formatBytes(Number(record.file_size))} · {record.mime_type || 'File'} · {formatDate(record.updated_at)}
                        </Text>
                      </View>
                      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Download ${record.filename}`} disabled={cloudBusy} onPress={() => downloadCloudFile(record)} style={[styles.smallAction, { backgroundColor: theme.accentSoft }]}>
                        <Text style={[styles.actionGlyph, { color: theme.accent }]}>↓</Text>
                      </TouchableOpacity>
                      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete cloud file ${record.filename}`} disabled={cloudBusy} onPress={() => confirmDeleteCloudFile(record)} style={[styles.smallAction, { backgroundColor: theme.dangerSoft }]}>
                        <Text style={[styles.actionGlyph, { color: theme.danger }]}>D</Text>
                      </TouchableOpacity>
                    </View>
                  ))
              ) : (
                <View style={styles.emptyState}>
                  <Text style={[styles.emptyTitle, { color: theme.text }]}>
                    {cloudError ? 'Cloud list unavailable' : search ? 'No matching cloud files' : 'No cloud files yet'}
                  </Text>
                  <Text style={[styles.emptyLabel, { color: theme.muted }]}>
                    {cloudError
                      ? 'Check the connection and retry. Local files remain available.'
                      : search
                        ? 'Try another search or clear the search field.'
                        : 'Connect to your cloud account, then upload a file.'}
                  </Text>
                </View>
              )}
            </View>
          </ScrollView>
        )}

        {activeTab === 'categories' && (
          <ScrollView contentContainerStyle={styles.contentPad}>
            {collectionMetadataError ? (
              <Text style={[styles.errorText, { color: theme.danger }]}>{collectionMetadataError}</Text>
            ) : null}
            {collectionMetadataNotice ? (
              <Text style={[styles.itemMeta, { color: theme.muted, marginBottom: 8 }]}>{collectionMetadataNotice}</Text>
            ) : null}
            {collectionCategory ? (
              <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <View style={styles.sectionHeading}>
                  <Text style={[styles.cardTitle, { color: theme.text }]}>
                    {CATEGORY_CONFIG.find((item) => item.key === collectionCategory)?.label} collections
                  </Text>
                  <TouchableOpacity accessibilityRole="button" onPress={() => setCollectionCategory(null)}>
                    <Text style={{ color: theme.accent }}>All types</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  accessibilityRole="button"
                  style={[styles.outlineButton, { borderColor: theme.border, marginBottom: 12 }]}
                  onPress={() => {
                    setSearch('');
                    setActiveStorage('app');
                    setCurrentPath(APP_STORAGE);
                    setCategoryFilter(collectionCategory);
                    setSelectedCollection(null);
                    setSelectedIds([]);
                    setActiveTab('browse');
                  }}
                >
                  <Text style={{ color: theme.text }}>Browse all {CATEGORY_CONFIG.find((item) => item.key === collectionCategory)?.label}</Text>
                </TouchableOpacity>
                {visibleCollections.map((name) => {
                  const count = allLocalFiles.filter(
                    (file) =>
                      fileCategoryKey(file) === collectionCategory &&
                      collectionMetadata.assignments[file.uri]?.[collectionCategory]?.includes(name)
                  ).length;
                  return (
                    <TouchableOpacity
                      key={name}
                      accessibilityRole="button"
                      accessibilityLabel={`${name}, ${count} files`}
                      style={[styles.recentItem, { borderBottomColor: theme.border }]}
                      onPress={() => {
                        setSearch('');
                        setActiveStorage('app');
                        setCurrentPath(APP_STORAGE);
                        setCategoryFilter(collectionCategory);
                        setSelectedCollection(name);
                        setSelectedIds([]);
                        setActiveTab('browse');
                      }}
                    >
                      <Text style={[styles.recentMark, { color: theme.accent, backgroundColor: theme.accentSoft }]}>
                        {CATEGORY_CONFIG.find((item) => item.key === collectionCategory)?.icon || '📦'}
                      </Text>
                      <View style={styles.listInfo}>
                        <Text style={[styles.itemName, { color: theme.text }]}>{name}</Text>
                        <Text style={[styles.itemMeta, { color: theme.muted }]}>{count} files</Text>
                      </View>
                      <Text style={{ color: theme.accent }}>›</Text>
                    </TouchableOpacity>
                  );
                })}
                {DEFAULT_COLLECTIONS[collectionCategory] && !visibleCollections.length ? (
                  <Text style={[styles.emptyLabel, { color: theme.muted }]}>No collection matches this search.</Text>
                ) : null}
                {!DEFAULT_COLLECTIONS[collectionCategory] ? (
                  <Text style={[styles.emptyLabel, { color: theme.muted }]}>
                    Collections are available for images, videos, and documents. Other file types remain browsable above.
                  </Text>
                ) : null}
              </View>
            ) : (
              <>
                <Text style={[styles.bodyCopy, { color: theme.muted }]}>
                  Browse supported file types across Best’s private files and organize images, videos, and documents into collections.
                </Text>
                <Text style={[styles.itemMeta, { color: theme.muted, marginBottom: 12 }]}>
                  Downloads identifies temporary download-file extensions only; Best cannot infer a file’s original device Downloads folder.
                </Text>
                <View style={styles.categoryGrid}>
                  {visibleCategories.map((category) => {
                    const count =
                      categorySummary.find((item) => item.key === category.key)?.count || 0;
                    return (
                      <TouchableOpacity
                        key={category.key}
                        accessibilityRole="button"
                        accessibilityLabel={`${category.label}, ${count} items`}
                        onPress={() => {
                          setSearch('');
                          setCollectionCategory(category.key);
                        }}
                        style={[styles.categoryCard, { backgroundColor: theme.card, borderColor: theme.border }]}
                      >
                        <Text style={[styles.categoryMark, { color: theme.accent, backgroundColor: theme.accentSoft }]}>{category.icon}</Text>
                        <Text style={[styles.categoryTitle, { color: theme.text }]}>{category.label}</Text>
                        <Text style={{ color: theme.muted }}>{count} files</Text>
                      </TouchableOpacity>
                    );
                  })}
                  {!visibleCategories.length ? (
                    <View style={[styles.emptyState, { width: '100%' }]}>
                      <Text style={[styles.emptyTitle, { color: theme.text }]}>No matching categories</Text>
                      <Text style={[styles.emptyLabel, { color: theme.muted }]}>Try another search or clear the search field.</Text>
                    </View>
                  ) : null}
                </View>
              </>
            )}
          </ScrollView>
        )}

        {activeTab === 'recent' && (
          <ScrollView contentContainerStyle={styles.contentPad}>
            <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Recently modified files</Text>
              <Text style={[styles.bodyCopy, { color: theme.muted }]}>Recent Best-managed files from all app folders, ordered by their available modification time.</Text>
              {visibleRecentFiles.length ? (
                visibleRecentFiles.map((file) => (
                  <TouchableOpacity key={file.id} accessibilityRole="button" onPress={() => canPreviewImage(file) ? previewImage(file) : handleOpenFile(file)} style={[styles.recentItem, { borderBottomColor: theme.border }]}>
                    <Text style={[styles.recentMark, { color: theme.accent, backgroundColor: theme.accentSoft }]}>{fileIconForItem(file)}</Text>
                    <View style={styles.listInfo}>
                      <Text style={[styles.itemName, { color: theme.text }]}>{file.name}</Text>
                      <Text style={[styles.itemMeta, { color: theme.muted }]}>{formatDate(file.modifiedAt)} · {formatBytes(file.size)}</Text>
                    </View>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={[styles.emptyLabel, { color: theme.muted }]}>No recent files match this search.</Text>
              )}
            </View>
          </ScrollView>
        )}

        {activeTab === 'settings' && (
          <ScrollView contentContainerStyle={styles.contentPad}>
            <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Appearance</Text>
              <View style={styles.settingRow}>
                <View style={styles.listInfo}>
                  <Text style={[styles.itemName, { color: theme.text }]}>Theme</Text>
                  <Text style={[styles.itemMeta, { color: theme.muted }]}>{darkMode ? 'Dark' : 'Light'}</Text>
                </View>
                <TouchableOpacity accessibilityRole="switch" accessibilityState={{ checked: darkMode }} accessibilityLabel="Dark theme" onPress={() => setDarkMode((value) => !value)} style={[styles.outlineButton, { borderColor: theme.border }]}>
                  <Text style={{ color: theme.text }}>Use {darkMode ? 'light' : 'dark'}</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>App lock</Text>
              <Text style={[styles.bodyCopy, { color: theme.muted }]}>
                {securityConfig.enabled
                  ? 'PocketFiles locks on launch and whenever it returns from the background. Choose a password, pattern, or device biometric to unlock.'
                  : 'Set a password or pattern, and optionally enable fingerprint or another device biometric.'}
              </Text>
              {SECURITY_CREDENTIAL_OPTIONS.map((option) => {
                const active = securityConfig.credentialType === option.type;
                return (
                  <View key={option.type} style={[styles.settingRow, styles.securitySettingRow]}>
                    <View style={styles.listInfo}>
                      <Text style={[styles.itemName, { color: theme.text }]}>{option.label}</Text>
                      <Text style={[styles.itemMeta, { color: theme.muted }]}>
                        {active ? 'Enabled as an app unlock method' : option.details}
                      </Text>
                    </View>
                    <View style={styles.securityActions}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`${active ? 'Change' : 'Set'} app lock ${option.label.toLowerCase()}`}
                        disabled={securityBusy}
                        onPress={() => void openCredentialSetup(option.type)}
                        style={[styles.outlineButton, { borderColor: theme.border, opacity: securityBusy ? 0.6 : 1 }]}
                      >
                        <Text style={{ color: theme.text }}>{active ? 'Change' : 'Set'}</Text>
                      </TouchableOpacity>
                      {active && (
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`Remove app lock ${option.label.toLowerCase()}`}
                          disabled={securityBusy}
                          onPress={() => void openCredentialSetup(option.type, 'remove')}
                          style={[styles.outlineButton, styles.securityRemoveButton, {
                            borderColor: theme.danger,
                            opacity: securityBusy ? 0.6 : 1,
                          }]}
                        >
                          <Text style={{ color: theme.danger }}>Remove</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}
              {Platform.OS !== 'web' && (
                <View style={[styles.settingRow, styles.securitySettingRow]}>
                  <View style={styles.listInfo}>
                    <Text style={[styles.itemName, { color: theme.text }]}>Fingerprint / biometrics</Text>
                    <Text style={[styles.itemMeta, { color: theme.muted }]}>
                      {biometricAvailable
                        ? 'Use a fingerprint or face enrolled on this device'
                        : biometricCheckError || 'No enrolled biometric is currently available'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    accessibilityRole="switch"
                    accessibilityLabel="Biometric app lock"
                    accessibilityState={{
                      checked: securityConfig.biometricEnabled,
                      disabled: securityBusy || (!securityConfig.biometricEnabled && !biometricAvailable),
                    }}
                    disabled={securityBusy || (!securityConfig.biometricEnabled && !biometricAvailable)}
                    onPress={() => void updateBiometricUnlock(!securityConfig.biometricEnabled)}
                    style={[
                      styles.outlineButton,
                      {
                        borderColor: theme.border,
                        opacity: securityBusy || (!securityConfig.biometricEnabled && !biometricAvailable) ? 0.55 : 1,
                      },
                    ]}
                  >
                    <Text style={{ color: theme.text }}>
                      {securityConfig.biometricEnabled ? 'On' : 'Off'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
              {Platform.OS !== 'web' && securityConfig.biometricEnabled && (
                <Text style={[styles.itemMeta, styles.securityNote, { color: theme.muted }]}>
                  The device may offer its own screen-lock method as a system fallback. PocketFiles does not save your device credential.
                </Text>
              )}
              {Platform.OS === 'web' && (
                <Text style={[styles.itemMeta, styles.securityNote, { color: theme.muted }]}>
                  Password and pattern locks work on web. Fingerprint unlock is available in the Android and iOS app.
                </Text>
              )}
              {!!securityMessage && (
                <Text accessibilityRole="alert" style={[styles.errorText, { color: theme.danger }]}>
                  {securityMessage}
                </Text>
              )}
              <Text style={[styles.itemMeta, styles.securityNote, { color: theme.muted }]}>
                App lock is an access gate, not file encryption. Files can still be accessed through the device or cloud account outside this screen.
              </Text>
            </View>
            <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Storage</Text>
              {storageInfo ? (
                <>
                  <Text style={[styles.bodyCopy, { color: theme.muted }]}>Device internal storage · {formatBytes(storageInfo.used)} used of {formatBytes(storageInfo.total)}</Text>
                  <Text style={[styles.bodyCopy, { color: theme.muted }]}>{formatBytes(storageInfo.free)} available</Text>
                  <Text style={[styles.bodyCopy, { color: theme.muted }]}>This is the internal data partition shared by Android and all apps, not Best’s private app-folder usage.</Text>
                </>
              ) : <Text style={[styles.bodyCopy, { color: theme.muted }]}>Device internal storage information is unavailable.</Text>}
              <Text style={[styles.bodyCopy, { color: theme.muted }]}>Best-managed files are stored in the app’s private directory. Authorized folders remain under the Android provider’s control.</Text>
            </View>
            <TouchableOpacity accessibilityRole="button" onPress={() => setActiveTab('cloud')} style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Cloud connection</Text>
              <Text style={[styles.bodyCopy, { color: theme.muted }]}>{cloudStatus}</Text>
              <Text style={{ color: theme.accent, fontWeight: '600' }}>Manage cloud files</Text>
            </TouchableOpacity>
            <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Privacy & app information</Text>
              <Text style={[styles.bodyCopy, { color: theme.muted }]}>
                Files remain local unless you explicitly upload them. Optional cloud files are stored in a private Supabase bucket and scoped to this app’s anonymous cloud session. The app lock does not encrypt stored files.
              </Text>
              <View style={styles.infoBlock}>
                <Text style={{ color: theme.muted }}>Best · version 1.0.0</Text>
                <Text style={{ color: theme.muted }}>Android package · com.pocketfiles.app</Text>
                <Text style={{ color: theme.muted }}>Cloud file access · manual operations only</Text>
              </View>
            </View>
          </ScrollView>
        )}

        <View style={[styles.bottomBar, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {['home', 'browse', 'cloud', 'trash', 'settings'].map((tab) => (
            <TouchableOpacity
              key={tab}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === tab }}
              accessibilityLabel={tab === 'home' ? 'Home' : tab === 'browse' ? 'Files' : tab === 'trash' ? 'Recycle bin' : tab === 'cloud' ? 'Cloud files' : 'Settings'}
              onPress={() => (tab === 'browse' ? openAppStorage() : setActiveTab(tab))}
              style={[styles.tabButton, { backgroundColor: activeTab === tab ? theme.accentSoft : 'transparent' }]}
            >
              <Text style={[styles.tabMark, { color: activeTab === tab ? theme.accent : theme.muted }]}>
                {tab === 'home' ? '⌂' : tab === 'browse' ? '▤' : tab === 'cloud' ? '☁' : tab === 'trash' ? '▣' : '⚙'}
              </Text>
              <Text style={[styles.tabText, { color: activeTab === tab ? theme.accent : theme.muted }]}>
                {tab === 'home' ? 'Home' : tab === 'browse' ? 'Files' : tab === 'trash' ? 'Trash' : tab === 'cloud' ? 'Cloud' : 'Settings'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {collectionEditorCategory && (
          <View style={styles.modalOverlay}>
            <View style={[styles.modalBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Organize selected files</Text>
              <Text style={[styles.bodyCopy, { color: theme.muted }]}>
                Choose a {collectionEditorCategory} collection. Files already in it are removed only when every selected file is assigned.
              </Text>
              {(DEFAULT_COLLECTIONS[collectionEditorCategory] || []).map((name) => {
                const assignedCount = selectedCollectionEntries.filter((item) =>
                  collectionMetadata.assignments[item.uri]?.[collectionEditorCategory]?.includes(name)
                ).length;
                return (
                  <TouchableOpacity
                    key={name}
                    accessibilityRole="button"
                    accessibilityLabel={`${name}, ${assignedCount} of ${selectedCollectionEntries.length} selected files assigned`}
                    style={[styles.collectionOption, { backgroundColor: theme.cardAlt, borderColor: theme.border }]}
                    disabled={collectionSaving}
                    onPress={() => toggleCollectionForSelection(name)}
                  >
                    <Text style={[styles.itemName, { color: theme.text }]}>{name}</Text>
                    <Text style={[styles.itemMeta, { color: theme.muted }]}>
                      {assignedCount} of {selectedCollectionEntries.length} assigned
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.secondaryButton, { backgroundColor: theme.cardAlt, marginTop: 8 }]}
                disabled={collectionSaving}
                onPress={() => setCollectionEditorCategory(null)}
              >
                <Text style={{ color: theme.text }}>{collectionSaving ? 'Saving…' : 'Cancel'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {imagePreview && (
          <View style={styles.previewOverlay}>
            <View style={[styles.previewBox, { backgroundColor: theme.card }]}>
              <Text numberOfLines={1} style={[styles.itemName, { color: theme.text }]}>{imagePreview.name}</Text>
              {imagePreviewError ? (
                <Text style={[styles.emptyLabel, { color: theme.muted }]}>{imagePreviewError}</Text>
              ) : (
                <Image
                  source={{ uri: imagePreview.uri }}
                  resizeMode="contain"
                  accessibilityLabel={`Preview of ${imagePreview.name}`}
                  style={styles.previewImage}
                  onError={() => setImagePreviewError('Best could not render this image preview. You can still try opening it with another app.')}
                />
              )}
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.secondaryButton, { backgroundColor: theme.cardAlt }]}
                  onPress={() => setImagePreview(null)}
                >
                  <Text style={{ color: theme.text }}>Close</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryButton, { backgroundColor: theme.accent }]}
                  onPress={() => { const file = imagePreview; setImagePreview(null); void handleOpenFile(file); }}
                >
                  <Text style={styles.primaryButtonText}>Open with app</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {promptTarget && (
          <View style={styles.modalOverlay}>
            <View style={[styles.modalBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>{promptTarget.type === 'folder' ? 'Create folder' : 'Rename item'}</Text>
              <TextInput
                value={promptValue}
                onChangeText={setPromptValue}
                placeholder={promptTarget.type === 'folder' ? 'Folder name' : 'New name'}
                style={[styles.modalInput, { backgroundColor: theme.cardAlt, color: theme.text, borderColor: theme.border }]}
              />
              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: theme.cardAlt }]} onPress={() => {
                  setPromptTarget(null);
                  setPromptValue('');
                }}>
                  <Text style={{ color: theme.text }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryButton, { backgroundColor: theme.accent }]}
                  onPress={async () => {
                    if (promptTarget.type === 'folder') {
                      const folderName = promptValue.trim();
                      if (!folderName) return;
                      try {
                        if (activeStorage === 'authorized') {
                          await createAuthorizedFolder(
                            FileSystem.StorageAccessFramework,
                            currentPath,
                            folderName,
                            entries
                          );
                        } else {
                          await createLocalFolder(FileSystem, currentPath, folderName);
                        }
                        setPromptTarget(null);
                        setPromptValue('');
                        await readDirectory(currentPath);
                      } catch (error) {
                        Alert.alert('Folder creation failed', error.message || 'Could not create the folder.');
                      }
                    } else {
                      await renameItem(promptTarget.item, promptValue);
                      setPromptTarget(null);
                      setPromptValue('');
                    }
                  }}
                >
                  <Text style={styles.primaryButtonText}>{promptTarget.type === 'folder' ? 'Create' : 'Rename'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
        {securitySetupStep && (
          <View style={styles.modalOverlay}>
            <View style={[styles.modalBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>
                {securitySetupAction === 'remove'
                  ? `Remove app ${securityCredentialType}?`
                  : securitySetupStep === 'current'
                    ? `Verify current ${securityConfig.credentialType}`
                    : securitySetupStep === 'confirm'
                      ? `Confirm new ${securityCredentialType}`
                      : `Set app ${securityCredentialType}`}
              </Text>
              <Text style={[styles.bodyCopy, { color: theme.muted }]}>
                {securitySetupStep === 'current'
                  ? 'Enter your current app lock to continue.'
                  : securitySetupAction === 'remove'
                    ? 'Your biometric lock will remain enabled if it is turned on.'
                    : securitySetupStep === 'confirm'
                      ? `Enter the new ${securityCredentialType} one more time.`
                      : securityCredentialType === 'password'
                        ? 'Use 8 to 64 characters. Avoid reusing an important account password.'
                        : 'Tap at least four different dots in the order you want to unlock.'}
              </Text>
              {(securitySetupStep === 'current'
                ? securityConfig.credentialType
                : securityCredentialType) === 'pattern'
                ? renderPatternInput()
                : (
                  <TextInput
                    accessibilityLabel={`${
                      securitySetupStep === 'current' ? 'Current' : 'New'
                    } app ${securitySetupStep === 'current'
                      ? securityConfig.credentialType
                      : securityCredentialType}`}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!securityBusy && !(securitySetupStep === 'current' && lockoutRemaining > 0)}
                    maxLength={64}
                    onChangeText={(value) => updateSecurityInput(
                      value,
                      securitySetupStep === 'current'
                        ? securityConfig.credentialType
                        : securityCredentialType
                    )}
                    onSubmitEditing={() => void submitSecurityCredential()}
                    placeholder={`App ${
                      securitySetupStep === 'current'
                        ? securityConfig.credentialType
                        : securityCredentialType
                    }`}
                    placeholderTextColor={theme.muted}
                    returnKeyType="go"
                    secureTextEntry
                    style={[styles.modalInput, {
                      backgroundColor: theme.cardAlt,
                      color: theme.text,
                      borderColor: theme.border,
                    }]}
                    value={securityInput}
                  />
                )}
              {!!securityMessage && (
                <Text accessibilityRole="alert" style={[styles.errorText, { color: theme.danger }]}>
                  {securityMessage}
                </Text>
              )}
              {securitySetupStep === 'current' &&
                securityConfig.biometricEnabled &&
                Platform.OS !== 'web' && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={securityBusy}
                    onPress={async () => {
                      if (securityBusy) return;
                      setSecurityBusy(true);
                      setSecurityMessage('');
                      try {
                        await authenticateBiometric('Verify to change app lock');
                        if (securitySetupAction === 'remove') {
                          const settings = await appSecurity.removeCredential();
                          setSecurityConfig(settings);
                          if (!settings.enabled) setIsLocked(false);
                          clearSecurityFlow();
                        } else {
                          setSecurityInput('');
                          setSecuritySetupStep('new');
                        }
                      } catch (error) {
                        setSecurityMessage(error?.message || 'Biometric authentication failed.');
                      } finally {
                        setSecurityBusy(false);
                      }
                    }}
                    style={[styles.secondaryButton, { backgroundColor: theme.cardAlt, marginBottom: 10 }]}
                  >
                    <Text style={{ color: theme.text }}>Verify with fingerprint / face</Text>
                  </TouchableOpacity>
                )}
              <View style={styles.modalActions}>
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={securityBusy}
                  onPress={clearSecurityFlow}
                  style={[styles.secondaryButton, { backgroundColor: theme.cardAlt }]}
                >
                  <Text style={{ color: theme.text }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={
                    securityBusy ||
                    (securitySetupStep === 'current' && lockoutRemaining > 0)
                  }
                  onPress={() => void submitSecurityCredential()}
                  style={[styles.primaryButton, {
                    backgroundColor: theme.accent,
                    opacity: securityBusy ||
                      (securitySetupStep === 'current' && lockoutRemaining > 0) ? 0.6 : 1,
                  }]}
                >
                  <Text style={styles.primaryButtonText}>
                    {securityBusy
                      ? 'Please wait…'
                      : securitySetupAction === 'remove' &&
                          securitySetupStep === 'current'
                        ? 'Verify and remove'
                        : 'Continue'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  appShell: { flex: 1 },
  securityScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  securityTitle: { marginTop: 22, marginBottom: 8, textAlign: 'center' },
  securityCopy: { maxWidth: 360, textAlign: 'center', marginBottom: 18 },
  securityButton: { width: '100%', maxWidth: 360, marginBottom: 10 },
  securityMessage: { marginTop: 12, textAlign: 'center' },
  securityInput: {
    width: '100%',
    maxWidth: 360,
    minHeight: 56,
    textAlign: 'center',
    fontSize: 17,
  },
  patternEntry: { alignItems: 'center', width: '100%', marginBottom: 10 },
  patternGrid: {
    width: 220,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 12,
    marginVertical: 14,
  },
  patternDot: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  brandWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  brandMark: {
    width: 46,
    height: 46,
    borderRadius: 15,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#08734e',
    shadowOpacity: 0.16,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  brandMarkImage: {
    width: '100%',
    height: '100%',
    borderRadius: 14,
  },
  appTitle: { fontSize: 23, fontWeight: '800', letterSpacing: -0.5 },
  appSubtitle: { fontSize: 12, marginTop: 3, fontWeight: '500', maxWidth: 240 },
  toggleButton: {
    minWidth: 46,
    height: 42,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#173d2d',
    shadowOpacity: 0.06,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 18,
    height: 50,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 13,
    marginTop: 9,
    marginBottom: 9,
    shadowColor: '#174d37',
    shadowOpacity: 0.04,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  searchGlyph: { fontSize: 25, fontWeight: '500', marginRight: 8, lineHeight: 29 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0, fontWeight: '500' },
  clearSearch: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 },
  contentPad: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 118 },
  browseScreen: { flex: 1 },
  heroCard: {
    borderWidth: 1,
    borderRadius: 23,
    padding: 19,
    marginBottom: 15,
    shadowColor: '#174d37',
    shadowOpacity: 0.07,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  cardTitle: { fontSize: 17, fontWeight: '800', marginBottom: 10, letterSpacing: -0.25 },
  cardEyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.4, marginBottom: 7 },
  storageUsed: { fontSize: 27, fontWeight: '800', marginBottom: 13, letterSpacing: -0.7 },
  storageBarContainer: {
    height: 9,
    borderRadius: 999,
    overflow: 'hidden',
  },
  storageBarFill: { height: '100%', borderRadius: 999 },
  storageDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 11,
    fontSize: 12,
    fontWeight: '600',
  },
  cloudPromo: {
    minHeight: 90,
    borderRadius: 21,
    borderWidth: 1,
    padding: 17,
    marginBottom: 23,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#174d37',
    shadowOpacity: 0.13,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  cloudPromoCopy: { flex: 1, paddingRight: 10 },
  cloudPromoTitle: { color: '#ffffff', fontSize: 16, fontWeight: '800' },
  cloudPromoMeta: { color: '#d5dfed', fontSize: 12, marginTop: 5, lineHeight: 17 },
  cloudPromoAction: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 9,
  },
  filterNotice: {
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: '#e8efff',
    paddingHorizontal: 12,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  fileUsageCard: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 96,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderRadius: 19,
  },
  fileUsageIcon: {
    width: 48,
    height: 48,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 13,
  },
  fileUsageTotal: { fontSize: 23, fontWeight: '800', marginTop: 3 },
  categoryCard: {
    width: '48.3%',
    minHeight: 126,
    padding: 14,
    borderRadius: 19,
    borderWidth: 1,
    marginBottom: 10,
    shadowColor: '#174d37',
    shadowOpacity: 0.035,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  categoryMark: {
    width: 43,
    height: 43,
    borderRadius: 14,
    textAlign: 'center',
    textAlignVertical: 'center',
    overflow: 'hidden',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  categoryTitle: { marginTop: 9, marginBottom: 3, fontWeight: '800', fontSize: 14 },
  sectionCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    marginBottom: 13,
    shadowColor: '#174d37',
    shadowOpacity: 0.035,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  recentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  recentMark: {
    minWidth: 44,
    height: 42,
    borderRadius: 13,
    overflow: 'hidden',
    textAlign: 'center',
    textAlignVertical: 'center',
    fontSize: 23,
    fontWeight: '800',
    marginRight: 12,
    paddingHorizontal: 5,
  },
  quickActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickButton: {
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 13,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#174d37',
    shadowOpacity: 0.025,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  browseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 16,
    marginBottom: 10,
    overflow: 'hidden',
    shadowColor: '#174d37',
    shadowOpacity: 0.035,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  breadcrumbButton: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  breadcrumbBar: { flex: 1, paddingHorizontal: 8 },
  breadcrumb: { fontSize: 13, fontWeight: '600', paddingVertical: 8 },
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 15,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  selectionText: { fontWeight: '700' },
  selectionActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  toolRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 10,
    gap: 7,
  },
  toolButton: {
    borderWidth: 1,
    borderRadius: 14,
    minHeight: 46,
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    shadowColor: '#000000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  listContainer: { paddingBottom: 20, flexGrow: 1 },
  gridRow: { justifyContent: 'space-between' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 17,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 7,
    minHeight: 76,
    shadowColor: '#174d37',
    shadowOpacity: 0.025,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  gridItem: {
    width: '48.5%',
    minHeight: 150,
    flexDirection: 'column',
    alignItems: 'flex-start',
    marginHorizontal: '0.5%',
    padding: 12,
  },
  fileGlyph: {
    width: 47,
    height: 47,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    borderWidth: 1,
  },
  fileThumbnail: {
    width: 47,
    height: 47,
    borderRadius: 15,
    marginRight: 12,
    backgroundColor: '#dce9e1',
  },
  gridThumbnail: {
    width: '100%',
    height: 106,
    marginRight: 0,
    marginBottom: 9,
  },
  fileGlyphText: { fontSize: 23 },
  listInfo: { flex: 1, minWidth: 0 },
  itemName: { fontSize: 14, fontWeight: '700', letterSpacing: -0.1 },
  itemMeta: { fontSize: 11, marginTop: 4, fontWeight: '500' },
  itemActions: { flexDirection: 'row', alignItems: 'center', marginLeft: 4 },
  smallAction: {
    width: 42,
    height: 42,
    borderRadius: 13,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
  },
  actionGlyph: { fontSize: 16, fontWeight: '800' },
  emptyState: { alignItems: 'center', paddingHorizontal: 20, paddingVertical: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', textAlign: 'center' },
  emptyLabel: { textAlign: 'center', paddingTop: 8, lineHeight: 20, fontSize: 13 },
  trashRow: {
    flexWrap: 'wrap',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 17,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 9,
  },
  cloudFileRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 13 },
  bodyCopy: { fontSize: 13, lineHeight: 20, marginBottom: 10 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  securitySettingRow: { marginTop: 16 },
  securityActions: { alignItems: 'flex-end', gap: 7, marginLeft: 8 },
  securityRemoveButton: { minHeight: 38 },
  securityNote: { marginTop: 10 },
  infoBlock: { marginTop: 14, gap: 6 },
  outlineButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  destructiveOutline: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 14, marginTop: 8 },
  primaryButton: {
    minHeight: 46,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    minHeight: 46,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: '#ffffff', fontWeight: '700' },
  bottomBar: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 22,
    paddingVertical: 7,
    paddingHorizontal: 5,
    elevation: 8,
    shadowColor: '#174d37',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
  },
  tabButton: { flex: 1, minHeight: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 16, paddingVertical: 5 },
  tabMark: { fontSize: 17, fontWeight: '800', lineHeight: 20 },
  tabText: { marginTop: 2, fontSize: 9, fontWeight: '700' },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalBox: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: 24,
    padding: 20,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 14,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginTop: 10,
    marginBottom: 12,
    fontSize: 15,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  collectionOption: {
    minHeight: 55,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: 9,
    justifyContent: 'center',
    marginBottom: 7,
  },
  previewOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    backgroundColor: 'rgba(5, 18, 12, 0.96)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 18,
  },
  previewBox: {
    width: '100%',
    height: '82%',
    maxWidth: 520,
    borderRadius: 22,
    padding: 14,
    justifyContent: 'space-between',
  },
  previewImage: { width: '100%', flex: 1, marginVertical: 12 },
  errorText: { fontWeight: '600', marginBottom: 12 },
  loadingText: { textAlign: 'center', marginTop: 20 },
});
