import { useCallback } from 'react';

/**
 * useIPC — Hook wrapper for all Electron IPC calls.
 * Provides safe access to window.aria with fallback handling.
 */
export default function useIPC() {
  const isAvailable = !!window.aria;

  const safeCall = useCallback(async (method, ...args) => {
    if (!window.aria || typeof window.aria[method] !== 'function') {
      console.warn(`[useIPC] Method ${method} not available`);
      return null;
    }
    try {
      return await window.aria[method](...args);
    } catch (err) {
      console.error(`[useIPC] ${method} failed:`, err);
      throw err;
    }
  }, []);

  return {
    isAvailable,
    getReminders: () => safeCall('getReminders'),
    getAllReminders: () => safeCall('getAllReminders'),
    addReminder: (text) => safeCall('addReminder', text),
    completeReminder: (id) => safeCall('completeReminder', id),
    getEmails: () => safeCall('getEmails'),
    refreshEmails: () => safeCall('refreshEmails'),
    getBriefing: () => safeCall('getBriefing'),
    chat: (message) => safeCall('chat', message),
    getSettings: () => safeCall('getSettings'),
    saveSetting: (key, val) => safeCall('saveSetting', key, val),
    getWeather: () => safeCall('getWeather'),
    getCalendarEvents: () => safeCall('getCalendarEvents'),
    getUsage: () => safeCall('getUsage'),
    saveApiKey: (key) => safeCall('saveApiKey', key),
    getApiKey: () => safeCall('getApiKey')
  };
}
